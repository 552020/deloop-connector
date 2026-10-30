#!/bin/sh
# The agent's recall on this computer: an index over the paths in ~/.deloop/agent/archive.md.
#   recall.sh install          a Python venv in ~/.deloop/recall with fastembed (once; needs the network)
#   recall.sh index            builds or updates the index in the background, log in ~/.deloop/recall/index.log
#   recall.sh status           the index's state, as JSON
#   recall.sh survey PATH ...  counts and dates of a path, never its contents
#   recall.sh search "question" [k]
# The model (DELOOP_RECALL_MODEL, multilingual mpnet-base, 1 GB, by default) is downloaded on the first index run.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
DATA="${DELOOP_HOME:-$HOME/.deloop}/recall"
PY="$DATA/venv/bin/python"
cmd="${1:-status}"; [ $# -gt 0 ] && shift
case "$cmd" in
  install)
    command -v python3 >/dev/null || { echo "python3 is missing: the archive stays as paths in archive.md, without an index." >&2; exit 1; }
    mkdir -p "$DATA"; chmod 700 "$DATA"
    [ -x "$PY" ] || python3 -m venv "$DATA/venv"
    "$PY" -m pip install -q --disable-pip-version-check -r "$HERE/requirements.txt"
    echo "Installed in $DATA" ;;
  index)
    [ -x "$PY" ] || { echo "Not installed: run recall.sh install first." >&2; exit 1; }
    mkdir -p "$DATA"
    nohup "$PY" "$HERE/index.py" "$@" >>"$DATA/index.log" 2>&1 </dev/null &
    echo "Indexing in the background; log in $DATA/index.log" ;;
  status) python3 "$HERE/survey.py" --index ;;
  survey) python3 "$HERE/survey.py" "$@" ;;
  search)
    [ -x "$PY" ] || { echo "Not installed." >&2; exit 1; }
    "$PY" "$HERE/recall.py" "$@" ;;
  *) sed -n '2,8p' "$0"; exit 1 ;;
esac
