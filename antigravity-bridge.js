#!/usr/bin/env node
/**
 * antigravity-bridge.js — Claude Code → Antigravity Bridge CLI
 *
 * A zero-dependency Node.js script that lets Claude Code (or any external agent)
 * control the Antigravity IDE Agent through atomic sub-commands.
 *
 * Sub-commands:
 *   discover       — Find Antigravity process, extract port/CSRF/OAuth
 *   start-cascade  — Create a new chat session (cascade)
 *   send-and-wait  — Send a message and wait for agent completion
 *   send           — Send a message (fire-and-forget)
 *   poll           — Poll cascade trajectory once
 *   cancel         — Cancel running cascade invocation
 *   delete         — Delete a cascade trajectory
 *   models         — List available models
 *
 * Usage:
 *   node antigravity-bridge.js discover [--workspace /path]
 *   node antigravity-bridge.js start-cascade [--mode Planning]
 *   node antigravity-bridge.js send-and-wait --cascade <id> --message "..."
 *   node antigravity-bridge.js delete --cascade <id>
 *
 * All output is JSON for easy parsing by Claude Code.
 */

"use strict";

const http2 = require("http2");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { exec, execFile } = require("child_process");
const { promisify } = require("util");

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const CACHE_FILE = path.join(os.tmpdir(), "antigravity-bridge.json");

// ═══════════════════════════════════════════════════════════════════════════
// § 1. Protobuf Encoding
// ═══════════════════════════════════════════════════════════════════════════

const MODEL_IDS = {
    "Gemini 3.1 Pro (High)": 1037,
    "Gemini 3.1 Pro (Low)": 1036,
    "Gemini 3 Flash": 1018,
    "Claude Sonnet 4.6 (Thinking)": 1035,
    "Claude Opus 4.6 (Thinking)": 1026,
    "GPT-OSS 120B (Medium)": 342,
};

function ldField(tag, data) {
    const tagByte = (tag << 3) | 2;
    const body = typeof data === "string" ? Buffer.from(data) : data;
    const len = body.length;
    const lenBytes = [];
    if (len < 128) {
        lenBytes.push(len);
    } else if (len < 16384) {
        lenBytes.push((len & 0x7f) | 0x80);
        lenBytes.push(len >> 7);
    } else {
        let remaining = len;
        while (remaining >= 128) {
            lenBytes.push((remaining & 0x7f) | 0x80);
            remaining >>= 7;
        }
        lenBytes.push(remaining);
    }
    return Buffer.concat([Buffer.from([tagByte]), Buffer.from(lenBytes), body]);
}

function buildMetadata(oauthToken, extensionVersion = "1.14.2") {
    return Buffer.concat([
        ldField(1, "antigravity"),
        ldField(3, oauthToken),
        ldField(4, "en"),
        ldField(7, extensionVersion),
        ldField(12, "antigravity"),
    ]);
}

function encodeVarint(value) {
    const bytes = [];
    while (value > 0x7f) {
        bytes.push((value & 0x7f) | 0x80);
        value >>= 7;
    }
    bytes.push(value & 0x7f);
    return Buffer.from(bytes);
}

function buildSafetyConfig(modelName) {
    const modelId = MODEL_IDS[modelName] || MODEL_IDS["Gemini 3 Flash"];
    const modelIdVarint = encodeVarint(modelId);
    const modelField = Buffer.concat([Buffer.from([0x08]), modelIdVarint]);
    const field15 = Buffer.concat([
        Buffer.from([0x7a]),
        Buffer.from([modelField.length]),
        modelField,
    ]);
    const beforeModel = Buffer.from(
        "0a631204200170006a4c42451a43120275761a07676974206164641a096769742073746173681a096769742072657365741a0c67697420636865636b6f75741a09707974686f6e202d631a0370697030038a02020801",
        "hex"
    );
    const afterModel = Buffer.from(
        "aa0102080182020208013a0208015801",
        "hex"
    );
    const innerContent = Buffer.concat([beforeModel, field15, afterModel]);
    return Buffer.concat([
        Buffer.from([0x2a]),
        encodeVarint(innerContent.length),
        innerContent,
    ]);
}

