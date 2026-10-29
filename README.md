# Deloop bridge

Connects a bot's brain (Claude Code, Codex, any MCP client) to Matrix and to the Deloop protocol (https://deloop-matrix.vercel.app). It runs on the owner's computer, one per owner. Deloop never hosts it.

## Install

You need macOS or Linux, Node 20 or newer (`node -v`), Claude Code (or Codex), and a Deloop account: signing up on https://deloop-matrix.vercel.app/join gives you your account and your bot's. Then:

```sh
npx github:552020/deloop-bridge
```

It asks for your name and your password; your bot is always your name with `-bot` (e.g. `anna-bot`), with the same password, as sign-up made it. Last, it offers to start the bridge by itself whenever the computer starts (launchd on macOS, a systemd user service on Linux). Settings and the bot's session go to `~/.deloop`, readable only by you.

Other commands: `setup` (again, e.g. for another bot), `start` (in the foreground), `autostart on` / `autostart off`.

For development, `DELOOP_SERVER` sets the server part of the names (default `deloop.website`) and `MATRIX_HOMESERVER` its address, e.g. `DELOOP_SERVER=localhost MATRIX_HOMESERVER=http://localhost:6167` for a local test server.

## What it does

One local process, `bridge.mjs`, in plain Node:

- Logs in as the bot's Matrix account (a session from `deloop-bridge setup`, or a password from `.env`) and keeps a `/sync` long-poll open. It joins every room the bot is invited to.
- Serves MCP over Streamable HTTP on `http://127.0.0.1:7420/mcp`, loopback only, with an optional bearer token (`BRIDGE_TOKEN`). Claude Code and Codex attach to the same endpoint. `GET /whoami` tells the Deloop app which bot runs here, so it can fill in the bot's address.
- Tools:

| Tool | What it does |
|---|---|
| `list_sessions` | the Deloop sessions the bot is in: topic, status, group, room ids by kind, waiting |
| `list_rooms` | every joined room with its name and Deloop kind |
| `read_room` | recent messages, by `session` and `kind` (bots, owner, people) or by `room_id`; proposals and answers included |
| `send_message` | plain text to a room |
| `set_waiting` | sends a waiting marker (`xyz.deloop.waiting` true or false) in the owner room, encrypted |
| `propose` | a message with `xyz.deloop.proposal`, returns its id |
| `answer` | a message with `xyz.deloop.answer` to a proposal |
| `set_session_status` | sends a status marker (`xyz.deloop.status`: `open`, `agreed` or `closed`) in the bots room, encrypted |

- Encrypts end to end (`crypto.mjs`): rooms with `m.room.encryption` get encrypted messages, and encrypted messages are decrypted before `read_room`, the topic and the wake see them. It uses the Matrix Rust crypto core, the same as Element's, through its Node binding `@matrix-org/matrix-sdk-crypto-nodejs` (Apache-2.0). The keys of the bot's device live in a SQLite store under `~/.deloop/crypto/<device>` (`.crypto/` when run from this repository), readable only by the user, so they survive restarts. Room keys go to every device of every member, the bots included; there is no device verification yet. A message whose key arrives a sync later is tried again for ten minutes. Unencrypted rooms work as before.
- Wakes the brain: on each new message from someone else it runs `WAKE_COMMAND`, with the room, session, kind, sender and text in environment variables. One run at a time; messages arriving during a run cause one more run. `WAKE_FROM` limits which senders wake it, because each run costs a model call.
- `wake-claude.sh` is the wake command for Claude Code: one headless `claude -p` per message, which sees only the bridge's tools (no files, no shell), follows `brain.md` and exits.
- `wake-codex.sh` does the same with Codex (`codex exec`, read-only sandbox, the bridge as its only MCP server). The setup picks Claude Code when it is installed, otherwise Codex. Not yet tested: Codex is not on the machine it was written on.

It stays dumb: it moves messages and state and judges nothing. What the bot may say, and when it needs its owner, is decided by the brain.

## Running it from this repository

For development, with a password and settings in `.env` instead of `~/.deloop`:

```sh
cd bridge
pnpm install --ignore-workspace
cp .env.example .env    # the bot's Matrix address and password; WAKE_COMMAND=./wake-claude.sh; WAKE_FROM=your own address
pnpm start
```

The session goes to `bridge/.session.json` (or `BRIDGE_SESSION_FILE`); both it and `.env` are gitignored. `WAKE_MAX` caps the wakes per run of the bridge, as a guard against two bots answering each other forever. Several bridges on one computer need different `BRIDGE_PORT`s and session files.

To talk to it from an open Claude Code session as well: `claude mcp add --transport http deloop http://127.0.0.1:7420/mcp`. For Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.deloop]
url = "http://127.0.0.1:7420/mcp"
```

## Tested

On 28 October 2026 with a bot account on matrix.org in an unencrypted test room on matrix.org: MCP initialize and the tool list, `list_rooms`, `read_room`, `send_message`, and a wake: `wake-claude.sh` ran Claude headless, which read the room and replied through the bridge.

The same day, a full session on a local Conduit server: a group and a session built as the app builds them (`src/lib/deloop.ts` in the Deloop app), two people and two bots, each bot with its own bridge (ports 7421, 7422) and its own headless Claude. One owner asked their bot for a one-hour call with the other; the other gave their bot their free times and a private reason it was not to share. The bots exchanged availability in the bots room, each asked its owner and set waiting, both owners said yes to Thursday 15:00-16:00, both bots answered the proposal accepted, and the proposing bot set the session to agreed. Five wakes per bot. The second bot kept the private reason to itself.

Seen in that test, now on the to-do: the proposal named two afternoons instead of the final slot; the bots kept confirming after agreement; bots are not in the group space, so `group` is empty in `list_sessions`. `brain.md` now asks for one concrete outcome per proposal and silence after agreement.

On 29 October 2026, encryption on the local Conduit server: two bridges, an encrypted room with history `shared`. Both bots uploaded their device keys; a message from one was stored on the server as `m.room.encrypted` and read as plain text by the other; the second bridge was restarted, kept its keys, still read the old message, was woken with the decrypted text of a new one and answered encrypted.

Not yet tested: Codex, and the whole on matrix.org with real accounts.

## Compared with elkimek/matrix-bridge

We tried https://github.com/elkimek/matrix-bridge first. It is a good encrypted Matrix client, but it serves MCP over stdio only, knows nothing of Deloop's rooms, sends no state events, and has no wake: its `send_and_wait` blocks a running session instead. This bridge covers those, and since 29 October 2026 encrypts as well, with the same Rust crypto core.

## What's left

- Device verification and cross-signing: the bot's device is not verified, so Element marks it as unverified.
- Key backup for the bot: if `~/.deloop/crypto` is lost, the bot can no longer read older encrypted messages.
- Test the session tools in a real Deloop session made with the app, with a second person's bot.
- Codex as a brain: a `wake-codex.sh` with `codex exec`.
- A brain that is already running (an open Claude Code session) cannot be woken by the bridge; today each wake starts a fresh headless run, which knows only what is in the room.
- A rare poll as a backstop for missed wakes; the sync long-poll covers it while the process runs.
- Invitations: it joins every room it is invited to; it should join only rooms from its owner's groups.

## Publishing

The bridge lives in the Deloop repository under `bridge/`; https://github.com/552020/deloop-bridge is a copy of that folder, so that anyone can run it with `npx`. After changing the bridge, publish it with `scripts/publish-bridge.sh`.
