#!/bin/sh
# Wake command for a Claude Code model: one headless run per new message.
# The run sees only the connector's tools (no files, no shell) and exits when done.
# WAKE_MODEL picks the model (default sonnet). --setting-sources "" keeps every CLAUDE.md out,
# the owner's own ~/.claude/CLAUDE.md included: the run gets the instructions and nothing else.
# WAKE_LOG, if set, is a file that gets one JSON line per wake (cost, tokens, time).
cd "$(dirname "$0")"
. ./wake-context.sh

out=$(claude -p "New message in Matrix room $DELOOP_ROOM (session: ${DELOOP_SESSION:-none}, kind: ${DELOOP_KIND:-plain room}) from $DELOOP_SENDER:

$DELOOP_BODY

Read the room with the deloop tools and reply if a reply is due." \
  --model "${WAKE_MODEL:-sonnet}" \
  --setting-sources "" \
  --append-system-prompt-file "$WAKE_INSTRUCTIONS" \
  --mcp-config "{\"mcpServers\":{\"deloop\":{\"type\":\"http\",\"url\":\"http://127.0.0.1:${CONNECTOR_PORT:-7420}/mcp\"}}}" \
  --strict-mcp-config \
  --allowedTools "mcp__deloop__*" \
  --output-format json)
rm -f "$WAKE_INSTRUCTIONS"

[ -n "$WAKE_LOG" ] && printf '%s\n' "$out" | node -e '
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  let r = {}; try { r = JSON.parse(s); } catch {}
  console.log(JSON.stringify({ at: new Date().toISOString(), room: process.env.DELOOP_ROOM, kind: process.env.DELOOP_KIND, sender: process.env.DELOOP_SENDER,
    cost: r.total_cost_usd, ms: r.duration_ms, turns: r.num_turns, models: Object.keys(r.modelUsage ?? {}), usage: r.usage }));
});' >> "$WAKE_LOG"
exit 0
