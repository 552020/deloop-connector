import { createServer } from "node:http";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname as dirnameOf, join as joinPath } from "node:path";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { startCrypto } from "./crypto.mjs";
import { hasFolder, ownerFolder, slice } from "./slice.mjs";

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
// The agent's directory (docs/agent.md): catalogue, mandate, memory. Without it, WAKE_CONTEXT as given.
const AGENT_DIR = process.env.DELOOP_AGENT_DIR || "";
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
    if (e) noteTopic(s.session, e.content);
  }
}

// A side session's topic message also says which session it continues (protocol, Side sessions).
const origins = new Map(); // session id -> the session it was opened from
function noteTopic(sessionId, content) {
  topics.set(sessionId, content.body);
  if (typeof content["xyz.deloop.from"] === "string") origins.set(sessionId, content["xyz.deloop.from"]);
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

// Markers are data, not turns: none of them wakes the agent (the side request, its answer and the announcement included).
const isMarker = (content) => ["xyz.deloop.status", "xyz.deloop.waiting", "xyz.deloop.side", "xyz.deloop.side_opened"].some((k) => content?.[k] !== undefined);

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
      from: origins.get(id) ?? null, // a side session: the session it continues
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
      ...(e.content["xyz.deloop.side"] && { side: e.content["xyz.deloop.side"] }),
      ...(e.content["xyz.deloop.side_opened"] && { side_opened: e.content["xyz.deloop.side_opened"] }),
      ...(e.content["xyz.deloop.from"] && { from: e.content["xyz.deloop.from"] }),
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
// The kind of room the running wake came from, and whether it has read the archive. The archive and
// memory tools answer only an owner-room wake (or no wake: the owner's own Claude Code); a wake that has
// read the archive may write only to owner rooms, so nothing of it reaches others but through the catalogue.
let wakeKind = null;
let archiveRead = false;

// What of the agent's directory this wake carries, as a file for wake-context.sh: from the owner room the
// whole directory; from any other room the slice for the other people present (slice.mjs), cut here,
// before any model runs. The people of a room are its members other than bots (power level 50) and the owner.
function wakeContext(ctx) {
  if (!hasFolder(AGENT_DIR)) return null;
  let text;
  if (ctx.kind === "owner") text = ownerFolder(AGENT_DIR);
  else {
    const rid = ctx.kind === "people" || !ctx.session ? ctx.room : roomFor(ctx.session, "bots");
    const levels = stateOf(rid, "m.room.power_levels")?.users ?? {};
    const owner = process.env.DELOOP_OWNER || "";
    const people = [];
    for (const [k, content] of rooms.get(rid) ?? []) {
      if (!k.startsWith("m.room.member|") || !["join", "invite"].includes(content?.membership)) continue;
      const who = k.slice("m.room.member|".length);
      if (who !== session.user_id && who !== owner && levels[who] !== 50) people.push(who);
    }
    text = slice(AGENT_DIR, people);
  }
  const file = joinPath(tmpdir(), `deloop-context-${process.pid}-${wakes}.md`);
  writeFileSync(file, text);
  return file;
}

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
  wakeKind = ctx.kind ?? "plain";
  archiveRead = false;
  wakes++;
  console.log(`Wake: ${ctx.sender} in ${ctx.kind ?? ctx.room}`);
  const context = wakeContext(ctx);
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
      ...(context && { WAKE_CONTEXT: context }),
    },
  });
  child.on("exit", () => {
    if (context) rm(context, { force: true });
    waking = false;
    wakeKind = null;
    archiveRead = false;
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
    if (e.content["xyz.deloop.side_opened"] && event.sender === process.env.DELOOP_OWNER) await sideOpened(roomId, event.event_id, e.content["xyz.deloop.side_opened"]);
    return;
  }
  if (event.sender === session.user_id) return;
  if (e.content?.["xyz.deloop.topic"]) {
    const s = sessionOf(roomId);
    if (s) noteTopic(s, e.content);
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

// The protocol's rule for agreed, checked here rather than left to the model (first test, 30 Oct 2026:
// a bot set agreed before the other had answered): only the bot that made the latest proposal sets
// it, and only when every bot of the bots room (power level 50) has answered that proposal accepted.
async function notAgreedYet(botsRoom) {
  const messages = await readMessages(botsRoom, 100);
  const proposal = [...messages].reverse().find((m) => m.proposal);
  if (!proposal) return "There is no proposal in the bots room.";
  if (proposal.sender !== session.user_id) return "Only the bot that made the proposal sets the session to agreed.";
  const levels = stateOf(botsRoom, "m.room.power_levels")?.users ?? {};
  const bots = Object.keys(levels).filter((u) => levels[u] === 50);
  const yes = new Set(messages.filter((m) => m.answer?.proposal === proposal.proposal.id && m.answer.accepted).map((m) => m.sender));
  const missing = bots.filter((b) => !yes.has(b));
  return missing.length ? `Not every bot has accepted the proposal yet: waiting for ${missing.join(", ")}.` : null;
}

// ---------- Side sessions ----------

// The owner's app answered a side request: announce the side session in the main session's bots room,
// once per request and in code, clear waiting, and wake the agent in the side session.
const announced = new Set();
async function sideOpened(ownerRoom, answerId, { for: requestId, session: sideSession }) {
  if (!requestId || !sideSession || announced.has(requestId)) return;
  announced.add(requestId);
  try {
    const request = await clear(ownerRoom, await api("GET", `${room(ownerRoom)}/event/${encodeURIComponent(requestId)}`));
    const side = request.content?.["xyz.deloop.side"];
    if (request.sender !== session.user_id || !side?.with) return;
    const main = side.from ?? sessionOf(ownerRoom);
    await sendMessage(roomFor(main, "bots"), `My owner's agent continues with ${side.with}'s agent in a side session on: ${side.topic}.`, {
      "xyz.deloop.side": { with: side.with, topic: side.topic, session: sideSession },
    });
    await sendMessage(ownerRoom, "Carrying on.", { "xyz.deloop.waiting": false });
    noteMarker(ownerRoom, { "xyz.deloop.waiting": false });
    // The side session's rooms may still be joining: try every 10 seconds for a minute, then say so.
    let tries = 0;
    const timer = setInterval(() => {
      let bots;
      try {
        bots = roomFor(sideSession, "bots");
      } catch {
        if (++tries >= 6) {
          clearInterval(timer);
          console.error(`Side session ${sideSession}: its bots room was not joined within a minute; no wake`);
        }
        return;
      }
      clearInterval(timer);
      wake({ room: bots, session: sideSession, kind: "bots", sender: process.env.DELOOP_OWNER ?? "", body: `The side session you asked for is open, with ${side.with}, on: ${side.topic}. Continue there.` });
    }, 10000);
  } catch (err) {
    console.error(`Side session ${sideSession}: ${err.message}`);
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
    async (args) => {
      const rid = target(args);
      afterArchive(rid);
      return json({ event_id: await sendMessage(rid, args.text) });
    },
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
    "open_side_session",
    { description: "Ask your owner's app to open a side session with one person's agent, in their one-to-one chat, on one topic: for something released only to that counterpart. Sends the request to the owner room and sets waiting; once the app has opened it, the connector announces it in this session's bots room and you continue there. Never write such a value in a shared room.", inputSchema: { session: z.string().describe("The session you are in now"), with: z.string().describe("The person's Matrix address, e.g. @jonas:deloop.website"), topic: z.string() } },
    async ({ session: s, with: who, topic }) => {
      afterArchive(roomFor(s, "bots")); // its topic is announced in the bots room
      const rid = roomFor(s, "owner");
      const event_id = await sendMessage(rid, `Continuing with ${who}'s agent on: ${topic}.`, { "xyz.deloop.side": { with: who, topic, from: s } });
      await sendMessage(rid, "Waiting for you.", { "xyz.deloop.waiting": true });
      noteMarker(rid, { "xyz.deloop.waiting": true });
      return json({ ok: true, request: event_id, note: "Your owner's app opens the side session; the connector announces it and wakes you there." });
    },
  );

  server.registerTool(
    "propose",
    { description: "Post a proposal in the session's bots room. Returns its id, which answers refer to.", inputSchema: { session: z.string(), text: z.string() } },
    async ({ session: s, text }) => {
      const id = randomUUID();
      afterArchive(roomFor(s, "bots"));
      const event_id = await sendMessage(roomFor(s, "bots"), text, { "xyz.deloop.proposal": { id } });
      return json({ proposal: id, event_id });
    },
  );

  server.registerTool(
    "answer",
    { description: "Post this bot's answer to a proposal in the bots room, after the owner has decided in the owner room.", inputSchema: { session: z.string(), proposal: z.string(), accepted: z.boolean(), text: z.string() } },
    async ({ session: s, proposal, accepted, text }) => {
      afterArchive(roomFor(s, "bots"));
      const event_id = await sendMessage(roomFor(s, "bots"), text, { "xyz.deloop.answer": { proposal, accepted } });
      return json({ event_id });
    },
  );

  server.registerTool(
    "set_session_status",
    { description: "Set the session's status, e.g. agreed once every bot has accepted the same proposal. Sent as an encrypted marker message in the bots room, which the app does not show in the chat.", inputSchema: { session: z.string(), status: z.enum(["open", "agreed", "closed"]) } },
    async ({ session: s, status }) => {
      const rid = roomFor(s, "bots");
      if (status === "agreed") {
        const refused = await notAgreedYet(rid);
        if (refused) return json({ ok: false, error: refused });
      }
      await sendMessage(rid, `Session ${status}.`, { "xyz.deloop.status": status });
      noteMarker(rid, { "xyz.deloop.status": status });
      return json({ ok: true });
    },
  );

  server.registerTool(
    "search_archive",
    { description: "Owner room only. Search what your owner gave you, the folders and mail named in archive.md, by meaning and by words; or, with path, read one hit in full (start for one message of an mbox). Only what lies under archive.md's lines is served. After this, the wake writes only to the owner room.", inputSchema: { query: z.string().optional(), k: z.number().int().min(1).max(20).default(8), path: z.string().optional(), start: z.number().int().optional() } },
    async ({ query, k, path, start }) => {
      const refused = archiveRefused();
      if (refused) return json({ ok: false, error: refused });
      if (!query && !path) return json({ ok: false, error: "Give a query, or the path of a hit." });
      archiveRead = true;
      const args = path ? ["--show", path, ...(start ? [String(start)] : []), "--json"] : [query, String(k), "--json"];
      try {
        return json(await recall(args));
      } catch (e) {
        return json({ ok: false, error: e.message });
      }
    },
  );

  server.registerTool(
    "remember",
    { description: "Owner room only. Write one fact you learned about your owner into memory/: one file per fact, one index line in MEMORY.md. Only what your owner said, or an inference they confirmed. The same title replaces that memory.", inputSchema: { title: z.string().min(3).max(80), text: z.string().min(1).max(4000), hook: z.string().max(150).describe("One line for the index: what the memory holds") } },
    async ({ title, text, hook }) => {
      const refused = archiveRefused();
      if (refused) return json({ ok: false, error: refused });
      return json(await remember(title, text, hook));
    },
  );

  return server;
}

// ---------- Archive and memory ----------

// A wake that has read the archive writes only to owner rooms; the connector's own messages are not bound.
function afterArchive(roomId) {
  if (waking && archiveRead && stateOf(roomId, "xyz.deloop.room")?.kind !== "owner")
    throw new Error("This wake has read the archive: it writes only to the owner room. What may reach others is in the catalogue.");
}

function archiveRefused() {
  if (!hasFolder(AGENT_DIR)) return "This bot has no agent directory.";
  if (waking && wakeKind !== "owner") return "Only in the owner room: the archive and memory never reach a room with others.";
  return null;
}

// recall/recall.py with the recall's own Python; the bound to archive.md is checked there on every call.
function recall(args) {
  const home = dirnameOf(AGENT_DIR);
  const python = joinPath(home, "recall", "venv", "bin", "python");
  if (!existsSync(python)) return Promise.reject(new Error("The archive has no index yet: /deloop agent builds it."));
  const script = new URL("./recall/recall.py", import.meta.url).pathname;
  return new Promise((resolve, reject) =>
    execFile(python, [script, ...args], { env: { ...process.env, DELOOP_HOME: home, MATRIX_PASSWORD: "" }, timeout: 120000, maxBuffer: 8 << 20 }, (err, out) => {
      if (err) return reject(new Error("The index could not be searched."));
      try {
        resolve(JSON.parse(out) ?? { ok: false, error: "Not in the archive." });
      } catch {
        reject(new Error("The index gave no answer."));
      }
    }),
  );
}

// One file per memory, its name made here from the title, inside memory/ and nowhere else.
async function remember(title, text, hook) {
  const slug = title.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  if (!slug) return { ok: false, error: "The title needs letters or digits." };
  const dir = joinPath(AGENT_DIR, "memory");
  await mkdir(dir, { recursive: true });
  const file = `${slug}.md`;
  const clean = (t) => t.replace(/[\r\n]+/g, " ").trim();
  const date = new Date().toISOString().slice(0, 10);
  await writeFile(joinPath(dir, file), `# ${clean(title)}\n\n${text.trim()}\n\nWritten by the agent in the owner room, ${date}.\n`, { mode: 0o600 });
  const index = joinPath(dir, "MEMORY.md");
  let lines = [];
  try {
    lines = (await readFile(index, "utf8")).split("\n");
  } catch {
    lines = ["# Memory", ""];
  }
  const line = `- [${clean(title).replace(/[\[\]]/g, "")}](${file}) — ${clean(hook)}`;
  const at = lines.findIndex((l) => l.includes(`](${file})`));
  if (at >= 0) lines[at] = line;
  else {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (lines.length && !lines[lines.length - 1].startsWith("- ")) lines.push("");
    lines.push(line, "");
  }
  await writeFile(index, lines.join("\n"));
  return { ok: true, file: `memory/${file}`, replaced: at >= 0 };
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
startRecall();
syncLoop();

// The agent's recall (recall/): once it is installed, every start brings the index up to date with
// archive.md, in the background; the run is the indexer's own and survives the connector.
function startRecall() {
  if (!AGENT_DIR) return;
  const home = dirnameOf(AGENT_DIR);
  if (!existsSync(joinPath(home, "recall", "venv", "bin", "python"))) return;
  const script = new URL("./recall/recall.sh", import.meta.url).pathname;
  spawn("/bin/sh", [script, "index"], { env: { ...process.env, DELOOP_HOME: home }, stdio: "ignore", detached: true }).unref();
  console.log("Recall: updating the index in the background");
}
