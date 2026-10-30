#!/usr/bin/env node
// Wake command for the local learner: an owner-room wake answered by a model in Ollama on this computer,
// so what the agent reads in its archive never leaves it. One run per message, like wake-claude.sh.
// It speaks to Ollama's chat API itself, with the connector's owner-room tools as function calls; the
// connector still refuses whatever an owner-room wake may not do. Rooms with others stay on the cloud model
// (WAKE_COMMAND); this is WAKE_OWNER_COMMAND.
// OLLAMA_MODEL picks the model (setup takes it from recall/machine.py), OLLAMA_HOST the server.
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OLLAMA = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, "");
const MODEL = process.env.OLLAMA_MODEL || "qwen3:8b";
const STEPS = Number(process.env.WAKE_STEPS || 12);
// What the learner may call: reading its rooms and archive, writing to its owner, remembering.
const TOOLS = ["list_sessions", "read_room", "send_message", "set_waiting", "search_archive", "remember"];

const env = process.env;
// The same instructions as every wake (wake-context.sh), written to a temporary file.
const file = execFileSync("/bin/sh", ["-c", '. ./wake-context.sh && printf %s "$WAKE_INSTRUCTIONS"'], { cwd: HERE, env }).toString().trim();
const system = readFileSync(file, "utf8");
rmSync(file, { force: true });

const mcp = new Client({ name: "deloop-wake-ollama", version: "0.1.0" });
await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${env.CONNECTOR_PORT || 7420}/mcp`)));
const tools = (await mcp.listTools()).tools
  .filter((t) => TOOLS.includes(t.name))
  .map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));

const messages = [
  { role: "system", content: system },
  {
    role: "user",
    content: `New message in Matrix room ${env.DELOOP_ROOM} (session: ${env.DELOOP_SESSION || "none"}, kind: ${env.DELOOP_KIND || "plain room"}) from ${env.DELOOP_SENDER}:\n\n${env.DELOOP_BODY}\n\nRead the room with the deloop tools and reply if a reply is due.`,
  },
];

const started = Date.now();
let steps = 0;
let calls = 0;
try {
  for (; steps < STEPS; steps++) {
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages, tools, stream: false, options: { temperature: 0.2 } }),
    });
    if (!res.ok) throw new Error(`Ollama answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const { message } = await res.json();
    messages.push(message);
    if (!message.tool_calls?.length) break;
    for (const call of message.tool_calls) {
      const { name, arguments: args } = call.function;
      calls++;
      let text;
      if (!TOOLS.includes(name)) text = JSON.stringify({ ok: false, error: `No tool ${name} in this wake.` });
      else {
        try {
          const r = await mcp.callTool({ name, arguments: typeof args === "string" ? JSON.parse(args) : args });
          text = r.content?.map((c) => c.text ?? "").join("\n") ?? "";
        } catch (e) {
          text = JSON.stringify({ ok: false, error: e.message });
        }
      }
      messages.push({ role: "tool", tool_name: name, content: text });
    }
  }
} catch (e) {
  console.error(`Wake failed: ${e.message}`);
}
await mcp.close();

if (env.WAKE_LOG)
  appendFileSync(env.WAKE_LOG, JSON.stringify({ at: new Date().toISOString(), room: env.DELOOP_ROOM, kind: env.DELOOP_KIND, sender: env.DELOOP_SENDER, cost: 0, ms: Date.now() - started, turns: steps + 1, calls, models: [`ollama:${MODEL}`] }) + "\n");
process.exit(0);
