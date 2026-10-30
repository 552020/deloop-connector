# The connector's state

Run `npx -y github:552020/deloop-connector status` (or, if it is installed, `node ~/.deloop/app/cli.mjs status`, which needs no network). It prints, line by line: the person's address, the agent's account and whether it is logged in, whether the connector runs, autostart, the model that answers, the agent's directory, the last wakes.

Tell the person what matters, in plain words:

- "not running" with autostart on: the service did not start; show the last lines of `~/.deloop/connector.log`.
- "not logged in": the agent's session ended; `/deloop setup` again.
- "the old service of the bridge": run `npx github:552020/deloop-connector update`.
- A line "Wake failed: …" in the log: the agent was woken and could not answer. "Not logged in · Please run /login" means Claude Code is not logged in for the service: they run `claude` once in a terminal and `/login`.
- The `deloop` MCP tools answer only while the connector runs; `list_sessions` shows its sessions.
