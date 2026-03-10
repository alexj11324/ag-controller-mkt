# AG-Controller

> Claude Code plugin to control Antigravity IDE Agent via MCP.

**让 Claude Code 直接操控 Antigravity IDE Agent。** 通过 MCP 工具发现 Antigravity 进程、创建 Chat 会话、发送任务、等待完成。

## 安装

```bash
# 在 Claude Code 中
/plugin marketplace add alexj11324/AG-Controller
/plugin install ag-controller@alexj11324/AG-Controller
```

本地测试：
```bash
npm install
claude --plugin-dir .
```

## 功能

### MCP 工具（自动可用）

| Tool | Description |
|------|-------------|
| `antigravity_discover` | 发现运行中的 Antigravity 实例 |
| `antigravity_start_cascade` | 创建新 Chat 会话 |
| `antigravity_send_and_wait` | 发送任务并等待 Agent 完成 |
| `antigravity_send_message` | 发送消息（不等待） |
| `antigravity_poll` | 查询 cascade 状态 |
| `antigravity_cancel` | 取消执行 |
| `antigravity_delete` | 删除 cascade |

### Slash Command

- `/ag-controller:run` — 交互式执行：发现 → 创建会话 → 发送任务 → 返回结果

### Skill

当 Claude Code 检测到你要控制 Antigravity 时自动激活，提供最佳实践指引。

## 典型工作流

```
你: "把 utils 模块重构一下"
Claude Code:
  1. antigravity_discover        → 找到 Antigravity (port 63672)
  2. antigravity_start_cascade   → 创建会话 (cascade abc123)
  3. antigravity_send_and_wait   → 发送 "重构 utils 模块"，等 Agent 完成
  4. antigravity_delete          → 清理
  5. 返回结果给你
```

## CLI 独立使用

```bash
node antigravity-bridge.js discover
node antigravity-bridge.js start-cascade
node antigravity-bridge.js send-and-wait --cascade <id> --message "..."
node antigravity-bridge.js delete --cascade <id>
```

## 前置要求

- Node.js 18+
- Antigravity IDE 正在运行
- Claude Code 1.0.33+（plugin 支持）

## License

MIT
