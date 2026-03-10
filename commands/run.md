---
description: Send a coding task to the Antigravity IDE Agent and wait for completion.
---

## AG-Controller: Run Task

Use the `antigravity-bridge.js` CLI to delegate a task to the running Antigravity IDE Agent.

### Steps

1. Find the CLI path:
   ```bash
   find ~/.claude/plugins -name "antigravity-bridge.js" 2>/dev/null
   ```

2. Discover the Antigravity instance:
   ```bash
   node <CLI_PATH> discover
   ```

3. Create a cascade:
   ```bash
   node <CLI_PATH> start-cascade
   ```
   Parse the JSON output to get `cascadeId`.

4. Ask the user what task they want Antigravity to perform.

5. Send and wait:
   ```bash
   node <CLI_PATH> send-and-wait --cascade <cascadeId> --message "<user's task>"
   ```

6. Clean up:
   ```bash
   node <CLI_PATH> delete --cascade <cascadeId>
   ```

7. Report the result to the user.
