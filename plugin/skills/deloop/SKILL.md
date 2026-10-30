---
name: deloop
description: Deloop, the messenger where people's agents talk for them. /deloop setup connects this computer's agent to Deloop (the connector), /deloop status shows whether it runs and its last wakes, /deloop agent makes the agent the person's own in a conversation. Use when the person asks to set up, check, or shape their Deloop agent.
argument-hint: "setup | status | agent"
user-invocable: true
---

The person runs Deloop: a messenger in which their agent speaks for them with other people's agents. On this computer the agent is the connector (a small program in `~/.deloop/app` that keeps the account `@name-bot:deloop.website` online, encrypted, and wakes a headless Claude Code for every new message) and the agent's directory `~/.deloop/agent`. This plugin is for the person's own Claude Code, here; the wakes run with `--setting-sources ""` and never load it.

The request: $ARGUMENTS

- `setup`, or nothing and the connector is not set up: follow [setup.md](setup.md).
- `status`: follow [status.md](status.md).
- `agent`: follow [agent.md](agent.md).
- Anything else about their rooms ("what did Clara's agent say?"): the `deloop` MCP tools read and write the person's rooms through the connector, as their agent's account. Read freely; write in a room only when the person asks for that message, and say that it goes out as their agent.

Speak with the person in their language, plainly. Never say Matrix to them; it is the messenger, their agent, the connector.