// ═══════════════════════════════════════════════════════════════════════════
// § 2. Process Discovery
// ═══════════════════════════════════════════════════════════════════════════

function pathToWorkspaceId(filePath) {
    let normalized = filePath.replace(/\\/g, "/");
    if (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
    if (normalized.startsWith("/")) normalized = normalized.slice(1);
    const encoded = normalized.replace(/:/g, "_3A").replace(/\//g, "_");
    return `file_${encoded}`;
}

function normalizeWorkspaceIdForComparison(workspaceId) {
    return workspaceId.replace(/-/g, "_").toLowerCase();
}

async function extractAntigravityFromProcess(workspacePath) {
    if (process.platform === "win32") {
        return extractAntigravityFromProcessWindows(workspacePath);
    }
    return extractAntigravityFromProcessUnix(workspacePath);
}

async function extractAntigravityFromProcessWindows(workspacePath) {
    let processes = [];
    try {
        const { stdout } = await execAsync(
            'powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress"',
            { maxBuffer: 10 * 1024 * 1024 }
        );
        const parsed = JSON.parse(stdout);
        processes = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
        try {
            const { stdout } = await execAsync(
                "wmic process get ProcessId,CommandLine /format:csv",
                { maxBuffer: 10 * 1024 * 1024 }
            );
            const lines = stdout.trim().split("\n");
            for (let i = 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;
                const parts = line.split(",");
                if (parts.length >= 3) {
                    const pidStr = parts[parts.length - 1];
                    const cmdLine = parts.slice(1, parts.length - 1).join(",").replace(/^"|"$/g, "");
                    const pid = parseInt(pidStr, 10);
                    if (!isNaN(pid) && pid > 0) {
                        processes.push({ ProcessId: pid, CommandLine: cmdLine || null });
                    }
                }
            }
        } catch {
            return null;
        }
    }
    return matchProcess(processes, workspacePath, "CommandLine", "ProcessId");
}

async function extractAntigravityFromProcessUnix(workspacePath) {
    const { stdout } = await execAsync("ps -ax -o pid=,command=", {
        maxBuffer: 10 * 1024 * 1024,
    });
    const lines = stdout.split("\n");
    const targetWorkspaceId = workspacePath ? pathToWorkspaceId(workspacePath) : null;
    let fallbackProcess = null;
    for (const line of lines) {
        const isLanguageServer =
            line.includes("language_server_macos") || line.includes("language_server");
        const isAntigravity =
            line.includes("--app_data_dir antigravity") ||
            line.toLowerCase().includes("/antigravity/");
        if (isLanguageServer && isAntigravity) {
            const pidMatch = line.trim().match(/^(\d+)/);
            const pid = pidMatch ? parseInt(pidMatch[1], 10) : 0;
            const csrfMatch = line.match(/--csrf_token\s+([a-f0-9-]+)/i);
            const csrfToken = csrfMatch ? csrfMatch[1] : null;
            const portMatch = line.match(/--extension_server_port\s+(\d+)/);
            const extensionServerPort = portMatch ? parseInt(portMatch[1], 10) : undefined;
            const workspaceIdMatch = line.match(/--workspace_id\s+(\S+)/);
            const workspaceId = workspaceIdMatch ? workspaceIdMatch[1] : undefined;
            if (csrfToken) {
                const processInfo = { pid, csrfToken, extensionServerPort, workspaceId };
                if (targetWorkspaceId) {
                    const nProcId = normalizeWorkspaceIdForComparison(workspaceId || "");
                    const nTargetId = normalizeWorkspaceIdForComparison(targetWorkspaceId);
                    if (nProcId === nTargetId) return processInfo;
                    if (!fallbackProcess) fallbackProcess = processInfo;
                } else {
                    return processInfo;
                }
            }
        }
    }
    return fallbackProcess;
}

function matchProcess(processes, workspacePath, cmdField, pidField) {
    const targetWorkspaceId = workspacePath ? pathToWorkspaceId(workspacePath) : null;
    let fallbackProcess = null;
    for (const proc of processes) {
        const cmdLine = proc[cmdField] || "";
        const isLanguageServer =
            cmdLine.includes("language_server_windows") ||
            cmdLine.includes("language_server.exe") ||
            cmdLine.includes("language_server");
        const isAntigravity =
            cmdLine.includes("--app_data_dir antigravity") ||
            cmdLine.toLowerCase().includes("\\antigravity\\") ||
            cmdLine.toLowerCase().includes("/antigravity/");
        if (isLanguageServer && isAntigravity) {
            const pid = proc[pidField];
            const csrfMatch = cmdLine.match(/--csrf_token\s+([a-f0-9-]+)/i);
            const csrfToken = csrfMatch ? csrfMatch[1] : null;
            const portMatch = cmdLine.match(/--extension_server_port\s+(\d+)/);
            const extensionServerPort = portMatch ? parseInt(portMatch[1], 10) : undefined;
            const workspaceIdMatch = cmdLine.match(/--workspace_id\s+(\S+)/);
            const workspaceId = workspaceIdMatch ? workspaceIdMatch[1] : undefined;
            if (csrfToken) {
                const processInfo = { pid, csrfToken, extensionServerPort, workspaceId };
                if (targetWorkspaceId) {
                    const nProcId = normalizeWorkspaceIdForComparison(workspaceId || "");
                    const nTargetId = normalizeWorkspaceIdForComparison(targetWorkspaceId);
                    if (nProcId === nTargetId) return processInfo;
                    if (!fallbackProcess) fallbackProcess = processInfo;
                } else {
                    return processInfo;
                }
            }
        }
    }
    return fallbackProcess;
}

async function extractOAuthToken() {
    const homeDir = os.homedir();
    const possiblePaths = [
        path.join(homeDir, "Library", "Application Support", "Antigravity", "User", "globalStorage", "state.vscdb"),
        path.join(homeDir, "Library", "Application Support", "Antigravity", "User", "state.vscdb"),
        path.join(homeDir, ".config", "Antigravity", "User", "globalStorage", "state.vscdb"),
        path.join(homeDir, "AppData", "Roaming", "Antigravity", "User", "globalStorage", "state.vscdb"),
    ];
    for (const dbPath of possiblePaths) {
        try {
            const content = await fs.promises.readFile(dbPath);
            const contentStr = content.toString("utf8");
            const tokenMatch = contentStr.match(/ya29\.[A-Za-z0-9_-]{50,}/);
            if (tokenMatch) return tokenMatch[0];
        } catch {
            continue;
        }
    }
    return null;
}

async function getListeningPorts(pid) {
    const ports = [];
    if (process.platform === "win32") {
        try {
            const { stdout } = await execAsync("netstat -ano", { maxBuffer: 10 * 1024 * 1024 });
            for (const line of stdout.split("\n")) {
                if (line.includes("LISTENING")) {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 5) {
                        const linePid = parseInt(parts[parts.length - 1], 10);
                        if (linePid === pid) {
                            const portMatch = parts[1].match(/:(\d+)$/);
                            if (portMatch) {
                                const port = parseInt(portMatch[1], 10);
                                if (!ports.includes(port)) ports.push(port);
                            }
                        }
                    }
                }
            }
        } catch { }
    } else {
        try {
            const { stdout } = await execFileAsync("lsof", [
                "-nP", "-iTCP", "-sTCP:LISTEN", "-p", pid.toString(),
            ], { maxBuffer: 10 * 1024 * 1024 });
            for (const line of stdout.split("\n")) {
                if (line.includes("TCP") && line.includes("LISTEN")) {
                    const portMatch = line.match(/:(\d+)\s*\(LISTEN\)/);
                    if (portMatch) {
                        const port = parseInt(portMatch[1], 10);
                        if (!ports.includes(port)) ports.push(port);
                    }
                }
            }
        } catch { }
    }
    return ports;
}

function probeGrpcPort(port, csrfToken) {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(false), 2000);
        try {
            const client = http2.connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false });
            client.on("error", () => { clearTimeout(timeout); client.close(); resolve(false); });
            client.on("connect", () => {
                const metadata = Buffer.concat([ldField(1, "antigravity"), ldField(4, "en")]);
                const payload = ldField(1, metadata);
                const req = client.request({
                    ":method": "POST",
                    ":path": "/exa.language_server_pb.LanguageServerService/GetUnleashData",
                    "content-type": "application/proto",
                    "connect-protocol-version": "1",
                    "x-codeium-csrf-token": csrfToken || "",
                    "content-length": payload.length.toString(),
                });
                req.on("response", (headers) => {
                    clearTimeout(timeout); client.close();
                    resolve(headers[":status"] === 200);
                });
                req.on("error", () => { clearTimeout(timeout); client.close(); resolve(false); });
                req.write(payload);
                req.end();
            });
        } catch {
            clearTimeout(timeout);
            resolve(false);
        }
    });
}

