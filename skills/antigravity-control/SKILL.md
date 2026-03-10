---
name: antigravity-control
description: Control Antigravity IDE Agent from Claude Code using the antigravity-bridge CLI. Use when the user wants to delegate, orchestrate, or send coding tasks to a running Antigravity IDE instance. DO NOT USE for general coding tasks unrelated to Antigravity IDE control.
---

# AG-Controller: Controlling Antigravity IDE Agent

You can control a running Antigravity IDE instance using the `antigravity-bridge.js` CLI.

## CRITICAL: Before First Use

**ALWAYS run `--help` first** to confirm exact command names. Do NOT guess commands.

```bash
node <CLI_PATH>/antigravity-bridge.js --help
```

## CLI Location

Find it at one of these paths:
```bash
# Check marketplace path first
ls ~/.claude/plugins/marketplaces/*/antigravity-bridge.js 2>/dev/null
# Or installed path
ls ~/.claude/plugins/installed/*/antigravity-bridge.js 2>/dev/null
```

## Exact Commands (DO NOT modify these names)

```bash
# Step 1: Discover Antigravity (MUST run first)
node <CLI> discover --workspace /path/to/project

# Step 2: Create session (command is "start-cascade", NOT "create" or "create-cascade")
node <CLI> start-cascade

# Step 3: Send task and wait (parse cascadeId from step 2's JSON output)
node <CLI> send-and-wait --cascade <cascadeId> --message "your task here"

# Step 4: Clean up
node <CLI> delete --cascade <cascadeId>
```

## Command Reference

**EXACT command names** — use these precisely, no variations:

| Command | Purpose |
|---------|---------|
| `discover` | Find Antigravity process |
| `start-cascade` | Create chat session |
| `send-and-wait` | Send + wait for completion |
| `send` | Send (no wait) |
| `poll` | Check status once |
| `cancel` | Cancel running task |
| `delete` | Delete cascade |
| `models` | List models |

## Key Args

- `--workspace <path>` — target project directory
- `--cascade <id>` — cascade ID from `start-cascade` output
- `--message "text"` — task to send
- `--message-file <path>` — read task from file (for long prompts)
- `--model "Gemini 3 Flash"` — model selection (default: Gemini 3 Flash)
- `--mode Fast|Planning` — Fast for code, Planning for architecture

## Output Format

All output is JSON. Parse it to extract values:
```json
// start-cascade output:
{"cascadeId": "abc-123", "mode": "Fast"}
// send-and-wait output:
{"status": "completed", "cascade": "abc-123", "responseLength": 12345, "response": "..."}
```

## Models

- `Gemini 3 Flash` — fast, default
- `Gemini 3.1 Pro (High)` — best quality
- `Claude Sonnet 4.6 (Thinking)` — strong reasoning
- `Claude Opus 4.6 (Thinking)` — maximum capability
