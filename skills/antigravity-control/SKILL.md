---
name: antigravity-control
description: Control Antigravity IDE Agent from Claude Code using the antigravity-bridge CLI. Use when the user wants to delegate, orchestrate, or send coding tasks to a running Antigravity IDE instance. DO NOT USE for general coding tasks unrelated to Antigravity IDE control.
---

# AG-Controller: Controlling Antigravity IDE Agent

You can control a running Antigravity IDE instance using the `antigravity-bridge.js` CLI tool bundled with this plugin.

## CLI Location

The CLI is at: `~/.claude/plugins/installed/ag-controller/antigravity-bridge.js`

If that path doesn't exist, search for it:
```bash
find ~/.claude/plugins -name "antigravity-bridge.js" 2>/dev/null
```

## Quick Start

```bash
# 1. Discover the running Antigravity instance (auto-caches connection info)
node <CLI_PATH>/antigravity-bridge.js discover

# 2. Create a chat session
node <CLI_PATH>/antigravity-bridge.js start-cascade

# 3. Send a task and wait for the agent to finish
node <CLI_PATH>/antigravity-bridge.js send-and-wait \
  --cascade <cascadeId> \
  --message "Refactor the utils module" \
  --model "Gemini 3 Flash"

# 4. Clean up
node <CLI_PATH>/antigravity-bridge.js delete --cascade <cascadeId>
```

## All Sub-Commands

| Command | Purpose | Key Args |
|---------|---------|----------|
| `discover` | Find Antigravity process, cache connection info | `--workspace <path>` |
| `start-cascade` | Create a new chat session | `--mode Fast\|Planning` |
| `send-and-wait` | Send message, wait for completion | `--cascade <id> --message <text>` |
| `send` | Send message (fire-and-forget) | `--cascade <id> --message <text>` |
| `poll` | Check cascade status once | `--cascade <id>` |
| `cancel` | Cancel running invocation | `--cascade <id>` |
| `delete` | Delete cascade | `--cascade <id>` |
| `models` | List available models | (none) |

## Full Workflow Pattern

Always follow this order:

1. **Discover** — Run `discover` first. Connection info is cached to `/tmp/antigravity-bridge.json`, so subsequent calls are instant.
2. **Start Cascade** — Creates a session. Use `--mode Planning` for architecture decisions, `--mode Fast` (default) for implementation.
3. **Send and Wait** — Send the task. The tool polls until the agent's output stabilizes (default: 7 stable polls = done).
4. **Delete** — Always clean up the cascade after use.

## Model Selection

| Model | Best For |
|-------|---------|
| `Gemini 3 Flash` | Fast routine tasks (default) |
| `Gemini 3.1 Pro (High)` | Best quality, complex reasoning |
| `Claude Sonnet 4.6 (Thinking)` | Strong reasoning with think-aloud |
| `Claude Opus 4.6 (Thinking)` | Maximum capability |

## Long Messages

For long prompts, write to a temp file and use `--message-file`:

```bash
cat > /tmp/ag-task.md << 'EOF'
Your detailed instructions here...
EOF
node <CLI_PATH>/antigravity-bridge.js send-and-wait \
  --cascade <id> --message-file /tmp/ag-task.md
```

## Multi-Agent Orchestration

You (Claude Code) can orchestrate Antigravity by:
1. Breaking a large task into sub-tasks
2. Sending each sub-task to Antigravity via separate cascades
3. Reviewing Antigravity's output file changes
4. Using your own tools (file editing, terminal) alongside Antigravity's work
5. Providing corrections via follow-up `send-and-wait` calls on the same cascade

## Important Notes

- **Antigravity must be running** with a project open for `discover` to work.
- All output is **JSON** — parse it to extract `cascadeId` and other values.
- Connection info is cached — if Antigravity restarts, run `discover` again.
- The `--stable` flag controls completion sensitivity (default: 7 polls).
