#!/usr/bin/env node
/**
 * AG-Controller — MCP Server
 *
 * Exposes Antigravity IDE control as MCP tools for Claude Code.
 * Uses @modelcontextprotocol/sdk for the MCP protocol,
 * and embeds the bridge logic from antigravity-bridge.js.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import http2 from "node:http2";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";

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
const MODEL_NAMES = Object.keys(MODEL_IDS);

function ldField(tag, data) {
    const tagByte = (tag << 3) | 2;
    const body = typeof data === "string" ? Buffer.from(data) : data;
    const len = body.length;
    const lenBytes = [];
    if (len < 128) lenBytes.push(len);
    else if (len < 16384) { lenBytes.push((len & 0x7f) | 0x80); lenBytes.push(len >> 7); }
    else { let r = len; while (r >= 128) { lenBytes.push((r & 0x7f) | 0x80); r >>= 7; } lenBytes.push(r); }
    return Buffer.concat([Buffer.from([tagByte]), Buffer.from(lenBytes), body]);
}

function buildMetadata(oauthToken, ver = "1.14.2") {
    return Buffer.concat([ldField(1, "antigravity"), ldField(3, oauthToken), ldField(4, "en"), ldField(7, ver), ldField(12, "antigravity")]);
}

function encodeVarint(value) {
    const b = []; while (value > 0x7f) { b.push((value & 0x7f) | 0x80); value >>= 7; } b.push(value & 0x7f); return Buffer.from(b);
}

function buildSafetyConfig(modelName) {
    const id = MODEL_IDS[modelName] || MODEL_IDS["Gemini 3 Flash"];
    const mv = encodeVarint(id);
    const mf = Buffer.concat([Buffer.from([0x08]), mv]);
    const f15 = Buffer.concat([Buffer.from([0x7a]), Buffer.from([mf.length]), mf]);
    const before = Buffer.from("0a631204200170006a4c42451a43120275761a07676974206164641a096769742073746173681a096769742072657365741a0c67697420636865636b6f75741a09707974686f6e202d631a0370697030038a02020801", "hex");
    const after = Buffer.from("aa0102080182020208013a0208015801", "hex");
    const inner = Buffer.concat([before, f15, after]);
    return Buffer.concat([Buffer.from([0x2a]), encodeVarint(inner.length), inner]);
}

// ═══════════════════════════════════════════════════════════════════════════
// § 2. Process Discovery
// ═══════════════════════════════════════════════════════════════════════════

function pathToWorkspaceId(fp) {
    let n = fp.replace(/\\/g, "/"); if (n.endsWith("/")) n = n.slice(0, -1); if (n.startsWith("/")) n = n.slice(1);
    return `file_${n.replace(/:/g, "_3A").replace(/\//g, "_")}`;
}

function normWsId(id) { return id.replace(/-/g, "_").toLowerCase(); }

async function extractAntigravityFromProcessUnix(workspacePath) {
    const { stdout } = await execAsync("ps -ax -o pid=,command=", { maxBuffer: 10 * 1024 * 1024 });
    const targetWsId = workspacePath ? pathToWorkspaceId(workspacePath) : null;
    let fallback = null;
    for (const line of stdout.split("\n")) {
        const isLS = line.includes("language_server_macos") || line.includes("language_server");
        const isAG = line.includes("--app_data_dir antigravity") || line.toLowerCase().includes("/antigravity/");
        if (isLS && isAG) {
            const pidM = line.trim().match(/^(\d+)/);
            const pid = pidM ? parseInt(pidM[1], 10) : 0;
            const csrfM = line.match(/--csrf_token\s+([a-f0-9-]+)/i);
            const csrf = csrfM ? csrfM[1] : null;
            const portM = line.match(/--extension_server_port\s+(\d+)/);
            const port = portM ? parseInt(portM[1], 10) : undefined;
            const wsM = line.match(/--workspace_id\s+(\S+)/);
            const wsId = wsM ? wsM[1] : undefined;
            if (csrf) {
                const info = { pid, csrfToken: csrf, extensionServerPort: port, workspaceId: wsId };
                if (targetWsId) {
                    if (normWsId(wsId || "") === normWsId(targetWsId)) return info;
                    if (!fallback) fallback = info;
                } else return info;
            }
        }
    }
    return fallback;
}

async function extractOAuthToken() {
    const home = os.homedir();
    const paths = [
        path.join(home, "Library", "Application Support", "Antigravity", "User", "globalStorage", "state.vscdb"),
        path.join(home, "Library", "Application Support", "Antigravity", "User", "state.vscdb"),
        path.join(home, ".config", "Antigravity", "User", "globalStorage", "state.vscdb"),
        path.join(home, "AppData", "Roaming", "Antigravity", "User", "globalStorage", "state.vscdb"),
    ];
    for (const p of paths) {
        try {
            const c = await fs.promises.readFile(p);
            const m = c.toString("utf8").match(/ya29\.[A-Za-z0-9_-]{50,}/);
            if (m) return m[0];
        } catch { continue; }
    }
    return null;
}

async function getListeningPorts(pid) {
    const ports = [];
    try {
        const { stdout } = await execFileAsync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-p", pid.toString()], { maxBuffer: 10 * 1024 * 1024 });
        for (const line of stdout.split("\n")) {
            if (line.includes("TCP") && line.includes("LISTEN")) {
                const m = line.match(/:(\d+)\s*\(LISTEN\)/);
                if (m) { const p = parseInt(m[1], 10); if (!ports.includes(p)) ports.push(p); }
            }
        }
    } catch { }
    return ports;
}

function probeGrpcPort(port, csrfToken) {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(false), 2000);
        try {
            const client = http2.connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false });
            client.on("error", () => { clearTimeout(timeout); client.close(); resolve(false); });
            client.on("connect", () => {
                const meta = Buffer.concat([ldField(1, "antigravity"), ldField(4, "en")]);
                const payload = ldField(1, meta);
                const req = client.request({
                    ":method": "POST", ":path": "/exa.language_server_pb.LanguageServerService/GetUnleashData",
                    "content-type": "application/proto", "connect-protocol-version": "1",
                    "x-codeium-csrf-token": csrfToken || "", "content-length": payload.length.toString(),
                });
                req.on("response", (h) => { clearTimeout(timeout); client.close(); resolve(h[":status"] === 200); });
                req.on("error", () => { clearTimeout(timeout); client.close(); resolve(false); });
                req.write(payload); req.end();
            });
        } catch { clearTimeout(timeout); resolve(false); }
    });
}

async function discoverAntigravity(workspacePath) {
    const proc = await extractAntigravityFromProcessUnix(workspacePath);
    if (!proc?.pid) throw new Error("No Antigravity process found. Is Antigravity IDE running?");
    const ports = await getListeningPorts(proc.pid);
    if (ports.length === 0) throw new Error(`No listening ports for Antigravity PID ${proc.pid}`);
    let grpcPort = null;
    for (const p of ports) { if (await probeGrpcPort(p, proc.csrfToken)) { grpcPort = p; break; } }
    if (!grpcPort) throw new Error("Could not find Antigravity gRPC port");
    const oauth = await extractOAuthToken();
    if (!oauth) throw new Error("Could not extract OAuth token from Antigravity");
    const config = { port: grpcPort, csrfToken: proc.csrfToken, oauthToken: oauth, pid: proc.pid, workspaceId: proc.workspaceId };
    await fs.promises.writeFile(CACHE_FILE, JSON.stringify(config, null, 2));
    return config;
}

// ═══════════════════════════════════════════════════════════════════════════
// § 3. Antigravity Client
// ═══════════════════════════════════════════════════════════════════════════

class AntigravityClient {
    constructor(config) { this.client = null; this.config = config; }

    async connect() {
        return new Promise((resolve, reject) => {
            this.client = http2.connect(`https://127.0.0.1:${this.config.port}`, { rejectUnauthorized: false });
            let ok = false;
            this.client.on("connect", () => { ok = true; resolve(); });
            this.client.on("error", (e) => reject(e));
            setTimeout(() => { if (!ok) reject(new Error("Connection timeout")); }, 5000);
        });
    }

    disconnect() { if (this.client) { this.client.close(); this.client = null; } }

    async startCascade(planning = false) {
        const meta = buildMetadata(this.config.oauthToken);
        const payload = Buffer.concat([ldField(1, meta), Buffer.from([0x20, planning ? 0x01 : 0x00])]);
        return new Promise((resolve, reject) => {
            const req = this.client.request({
                ":method": "POST", ":path": "/exa.language_server_pb.LanguageServerService/StartCascade",
                "content-type": "application/proto", "connect-protocol-version": "1",
                origin: "vscode-file://vscode-app", "x-codeium-csrf-token": this.config.csrfToken,
                "content-length": payload.length.toString(),
            });
            let data = Buffer.alloc(0);
            req.on("response", (h) => { if (h[":status"] !== 200) reject(new Error(`StartCascade: status ${h[":status"]}`)); });
            req.on("data", (c) => { data = Buffer.concat([data, c]); });
            req.on("end", () => { data.length > 2 ? resolve(data.subarray(2, 2 + data[1]).toString("utf8")) : reject(new Error("Empty StartCascade response")); });
            req.on("error", reject); req.write(payload); req.end();
        });
    }

    async sendMessage(cascadeId, message, mode = "Fast", model = "Gemini 3 Flash") {
        const payload = Buffer.concat([
            ldField(1, cascadeId), ldField(2, ldField(1, message)),
            ldField(3, buildMetadata(this.config.oauthToken)),
            buildSafetyConfig(model), Buffer.from([0x70, mode === "Planning" ? 1 : 0]),
        ]);
        return new Promise((resolve, reject) => {
            const req = this.client.request({
                ":method": "POST", ":path": "/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage",
                "content-type": "application/proto", "connect-protocol-version": "1",
                origin: "vscode-file://vscode-app", "x-codeium-csrf-token": this.config.csrfToken,
                "content-length": payload.length.toString(),
            });
            req.on("response", (h) => { h[":status"] === 200 ? resolve() : reject(new Error(`SendMessage: status ${h[":status"]}`)); });
            req.on("error", reject); req.write(payload); req.end();
        });
    }

    async pollOnce(cascadeId) {
        const payload = ldField(1, cascadeId);
        return new Promise((resolve, reject) => {
            const req = this.client.request({
                ":method": "POST", ":path": "/exa.language_server_pb.LanguageServerService/GetCascadeTrajectorySteps",
                "content-type": "application/proto", "connect-protocol-version": "1",
                origin: "vscode-file://vscode-app", "x-codeium-csrf-token": this.config.csrfToken,
                "content-length": payload.length.toString(),
            });
            let data = Buffer.alloc(0);
            req.on("data", (c) => { data = Buffer.concat([data, c]); });
            req.on("response", (h) => {
                req.on("end", () => {
                    const text = data.toString("utf8").replace(/[^\x20-\x7E\n\r\t]/g, "");
                    resolve({ status: h[":status"], contentLength: text.length, content: text });
                });
            });
            req.on("error", reject); req.write(payload); req.end();
        });
    }

    async sendAndWait(cascadeId, message, mode, model, pollMs = 4000, threshold = 7) {
        await this.sendMessage(cascadeId, message, mode, model);
        let lastLen = 0, stable = 0, grown = false;
        while (true) {
            const r = await this.pollOnce(cascadeId);
            if (r.status !== 200) { await sleep(pollMs); continue; }
            if (r.contentLength > lastLen) { grown = true; stable = 0; }
            else if (grown) { stable++; if (stable >= threshold) return r.content; }
            lastLen = r.contentLength;
            await sleep(pollMs);
        }
    }

    async _rpc(rpcPath, payload) {
        return new Promise((resolve, reject) => {
            const req = this.client.request({
                ":method": "POST", ":path": rpcPath, "content-type": "application/proto",
                "connect-protocol-version": "1", origin: "vscode-file://vscode-app",
                "x-codeium-csrf-token": this.config.csrfToken, "content-length": payload.length.toString(),
            });
            req.on("response", (h) => { h[":status"] === 200 ? resolve() : reject(new Error(`${rpcPath}: status ${h[":status"]}`)); });
            req.on("error", reject); req.write(payload); req.end();
        });
    }

    cancelCascade(id) { return this._rpc("/exa.language_server_pb.LanguageServerService/CancelCascadeInvocation", ldField(1, id)); }
    deleteCascade(id) { return this._rpc("/exa.language_server_pb.LanguageServerService/DeleteCascadeTrajectory", ldField(1, id)); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════════════════════════
// § 4. Shared Client Manager (reuse across tool calls)
// ═══════════════════════════════════════════════════════════════════════════

let cachedClient = null;

async function getClient(workspace) {
    if (cachedClient) return cachedClient;
    // Try cache file first
    let config;
    try {
        const content = await fs.promises.readFile(CACHE_FILE, "utf8");
        config = JSON.parse(content);
        if (!config.port || !config.csrfToken || !config.oauthToken) throw new Error("incomplete");
    } catch {
        config = await discoverAntigravity(workspace);
    }
    const client = new AntigravityClient(config);
    await client.connect();
    cachedClient = client;
    return client;
}

// ═══════════════════════════════════════════════════════════════════════════
// § 5. MCP Server Definition
// ═══════════════════════════════════════════════════════════════════════════

const server = new McpServer({
    name: "ag-controller",
    version: "1.0.0",
});

// Tool: discover
server.tool(
    "antigravity_discover",
    "Discover a running Antigravity IDE instance. Returns connection info (port, tokens, PID). Auto-caches for subsequent calls.",
    { workspace: z.string().optional().describe("Target workspace directory path") },
    async ({ workspace }) => {
        const config = await discoverAntigravity(workspace);
        // Reset cached client since we re-discovered
        if (cachedClient) { cachedClient.disconnect(); cachedClient = null; }
        return {
            content: [{
                type: "text",
                text: JSON.stringify({
                    port: config.port,
                    pid: config.pid,
                    workspaceId: config.workspaceId,
                    status: "discovered",
                }, null, 2),
            }],
        };
    }
);

// Tool: start_cascade
server.tool(
    "antigravity_start_cascade",
    "Create a new chat session (cascade) in Antigravity. Returns a cascadeId for subsequent operations.",
    { mode: z.enum(["Fast", "Planning"]).default("Fast").describe("Fast for implementation, Planning for architectural decisions") },
    async ({ mode }) => {
        const client = await getClient();
        const cascadeId = await client.startCascade(mode === "Planning");
        return {
            content: [{ type: "text", text: JSON.stringify({ cascadeId, mode }, null, 2) }],
        };
    }
);

// Tool: send_message
server.tool(
    "antigravity_send_message",
    "Send a message to the Antigravity Agent (fire-and-forget, does not wait for completion). Use antigravity_send_and_wait to wait.",
    {
        cascadeId: z.string().describe("Cascade ID from antigravity_start_cascade"),
        message: z.string().describe("Message/task to send to the agent"),
        model: z.enum(MODEL_NAMES).default("Gemini 3 Flash").describe("Model to use"),
        mode: z.enum(["Fast", "Planning"]).default("Fast"),
    },
    async ({ cascadeId, message, model, mode }) => {
        const client = await getClient();
        await client.sendMessage(cascadeId, message, mode, model);
        return {
            content: [{ type: "text", text: JSON.stringify({ status: "sent", cascadeId, model, mode }, null, 2) }],
        };
    }
);

// Tool: send_and_wait
server.tool(
    "antigravity_send_and_wait",
    "Send a message to the Antigravity Agent and wait for it to complete. Polls for content stability to detect completion. Returns the agent's full response.",
    {
        cascadeId: z.string().describe("Cascade ID from antigravity_start_cascade"),
        message: z.string().describe("Message/task to send to the agent"),
        model: z.enum(MODEL_NAMES).default("Gemini 3 Flash").describe("Model to use"),
        mode: z.enum(["Fast", "Planning"]).default("Fast"),
        pollIntervalSeconds: z.number().default(4).describe("Seconds between polls"),
        stableThreshold: z.number().default(7).describe("Number of stable polls before considering done"),
    },
    async ({ cascadeId, message, model, mode, pollIntervalSeconds, stableThreshold }) => {
        const client = await getClient();
        const response = await client.sendAndWait(cascadeId, message, mode, model, pollIntervalSeconds * 1000, stableThreshold);
        return {
            content: [{
                type: "text",
                text: JSON.stringify({
                    status: "completed",
                    cascadeId,
                    responseLength: response.length,
                    response: response.substring(0, 3000) + (response.length > 3000 ? "..." : ""),
                }, null, 2),
            }],
        };
    }
);

// Tool: poll
server.tool(
    "antigravity_poll",
    "Poll the cascade trajectory once. Returns current content length and text.",
    { cascadeId: z.string().describe("Cascade ID to poll") },
    async ({ cascadeId }) => {
        const client = await getClient();
        const result = await client.pollOnce(cascadeId);
        return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
    }
);

// Tool: cancel
server.tool(
    "antigravity_cancel",
    "Cancel a running cascade invocation in Antigravity.",
    { cascadeId: z.string().describe("Cascade ID to cancel") },
    async ({ cascadeId }) => {
        const client = await getClient();
        await client.cancelCascade(cascadeId);
        return {
            content: [{ type: "text", text: JSON.stringify({ status: "cancelled", cascadeId }, null, 2) }],
        };
    }
);

// Tool: delete
server.tool(
    "antigravity_delete",
    "Delete a cascade trajectory from Antigravity. Use after completing a task to clean up.",
    { cascadeId: z.string().describe("Cascade ID to delete") },
    async ({ cascadeId }) => {
        const client = await getClient();
        await client.deleteCascade(cascadeId);
        return {
            content: [{ type: "text", text: JSON.stringify({ status: "deleted", cascadeId }, null, 2) }],
        };
    }
);

// ═══════════════════════════════════════════════════════════════════════════
// § 6. Start Server
// ═══════════════════════════════════════════════════════════════════════════

const transport = new StdioServerTransport();
await server.connect(transport);
