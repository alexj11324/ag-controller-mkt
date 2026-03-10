# AG-Controller

> Claude Code plugin to control Antigravity IDE Agent — zero dependencies, pure CLI.

**让 Claude Code 直接操控 Antigravity IDE Agent。** 安装后，告诉 Claude Code *"让 Antigravity 帮我做 XXX"*，它就会自动调用 CLI 完成任务。

## 安装

```bash
/plugin marketplace add alexj11324/ag-controller-mkt
/plugin install ag-controller@alexj11324/ag-controller-mkt
```

## 工作原理

- **`antigravity-bridge.js`** — 零依赖 Node.js CLI，通过 Protobuf/HTTP2 控制 Antigravity
- **`SKILL.md`** — 教 Claude Code 怎么用这个 CLI（自动注入上下文）
- **`/ag-controller:run`** — 一键执行完整工作流

没有 MCP Server，没有 npm 依赖，没有额外的进程。Claude Code 直接用 `run_command` 调 CLI。

## 手动使用

```bash
node antigravity-bridge.js discover
node antigravity-bridge.js start-cascade
node antigravity-bridge.js send-and-wait --cascade <id> --message "..."
node antigravity-bridge.js delete --cascade <id>
```

## 前置要求

- Node.js 18+
- Antigravity IDE 正在运行且有项目打开

## License

MIT
