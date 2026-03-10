---
name: antigravity-control
description: Guide for controlling Antigravity IDE Agent. Use when the user wants to orchestrate, delegate, or send coding tasks to the Antigravity IDE Agent. DO NOT USE when discussing general coding unrelated to Antigravity.
---

# Controlling Antigravity IDE Agent

You have access to the **Antigravity Bridge** MCP tools that let you control a running Antigravity IDE instance.

## Available Tools

| Tool | Purpose |
|------|---------|
| `antigravity_discover` | Find Antigravity process, get connection info |
| `antigravity_start_cascade` | Create a new chat/cascade session |
| `antigravity_send_and_wait` | Send a message and wait for agent completion |
| `antigravity_send_message` | Send a message (fire-and-forget, no waiting) |
| `antigravity_poll` | Check cascade status once |
| `antigravity_cancel` | Cancel a running invocation |
| `antigravity_delete` | Delete/clean up a cascade |

## Workflow Pattern

```
1. antigravity_discover   → Get connection info (auto-cached)
2. antigravity_start_cascade → Create session (get cascadeId)
3. antigravity_send_and_wait → Send task, wait for completion
4. antigravity_delete      → Clean up
```

## Best Practices

1. **Always discover first** — Connection info is cached, so subsequent calls are fast.
2. **One cascade per task** — Create a fresh cascade for each independent task.
3. **Use Planning mode** for complex architectural decisions, Fast mode for implementation.
4. **Clean up cascades** after use to avoid clutter in Antigravity's chat panel.
5. **Use message files** for long prompts — write to a temp file, pass the path.

## Model Selection

- **Gemini 3 Flash** — Fast, good for routine tasks (default)
- **Gemini 3.1 Pro (High)** — Best quality, slower
- **Claude Sonnet 4.6 (Thinking)** — Strong reasoning with think-aloud
- **Claude Opus 4.6 (Thinking)** — Maximum capability

## Multi-Agent Orchestration

You (Claude Code) can orchestrate Antigravity by:
1. Breaking a large task into sub-tasks
2. Sending each sub-task to Antigravity via separate cascades
3. Reviewing Antigravity's output and providing corrections
4. Using your own tools (file editing, terminal) alongside Antigravity's work
