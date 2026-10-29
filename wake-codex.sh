#!/bin/sh
# Wake command for a Codex brain: one non-interactive `codex exec` per new message.
# Codex has no flag for extra system instructions, so brain.md goes at the head of the prompt.
cd "$(dirname "$0")"

codex exec \
  --skip-git-repo-check \
  --sandbox read-only \
  -c "mcp_servers.deloop.url=\"http://127.0.0.1:${BRIDGE_PORT:-7420}/mcp\"" \
  "$(cat brain.md)

New message in Matrix room $DELOOP_ROOM (session: ${DELOOP_SESSION:-none}, kind: ${DELOOP_KIND:-plain room}) from $DELOOP_SENDER:

$DELOOP_BODY

Read the room with the deloop tools and reply if a reply is due." \
  > /dev/null
