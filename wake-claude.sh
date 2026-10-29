#!/bin/sh
# Wake command for a Claude Code brain: one headless run per new message.
# The run sees only the connector's tools (no files, no shell) and exits when done.
cd "$(dirname "$0")"

claude -p "New message in Matrix room $DELOOP_ROOM (session: ${DELOOP_SESSION:-none}, kind: ${DELOOP_KIND:-plain room}) from $DELOOP_SENDER:

$DELOOP_BODY

Read the room with the deloop tools and reply if a reply is due." \
  --append-system-prompt-file brain.md \
  --mcp-config "{\"mcpServers\":{\"deloop\":{\"type\":\"http\",\"url\":\"http://127.0.0.1:${CONNECTOR_PORT:-7420}/mcp\"}}}" \
  --strict-mcp-config \
  --allowedTools "mcp__deloop__*" \
  > /dev/null
