#!/bin/sh
# The agent on a machine the person rents under their own account (Hetzner first), for a computer too small
# for the local learner. Run once as root on a fresh Ubuntu 24.04 or Debian 12 server, over ssh with a terminal:
#
#   ssh -t root@<server> 'curl -fsSL https://raw.githubusercontent.com/552020/deloop-connector/main/vps/setup.sh | sh'
#
# It installs Node, Python, the text tools, Ollama and Claude Code; makes a user `deloop` that runs everything;
# lets that user's services run without a login (systemd linger). Then, as that user, the person runs the
# connector's setup, which asks for their password in this terminal, and logs Claude Code in.
# Deloop never sees this machine: it is the person's, on their account. The host has its disk and memory.
#
# DELOOP_NO_OLLAMA=1 leaves Ollama out (a server too small for a learner; the owner room then uses the cloud model).
set -e

[ "$(id -u)" = 0 ] || { echo "Run this as root on the server." >&2; exit 1; }
. /etc/os-release
case "$ID" in ubuntu|debian) ;; *) echo "This script knows Ubuntu and Debian; this is $ID." >&2; exit 1 ;; esac

say() { printf '\n%s\n' "$*"; }
export DEBIAN_FRONTEND=noninteractive

say "1/5 System packages: Python, the text tools for PDF and Word, git, curl."
apt-get update -qq
apt-get install -y -qq ca-certificates curl git python3 python3-venv poppler-utils pandoc >/dev/null

say "2/5 Node 22."
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node -v

if [ -z "$DELOOP_NO_OLLAMA" ]; then
  say "3/5 Ollama, for the learner (the model that reads the archive on this machine)."
  command -v ollama >/dev/null || curl -fsSL https://ollama.com/install.sh | sh
else
  say "3/5 Ollama left out."
fi

say "4/5 The user deloop, who runs the connector, and Claude Code for it."
id deloop >/dev/null 2>&1 || useradd --create-home --shell /bin/bash deloop
loginctl enable-linger deloop 2>/dev/null || true
echo "Set up by Deloop's vps/setup.sh on $(date -u +%F): a machine the person rents under their own account." > /etc/deloop-rented
npm install -g --silent @anthropic-ai/claude-code >/dev/null 2>&1 || echo "Claude Code could not be installed; Codex or another model can answer instead."
install -d -o deloop -g deloop -m 700 /home/deloop/archive /home/deloop/.ssh
# The keys that let the person in as root let them in as deloop too: for scp, and for a login whose user
# services (the connector's autostart) work, which `su` does not give.
if [ -f /root/.ssh/authorized_keys ] && [ ! -f /home/deloop/.ssh/authorized_keys ]; then
  install -o deloop -g deloop -m 600 /root/.ssh/authorized_keys /home/deloop/.ssh/authorized_keys
fi

say "5/5 Done with root. The rest is yours, as the user deloop:"
cat <<'EOF'

  ssh deloop@<server>                      # a login of its own, not su: the autostart needs it
  claude                                   # log in to Claude Code once: /login, then the link in your browser
  npx -y github:552020/deloop-connector    # your name, your agent's name, your password, autostart: yes

Your archives go into /home/deloop/archive, uploaded by you from your computer, for instance:

  scp -r ~/Documents/Projects deloop@<server>:archive/
  rsync -a ~/Library/Mail/V10/ deloop@<server>:archive/Mail/   (on macOS, with Full Disk Access for the terminal)

Then, still as deloop, in Claude Code: /plugin marketplace add 552020/deloop-connector, /plugin install deloop,
and /deloop agent, which surveys this machine, offers the learner and builds the index here.

Your agent then runs on this machine and no longer needs your computer. Stop the connector on your own
computer if it ran there (npx github:552020/deloop-connector autostart off): one bot, one place.
EOF