async function discoverAntigravity(workspacePath) {
    const processInfo = await extractAntigravityFromProcess(workspacePath);
    if (!processInfo?.pid) throw new Error("No Antigravity process found. Is Antigravity IDE running?");

    const listeningPorts = await getListeningPorts(processInfo.pid);
    if (listeningPorts.length === 0) throw new Error(`No listening ports found for Antigravity PID ${processInfo.pid}`);

    let grpcPort = null;
    for (const port of listeningPorts) {
        if (await probeGrpcPort(port, processInfo.csrfToken)) {
            grpcPort = port;
            break;
        }
    }
    if (!grpcPort) throw new Error("Could not find Antigravity gRPC port among listening ports");

    const oauthToken = await extractOAuthToken();
    if (!oauthToken) throw new Error("Could not extract OAuth token from Antigravity state database");

    return {
        port: grpcPort,
        csrfToken: processInfo.csrfToken,
        oauthToken,
        pid: processInfo.pid,
        workspaceId: processInfo.workspaceId,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// § 3. Antigravity HTTP/2 Client
// ═══════════════════════════════════════════════════════════════════════════

class AntigravityClient {
    constructor(config) {
        this.client = null;
        this.config = config;
    }

    async connect() {
        return new Promise((resolve, reject) => {
            this.client = http2.connect(`https://127.0.0.1:${this.config.port}`, {
                rejectUnauthorized: false,
            });
            let connected = false;
            this.client.on("connect", () => { connected = true; resolve(); });
            this.client.on("error", (err) => reject(err));
            setTimeout(() => { if (!connected) reject(new Error("Connection timeout")); }, 5000);
        });
    }

    disconnect() {
        if (!this.client) return;
        this.client.close();
        this.client = null;
    }

    async startCascade(enablePlanning = false) {
        if (!this.client) throw new Error("Not connected");
        const metadata = buildMetadata(this.config.oauthToken);
        const payload = Buffer.concat([
            ldField(1, metadata),
            Buffer.from([0x20, enablePlanning ? 0x01 : 0x00]),
        ]);
        return new Promise((resolve, reject) => {
            const req = this.client.request({
                ":method": "POST",
                ":path": "/exa.language_server_pb.LanguageServerService/StartCascade",
                "content-type": "application/proto",
                "connect-protocol-version": "1",
                origin: "vscode-file://vscode-app",
                "x-codeium-csrf-token": this.config.csrfToken,
                "content-length": payload.length.toString(),
            });
            let responseData = Buffer.alloc(0);
            req.on("response", (headers) => {
                if (headers[":status"] !== 200) reject(new Error(`StartCascade failed: status ${headers[":status"]}`));
            });
            req.on("data", (chunk) => { responseData = Buffer.concat([responseData, chunk]); });
            req.on("end", () => {
                if (responseData.length > 2) {
                    const len = responseData[1];
                    resolve(responseData.subarray(2, 2 + len).toString("utf8"));
                    return;
                }
                reject(new Error("Empty response from StartCascade"));
            });
            req.on("error", reject);
            req.write(payload);
            req.end();
        });
    }

    async sendMessage(cascadeId, message, mode = "Fast", modelName = "Gemini 3 Flash") {
        if (!this.client) throw new Error("Not connected");
        const messageBody = ldField(1, message);
        const planningMode = mode === "Planning" ? 1 : 0;
        const modeField = Buffer.from([0x70, planningMode]);
        const safetyConfig = buildSafetyConfig(modelName);
        const payload = Buffer.concat([
            ldField(1, cascadeId),
            ldField(2, messageBody),
            ldField(3, buildMetadata(this.config.oauthToken)),
            safetyConfig,
            modeField,
        ]);
        return new Promise((resolve, reject) => {
            const req = this.client.request({
                ":method": "POST",
                ":path": "/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage",
                "content-type": "application/proto",
                "connect-protocol-version": "1",
                origin: "vscode-file://vscode-app",
                "x-codeium-csrf-token": this.config.csrfToken,
                "content-length": payload.length.toString(),
            });
            req.on("response", (headers) => {
                if (headers[":status"] === 200) { resolve(); return; }
                reject(new Error(`SendMessage failed: status ${headers[":status"]}`));
            });
            req.on("error", reject);
            req.write(payload);
            req.end();
        });
    }

    async pollOnce(cascadeId) {
        if (!this.client) throw new Error("Not connected");
        const payload = ldField(1, cascadeId);
        return new Promise((resolve, reject) => {
            const req = this.client.request({
                ":method": "POST",
                ":path": "/exa.language_server_pb.LanguageServerService/GetCascadeTrajectorySteps",
                "content-type": "application/proto",
                "connect-protocol-version": "1",
                origin: "vscode-file://vscode-app",
                "x-codeium-csrf-token": this.config.csrfToken,
                "content-length": payload.length.toString(),
            });
            let responseData = Buffer.alloc(0);
            req.on("data", (chunk) => { responseData = Buffer.concat([responseData, chunk]); });
            req.on("response", (headers) => {
                req.on("end", () => {
                    const raw = responseData.toString("utf8");
                    const text = raw.replace(/[^\x20-\x7E\n\r\t]/g, "");
                    resolve({ status: headers[":status"], contentLength: text.length, content: text });
                });
            });
            req.on("error", reject);
            req.write(payload);
            req.end();
        });
    }

    async sendAndWait(cascadeId, message, mode, model, pollIntervalMs = 4000, stableThreshold = 7) {
        await this.sendMessage(cascadeId, message, mode, model);
        let lastContentLen = 0;
        let stableCount = 0;
        let hasGrown = false;
        const startTime = Date.now();
        const responses = [];
        while (true) {
            const result = await this.pollOnce(cascadeId);
            if (result.status !== 200) {
                await sleep(pollIntervalMs);
                continue;
            }
            const contentGrew = result.contentLength > lastContentLen;
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            if (contentGrew) {
                hasGrown = true;
                stableCount = 0;
                process.stderr.write(`\r[${elapsed}s] Agent working... (${result.contentLength} chars)`);
            } else if (hasGrown) {
                stableCount++;
                process.stderr.write(`\r[${elapsed}s] Stabilizing... (${stableCount}/${stableThreshold})  `);
                if (stableCount >= stableThreshold) {
                    process.stderr.write(`\r[${elapsed}s] Agent completed.                              \n`);
                    responses.push(result.content);
                    break;
                }
            } else {
                process.stderr.write(`\r[${elapsed}s] Waiting for agent to start...`);
            }
            lastContentLen = result.contentLength;
            if (result.content) responses.push(result.content);
            await sleep(pollIntervalMs);
        }
        // Return only the last (most complete) response
        return responses.length > 0 ? responses[responses.length - 1] : "";
    }

    async cancelCascade(cascadeId) {
        if (!this.client) throw new Error("Not connected");
        const payload = ldField(1, cascadeId);
        return this._simpleRpc(
            "/exa.language_server_pb.LanguageServerService/CancelCascadeInvocation",
            payload
        );
    }

    async deleteCascade(cascadeId) {
        if (!this.client) throw new Error("Not connected");
        const payload = ldField(1, cascadeId);
        return this._simpleRpc(
            "/exa.language_server_pb.LanguageServerService/DeleteCascadeTrajectory",
            payload
        );
    }

    async _simpleRpc(rpcPath, payload) {
        return new Promise((resolve, reject) => {
            const req = this.client.request({
                ":method": "POST",
                ":path": rpcPath,
                "content-type": "application/proto",
                "connect-protocol-version": "1",
                origin: "vscode-file://vscode-app",
                "x-codeium-csrf-token": this.config.csrfToken,
                "content-length": payload.length.toString(),
            });
            req.on("response", (headers) => {
                if (headers[":status"] === 200) { resolve(); return; }
                reject(new Error(`RPC ${rpcPath} failed: status ${headers[":status"]}`));
            });
            req.on("error", reject);
            req.write(payload);
            req.end();
        });
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// § 4. CLI Entry Point
// ═══════════════════════════════════════════════════════════════════════════

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function output(data) {
    console.log(JSON.stringify(data, null, 2));
}

function error(message) {
    console.error(JSON.stringify({ error: message }));
    process.exit(1);
}

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg.startsWith("--")) {
            const key = arg.slice(2);
            const next = argv[i + 1];
            if (next && !next.startsWith("--")) {
                args[key] = next;
                i++;
            } else {
                args[key] = true;
            }
        } else if (!args._command) {
            args._command = arg;
        }
    }
    return args;
}

async function loadCachedConfig() {
    try {
        const content = await fs.promises.readFile(CACHE_FILE, "utf8");
        return JSON.parse(content);
    } catch {
        return null;
    }
}

async function saveCachedConfig(config) {
    await fs.promises.writeFile(CACHE_FILE, JSON.stringify(config, null, 2));
}

async function getClientConfig(args) {
    // Explicit args override cache
    if (args.port && args.csrf && args.oauth) {
        return {
            port: parseInt(args.port, 10),
            csrfToken: args.csrf,
            oauthToken: args.oauth,
        };
    }
    // Try cache
    const cached = await loadCachedConfig();
    if (cached?.port && cached?.csrfToken && cached?.oauthToken) {
        return cached;
    }
    // Auto-discover
    const config = await discoverAntigravity(args.workspace);
    await saveCachedConfig(config);
    return config;
}

async function createConnectedClient(args) {
    const config = await getClientConfig(args);
    const client = new AntigravityClient(config);
    await client.connect();
    return client;
}

const HELP_TEXT = `
antigravity-bridge.js — Claude Code → Antigravity Bridge

SUB-COMMANDS:
  discover            Find Antigravity process, extract connection info
  start-cascade       Create a new chat session
  send                Send a message (fire-and-forget)
  send-and-wait       Send a message and wait for agent completion
  poll                Poll cascade trajectory once
  cancel              Cancel running cascade invocation
  delete              Delete a cascade trajectory
  models              List available models

OPTIONS:
  --workspace <path>  Target workspace directory
  --cascade <id>      Cascade ID (for send/poll/cancel/delete)
  --message <text>    Message to send
  --message-file <f>  Read message from file instead
  --mode <mode>       "Fast" (default) or "Planning"
  --model <name>      Model name (default: "Gemini 3 Flash")
  --poll-interval <s> Poll interval in seconds (default: 4)
  --stable <n>        Stable threshold (default: 7)
  --port <n>          Override Antigravity port
  --csrf <token>      Override CSRF token
  --oauth <token>     Override OAuth token
  --help              Show this help
`;

async function main() {
    const args = parseArgs(process.argv.slice(2));

    if (args.help || !args._command) {
        console.log(HELP_TEXT);
        process.exit(args.help ? 0 : 1);
    }

    const command = args._command;

    try {
        switch (command) {
            case "discover": {
                const config = await discoverAntigravity(args.workspace);
                await saveCachedConfig(config);
                output({
                    port: config.port,
                    csrfToken: config.csrfToken.substring(0, 8) + "...",
                    oauthToken: config.oauthToken.substring(0, 10) + "...",
                    pid: config.pid,
                    workspaceId: config.workspaceId,
                    cachedTo: CACHE_FILE,
                });
                break;
            }

            case "start-cascade": {
                const client = await createConnectedClient(args);
                const mode = args.mode || "Fast";
                const enablePlanning = mode === "Planning";
                const cascadeId = await client.startCascade(enablePlanning);
                client.disconnect();
                output({ cascadeId, mode });
                break;
            }

            case "send": {
                if (!args.cascade) error("--cascade <id> is required");
                let message = args.message;
                if (!message && args["message-file"]) {
                    message = await fs.promises.readFile(args["message-file"], "utf8");
                }
                if (!message) error("--message or --message-file is required");
                const client = await createConnectedClient(args);
                const mode = args.mode || "Fast";
                const model = args.model || "Gemini 3 Flash";
                await client.sendMessage(args.cascade, message, mode, model);
                client.disconnect();
                output({ status: "sent", cascade: args.cascade, mode, model });
                break;
            }

            case "send-and-wait": {
                if (!args.cascade) error("--cascade <id> is required");
                let message = args.message;
                if (!message && args["message-file"]) {
                    message = await fs.promises.readFile(args["message-file"], "utf8");
                }
                if (!message) error("--message or --message-file is required");
                const client = await createConnectedClient(args);
                const mode = args.mode || "Fast";
                const model = args.model || "Gemini 3 Flash";
                const pollInterval = (parseFloat(args["poll-interval"] || "4") * 1000) || 4000;
                const stableThreshold = parseInt(args.stable || "7", 10) || 7;
                const response = await client.sendAndWait(
                    args.cascade, message, mode, model, pollInterval, stableThreshold
                );
                client.disconnect();
                output({
                    status: "completed",
                    cascade: args.cascade,
                    responseLength: response.length,
                    response: response.substring(0, 2000) + (response.length > 2000 ? "..." : ""),
                });
                break;
            }

            case "poll": {
                if (!args.cascade) error("--cascade <id> is required");
                const client = await createConnectedClient(args);
                const result = await client.pollOnce(args.cascade);
                client.disconnect();
                output(result);
                break;
            }

            case "cancel": {
                if (!args.cascade) error("--cascade <id> is required");
                const client = await createConnectedClient(args);
                await client.cancelCascade(args.cascade);
                client.disconnect();
                output({ status: "cancelled", cascade: args.cascade });
                break;
            }

            case "delete": {
                if (!args.cascade) error("--cascade <id> is required");
                const client = await createConnectedClient(args);
                await client.deleteCascade(args.cascade);
                client.disconnect();
                output({ status: "deleted", cascade: args.cascade });
                break;
            }

            case "models": {
                output(Object.entries(MODEL_IDS).map(([name, id]) => ({ name, id })));
                break;
            }

            default:
                error(`Unknown command: ${command}. Run with --help for usage.`);
        }
    } catch (err) {
        error(err.message || String(err));
    }
}

main();
