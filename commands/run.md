---
description: Run an Antigravity IDE Agent task. Use when you want to send a coding task to the Antigravity Agent and wait for completion.
---

## Antigravity Bridge — Run Task

Discover the running Antigravity instance, create a cascade, send a task, and return results.

### Steps

1. Call the `antigravity_discover` MCP tool to find the running Antigravity IDE.
2. Call `antigravity_start_cascade` with `mode: "Fast"` (or `"Planning"` for complex tasks).
3. Ask the user what task they want Antigravity to perform.
4. Call `antigravity_send_and_wait` with the cascade ID and user's message.
5. Present the result to the user.
6. Call `antigravity_delete` to clean up the cascade.

### Tips

- Use `model: "Gemini 3 Flash"` for speed, `"Claude Sonnet 4.6 (Thinking)"` for quality.
- For long tasks, use `--message-file` to load instructions from a file.
- The `send_and_wait` tool uses content-stability polling (default: 7 stable polls = done).
