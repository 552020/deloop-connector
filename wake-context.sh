# Sourced by the wake scripts: writes the run's instructions to a temporary file, $WAKE_INSTRUCTIONS:
# instructions.md (the agent directory's copy, if there is one), then today's date and the owner's time zone, then the owner's context for the
# matter (WAKE_CONTEXT, a file: what the owner gave, up to which level, and the mandate), if any.
TZ_NAME="${DELOOP_TIMEZONE:-$(readlink /etc/localtime 2>/dev/null | sed 's|.*zoneinfo/||')}"
TZ_NAME="${TZ_NAME:-UTC}"
WAKE_INSTRUCTIONS=$(mktemp "${TMPDIR:-/tmp}/deloop-wake.XXXXXX")
{
  if [ -n "$DELOOP_AGENT_DIR" ] && [ -f "$DELOOP_AGENT_DIR/instructions.md" ]; then cat "$DELOOP_AGENT_DIR/instructions.md"; else cat instructions.md; fi
  printf '\n## This wake\n\nToday is %s, in your owner'"'"'s time zone, %s.\n' "$(TZ="$TZ_NAME" date '+%A %-d %B %Y, %H:%M')" "$TZ_NAME"
  if [ -n "$WAKE_CONTEXT" ] && [ -f "$WAKE_CONTEXT" ]; then
    printf '\n## What your owner gave you\n\n'
    cat "$WAKE_CONTEXT"
  else
    printf '\n## What your owner gave you\n\nNothing beyond what they write in the owner room.\n'
  fi
} > "$WAKE_INSTRUCTIONS"
