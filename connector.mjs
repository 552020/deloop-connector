import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { startCrypto } from "./crypto.mjs";

const HOMESERVER = process.env.MATRIX_HOMESERVER ?? "https://matrix-client.matrix.org";
const USER = process.env.MATRIX_USER;
const PASSWORD = process.env.MATRIX_PASSWORD;
const PORT = Number(process.env.CONNECTOR_PORT ?? 7420);
const TOKEN = process.env.CONNECTOR_TOKEN || null;
const WAKE_COMMAND = process.env.WAKE_COMMAND || null;
// Senders whose messages wake the brain; empty means everyone. Each wake costs a model run.
const WAKE_FROM = (process.env.WAKE_FROM ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const SESSION_FILE = process.env.CONNECTOR_SESSION_FILE || new URL("./.session.json", import.meta.url);
// The encryption keys of this bot's device; readable only by the user.
const CRYPTO_DIR = process.env.CONNECTOR_CRYPTO_DIR || new URL("./.crypto", import.meta.url).pathname;
// Upper bound on wakes per run of the connector, as a guard against two bots answering each other forever.
const WAKE_MAX = Number(process.env.WAKE_MAX || Infinity);
let wakes = 0;


// ---------- Matrix client ----------

let session;
let crypto; // see crypto.mjs; set after login

async function api(method, path, body) {
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data.errcode ?? ""} ${data.error ?? ""}`.trim());
  return data;
}

// Each password login creates a device on the account, so the session is reused across runs.
async function login() {
  try {
    session = JSON.parse(await readFile(SESSION_FILE, "utf8"));
    await api("GET", "/account/whoami");
    return;
  } catch {
    session = undefined;
  }
  // Without a password the session comes from the browser login of `deloop-connector setup`.
  if (!USER || !PASSWORD) {
    console.error("Not logged in: run `npx github:552020/deloop-connector setup`, or set MATRIX_USER and MATRIX_PASSWORD in connector/.env");
    process.exit(1);
  }
  session = await api("POST", "/login", {
    type: "m.login.password",
    identifier: { type: "m.id.user", user: USER },
    password: PASSWORD,
    initial_device_display_name: "deloop connector",
  });
  await writeFile(SESSION_FILE, JSON.stringify(session, null, 2));
}

const room = (id) => `/rooms/${encodeURIComponent(id)}`;
const txn = () => `${Date.now()}-${randomUUID()}`;

// Room state of every joined room, kept current by the sync loop: roomId -> Map("type|key" -> content).
const rooms = new Map();

function applyState(roomId, events = []) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Map());
  const state = rooms.get(roomId);
  for (const e of events) if (e.state_key !== undefined) state.set(`${e.type}|${e.state_key}`, e.content);
}

const stateOf = (roomId, type, key = "") => rooms.get(roomId)?.get(`${type}|${key}`);

function childrenOf(spaceId) {
  const out = [];
  for (const [k, content] of rooms.get(spaceId) ?? []) {
    if (k.startsWith("m.space.child|") && content?.via) out.push(k.slice("m.space.child|".length));
  }
  return out;
}

function parentsOf(roomId) {
  const out = [];
  for (const [k] of rooms.get(roomId) ?? []) if (k.startsWith("m.space.parent|")) out.push(k.slice("m.space.parent|".length));
  return out;
}

// The session space a room belongs to, if any.
function sessionOf(roomId) {
  for (const [id] of rooms) if (stateOf(id, "xyz.deloop.session") && childrenOf(id).includes(roomId)) return id;
  return parentsOf(roomId).find((p) => stateOf(p, "xyz.deloop.session")) ?? null;
}

// The topic is the first bots-room message marked xyz.deloop.topic (docs/protocol.md). Seen ones are
// kept here, missing ones fetched once.
const topics = new Map();

async function fetchTopics() {
  for (const s of sessions()) {
    if (topics.has(s.session) || !s.rooms.bots) continue;
    const data = await api("GET", `${room(s.rooms.bots)}/messages?dir=f&limit=20`).catch(() => null);
    const events = await Promise.all((data?.chunk ?? []).map((ev) => clear(s.rooms.bots, ev)));
    // The first one this bot can read: a late member has no key for the first, but for its re-send.
    const e = events.find((ev) => ev.type === "m.room.message" && ev.content?.["xyz.deloop.topic"]);
    if (e) topics.set(s.session, e.content.body);
  }
}

// Status and waiting are encrypted marker messages (docs/protocol.md): the latest bots-room message
// with xyz.deloop.status, the latest owner-room message with xyz.deloop.waiting. Seen ones are kept
// here by room, missing ones fetched once.
const markers = new Map(); // roomId -> { status?, waiting? }

function noteMarker(roomId, content) {
  const m = markers.get(roomId) ?? {};
  if (typeof content?.["xyz.deloop.status"] === "string") m.status = content["xyz.deloop.status"];
  if (typeof content?.["xyz.deloop.waiting"] === "boolean") m.waiting = content["xyz.deloop.waiting"];
  markers.set(roomId, m);
}

const isMarker = (content) => content?.["xyz.deloop.status"] !== undefined || content?.["xyz.deloop.waiting"] !== undefined;

async function fetchMarkers() {
  for (const s of sessions()) {
    for (const [kind, key] of [["bots", "xyz.deloop.status"], ["owner", "xyz.deloop.waiting"]]) {
      const rid = s.rooms[kind];
      if (!rid || markers.get(rid)?.[key.slice(11)] !== undefined || markers.get(rid)?.fetched?.includes(key)) continue;
      const data = await api("GET", `${room(rid)}/messages?dir=b&limit=100`).catch(() => null);
      const events = await Promise.all((data?.chunk ?? []).map((ev) => clear(rid, ev)));
      const e = events.find((ev) => ev.type === "m.room.message" && ev.content?.[key] !== undefined); // newest first
      if (e) noteMarker(rid, e.content);
      const m = markers.get(rid) ?? {};
      m.fetched = [...(m.fetched ?? []), key];
      markers.set(rid, m);
    }
  }
}

function sessions() {
  const list = [];
  for (const [id] of rooms) {
    const meta = stateOf(id, "xyz.deloop.session");
    if (!meta) continue;
    const roomIds = {};
    for (const [rid] of rooms) {
      const kind = stateOf(rid, "xyz.deloop.room")?.kind;
      if (kind && sessionOf(rid) === id) roomIds[kind] = rid;
    }
    const group = parentsOf(id).find((p) => stateOf(p, "xyz.deloop.group"));
    list.push({
      session: id,
      topic: topics.get(id) ?? null,
      status: markers.get(roomIds.bots)?.status ?? "open",
      main: meta.main === true, // the group's main chat: the ongoing conversation, not a matter to settle
      group: group ?? null,
      group_name: group ? stateOf(group, "m.room.name")?.name ?? null : null,
      rooms: roomIds,
      owner: roomIds.owner ? stateOf(roomIds.owner, "xyz.deloop.room")?.owner ?? null : null,
      waiting: roomIds.owner ? markers.get(roomIds.owner)?.waiting ?? false : false,
    });
  }
  return list;
}

function roomFor(sessionId, kind) {
  for (const [rid] of rooms) {
    if (stateOf(rid, "xyz.deloop.room")?.kind === kind && sessionOf(rid) === sessionId) return rid;
  }
  throw new Error(`No ${kind} room joined for session ${sessionId}`);
}

// A room is addressed either by (session, kind) as in the protocol, or by room_id for plain rooms.
function target({ session: s, kind, room_id }) {
  if (room_id) return room_id;
  if (s && kind) return roomFor(s, kind);
  throw new Error("Give either session and kind, or room_id");
}

async function readMessages(roomId, limit) {
  const data = await api("GET", `${room(roomId)}/messages?dir=b&limit=${limit}`);
  const events = await Promise.all(data.chunk.map((e) => clear(roomId, e)));
  return events
    .filter((e) => e.type === "m.room.message" || e.type === "m.room.encrypted")
    .reverse()
    .map((e) => ({
      sender: e.sender,
      time: new Date(e.origin_server_ts).toISOString(),
      body: e.type === "m.room.encrypted" ? "[encrypted: this bot has no key for this message]" : e.content.body,
      ...(e.content["xyz.deloop.topic"] && { topic: true }),
      ...(e.content["xyz.deloop.status"] !== undefined && { status: e.content["xyz.deloop.status"] }),
      ...(e.content["xyz.deloop.waiting"] !== undefined && { waiting: e.content["xyz.deloop.waiting"] }),
      ...(e.content["xyz.deloop.proposal"] && { proposal: e.content["xyz.deloop.proposal"] }),
      ...(e.content["xyz.deloop.answer"] && { answer: e.content["xyz.deloop.answer"] }),
    }));
}

// An event with an encrypted one replaced by its plaintext; unchanged if its key has not arrived.
async function clear(roomId, e) {
  if (e.type !== "m.room.encrypted") return e;
  const plain = await crypto.decrypt(roomId, e);
  return plain ? { ...e, ...plain } : e;
}

const encrypted = (roomId) => !!stateOf(roomId, "m.room.encryption");

// Who gets the room key: the joined members, and the invited ones unless history is "joined".
function members(roomId) {
  const visibility = stateOf(roomId, "m.room.history_visibility")?.history_visibility ?? "shared";
  const ok = visibility === "joined" ? ["join"] : ["join", "invite"];
  const out = [];
  for (const [k, content] of rooms.get(roomId) ?? []) {
    if (k.startsWith("m.room.member|") && ok.includes(content?.membership)) out.push(k.slice("m.room.member|".length));
  }
  return { users: out, visibility };
}

async function sendMessage(roomId, text, extra = {}) {
  const content = { msgtype: "m.text", body: text, ...extra };
  if (!encrypted(roomId)) {
    const { event_id } = await api("PUT", `${room(roomId)}/send/m.room.message/${txn()}`, content);
    return event_id;
  }
  const { users, visibility } = members(roomId);
  const sealed = await crypto.encrypt(roomId, "m.room.message", content, users, visibility);
  const { event_id } = await api("PUT", `${room(roomId)}/send/m.room.encrypted/${txn()}`, sealed);
  return event_id;
}

// ---------- Wake ----------

// MCP only lets the brain call the connector. To reach a brain that is not running, the connector runs
// WAKE_COMMAND on new messages: one run at a time, further messages during a run cause one more run.
let waking = false;
let pending = null;

function wake(ctx) {
  if (!WAKE_COMMAND || (WAKE_FROM.length && !WAKE_FROM.includes(ctx.sender))) return;
  if (wakes >= WAKE_MAX) {
    console.log(`Wake skipped: limit of ${WAKE_MAX} reached`);
    return;
  }
  if (waking) {
    pending = ctx;
    return;
  }
  waking = true;
  wakes++;
  console.log(`Wake: ${ctx.sender} in ${ctx.kind ?? ctx.room}`);
  const child = spawn(WAKE_COMMAND, {
    shell: true,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      MATRIX_PASSWORD: "",
      DELOOP_ROOM: ctx.room,
      DELOOP_SESSION: ctx.session ?? "",
      DELOOP_KIND: ctx.kind ?? "",
      DELOOP_SENDER: ctx.sender,
      DELOOP_BODY: ctx.body,
    },
  });
  child.on("exit", () => {
    waking = false;
    if (pending) {
      const next = pending;
      pending = null;
      wake(next);
    }
  });
}

// ---------- Sync loop ----------

async function syncLoop() {
  const filter = encodeURIComponent(JSON.stringify({ room: { timeline: { limit: 1 } } }));
  let since;
  {
    const first = await api("GET", `/sync?timeout=0&filter=${filter}`);
    since = first.next_batch;
    await crypto.receiveSync(first);
    for (const [id, r] of Object.entries(first.rooms?.join ?? {})) {
      applyState(id, r.state?.events);
      applyState(id, r.timeline?.events);
    }
    for (const id of Object.keys(first.rooms?.invite ?? {})) await join(id);
    const people = new Set([...rooms.keys()].filter(encrypted).flatMap((id) => members(id).users));
    await crypto.track([...people]);
  }
  console.log(`Synced ${rooms.size} rooms, ${sessions().length} Deloop sessions, ${[...rooms.keys()].filter(encrypted).length} encrypted`);

  for (;;) {
    try {
      const sync = await api("GET", `/sync?timeout=30000&since=${encodeURIComponent(since)}`);
      since = sync.next_batch;
      await crypto.receiveSync(sync); // first: the to-device messages bring the keys for this timeline
      for (const id of Object.keys(sync.rooms?.invite ?? {})) await join(id);
      for (const [id, r] of Object.entries(sync.rooms?.join ?? {})) {
        applyState(id, r.state?.events);
        applyState(id, r.timeline?.events);
        for (const e of r.timeline?.events ?? []) await onEvent(id, e);
      }
      await retryUndecrypted();
      for (const id of Object.keys(sync.rooms?.leave ?? {})) rooms.delete(id);
    } catch (err) {
      console.error(err.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// A new message: markers are kept, also this bot's own; from someone else, the topic is kept and
// anything else wakes the brain.
async function onEvent(roomId, event) {
  const e = await clear(roomId, event);
  if (e.type === "m.room.encrypted") {
    if (event.sender !== session.user_id) undecrypted.push({ roomId, event, at: Date.now() });
    return;
  }
  if (e.type !== "m.room.message") return;
  if (isMarker(e.content)) {
    noteMarker(roomId, e.content);
    return;
  }
  if (event.sender === session.user_id) return;
  if (e.content?.["xyz.deloop.topic"]) {
    const s = sessionOf(roomId);
    if (s) topics.set(s, e.content.body);
    return;
  }
  wake({ room: roomId, session: sessionOf(roomId), kind: stateOf(roomId, "xyz.deloop.room")?.kind, sender: e.sender, body: e.content?.body ?? "" });
}

// A room key can arrive a sync after its message. Undecrypted messages are tried again after
// each sync, for ten minutes.
let undecrypted = [];

async function retryUndecrypted() {
  const waiting = undecrypted.filter((u) => Date.now() - u.at < 10 * 60_000);
  undecrypted = [];
  for (const u of waiting) {
    const e = await clear(u.roomId, u.event);
    if (e.type === "m.room.encrypted") undecrypted.push(u);
    else await onEvent(u.roomId, u.event);
  }
}

async function join(roomId) {
  try {
    await api("POST", `/join/${encodeURIComponent(roomId)}`, {});
    const state = await api("GET", `${room(roomId)}/state`);
    applyState(roomId, state);
    console.log(`Joined ${roomId}`);
  } catch (err) {
    console.error(`Join ${roomId}: ${err.message}`);
  }
}

// ---------- MCP tools ----------

const json = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const kind = z.enum(["bots", "owner", "people"]);
const where = {
  session: z.string().optional().describe("Session space id, from list_sessions"),
  kind: kind.optional().describe("Which of the session's three chats"),
  room_id: z.string().optional().describe("A plain room id, instead of session and kind"),
};

function mcpServer() {
  const server = new McpServer({ name: "deloop-connector", version: "0.1.0" });

  server.registerTool(
    "list_sessions",
    { description: "The Deloop sessions this bot is in: topic, status, whether it is the group's main chat, group, the ids of its rooms by kind, and whether the owner is being waited for." },
    async () => {
      await fetchTopics();
      await fetchMarkers();
      return json(sessions());
    },
  );

  server.registerTool(
    "list_rooms",
    { description: "Every room this bot has joined, with its name and Deloop kind if any." },
    async () =>
      json(
        [...rooms.keys()].map((id) => ({
          room_id: id,
          name: stateOf(id, "m.room.name")?.name ?? null,
          kind: stateOf(id, "xyz.deloop.room")?.kind ?? null,
          session: sessionOf(id),
        })),
      ),
  );

  server.registerTool(
    "read_room",
    { description: "Recent messages of a room, oldest first, with any proposal or answer attached.", inputSchema: { ...where, limit: z.number().int().min(1).max(100).default(20) } },
    async (args) => json(await readMessages(target(args), args.limit)),
  );

  server.registerTool(
    "send_message",
    { description: "Send a plain text message to a room.", inputSchema: { ...where, text: z.string() } },
    async (args) => json({ event_id: await sendMessage(target(args), args.text) }),
  );

  server.registerTool(
    "set_waiting",
    { description: "Set or clear waiting in the session's owner room: true while the bot needs its owner, false once they have answered. Sent as an encrypted marker message, which the app does not show in the chat.", inputSchema: { session: z.string(), waiting: z.boolean() } },
    async ({ session: s, waiting }) => {
      const rid = roomFor(s, "owner");
      await sendMessage(rid, waiting ? "Waiting for you." : "Carrying on.", { "xyz.deloop.waiting": waiting });
      noteMarker(rid, { "xyz.deloop.waiting": waiting });
      return json({ ok: true });
    },
  );

  server.registerTool(
    "propose",
    { description: "Post a proposal in the session's bots room. Returns its id, which answers refer to.", inputSchema: { session: z.string(), text: z.string() } },
    async ({ session: s, text }) => {
      const id = randomUUID();
      const event_id = await sendMessage(roomFor(s, "bots"), text, { "xyz.deloop.proposal": { id } });
      return json({ proposal: id, event_id });
    },
  );

  server.registerTool(
    "answer",
    { description: "Post this bot's answer to a proposal in the bots room, after the owner has decided in the owner room.", inputSchema: { session: z.string(), proposal: z.string(), accepted: z.boolean(), text: z.string() } },
    async ({ session: s, proposal, accepted, text }) => {
      const event_id = await sendMessage(roomFor(s, "bots"), text, { "xyz.deloop.answer": { proposal, accepted } });
      return json({ event_id });
    },
  );

  server.registerTool(
    "set_session_status",
    { description: "Set the session's status, e.g. agreed once every bot has accepted the same proposal. Sent as an encrypted marker message in the bots room, which the app does not show in the chat.", inputSchema: { session: z.string(), status: z.enum(["open", "agreed", "closed"]) } },
    async ({ session: s, status }) => {
      const rid = roomFor(s, "bots");
      await sendMessage(rid, `Session ${status}.`, { "xyz.deloop.status": status });
      noteMarker(rid, { "xyz.deloop.status": status });
      return json({ ok: true });
    },
  );

  return server;
}

// ---------- HTTP ----------

// Pages allowed to ask the connector which bot it runs, so the app can fill in the bot's address.
const APP_ORIGINS = ["https://deloop-matrix.vercel.app", "http://localhost:3000"];

function whoami(req, res) {
  const origin = req.headers.origin;
  if (origin && !APP_ORIGINS.includes(origin)) {
    res.writeHead(403).end();
    return;
  }
  const cors = origin ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Private-Network": "true", Vary: "Origin" } : {};
  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...cors, "Access-Control-Allow-Methods": "GET" }).end();
    return;
  }
  res.writeHead(200, { ...cors, "Content-Type": "application/json" }).end(JSON.stringify({ bot: session.user_id, owner: process.env.DELOOP_OWNER || null }));
}

const http = createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  if (path === "/whoami") return whoami(req, res);
  if (path !== "/mcp") {
    res.writeHead(404).end();
    return;
  }
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
    res.writeHead(401).end();
    return;
  }
  let body;
  if (req.method === "POST") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try {
      body = JSON.parse(Buffer.concat(chunks).toString() || "null");
    } catch {
      res.writeHead(400).end();
      return;
    }
  }
  // Stateless: a fresh server and transport per request.
  const server = mcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
});

await login();
console.log(`Logged in as ${session.user_id}`);
if (!session.device_id) session.device_id = (await api("GET", "/account/whoami")).device_id;
crypto = await startCrypto({ api, userId: session.user_id, deviceId: session.device_id, dir: CRYPTO_DIR });
http.listen(PORT, "127.0.0.1", () => console.log(`MCP on http://127.0.0.1:${PORT}/mcp`));
syncLoop();
