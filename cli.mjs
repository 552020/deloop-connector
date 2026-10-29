#!/usr/bin/env node
// deloop-connector: one command for the owner. Without arguments it sets the connector up the first time
// (bot address, browser login, autostart) and afterwards starts it. Settings live in ~/.deloop.
import { createServer } from "node:http";
import { cp, mkdir, readFile, readdir, writeFile, rm, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
// The connector runs from a fixed copy here, made at setup and replaced only by `update`: a push to the
// public repository does not reach a running connector by itself, and a start needs no network.
const APP = join(homedir(), ".deloop", "app");
const DIR = join(homedir(), ".deloop");
const CONFIG = join(DIR, "connector.json");
const SESSION = join(DIR, "session.json");
const LOG = join(DIR, "connector.log");
const PACKAGE = "github:552020/deloop-connector";
const LABEL = "xyz.deloop.connector";
const PLIST = join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
const UNIT = join(homedir(), ".config/systemd/user/deloop-connector.service");
// Until 29 October 2026 the connector was called the bridge: its service is moved over, ~/.deloop stays.
const OLD_LABEL = "xyz.deloop.bridge";
const OLD_PLIST = join(homedir(), "Library/LaunchAgents", `${OLD_LABEL}.plist`);
const OLD_UNIT = join(homedir(), ".config/systemd/user/deloop-bridge.service");
const installed = () => [PLIST, UNIT, OLD_PLIST, OLD_UNIT].some((f) => existsSync(f));

async function removeOldService() {
  if (existsSync(OLD_PLIST)) {
    try {
      execFileSync("launchctl", ["bootout", `gui/${process.getuid()}/${OLD_LABEL}`], { stdio: "ignore" });
    } catch {}
    await rm(OLD_PLIST, { force: true });
  }
  if (existsSync(OLD_UNIT)) {
    try {
      execFileSync("systemctl", ["--user", "disable", "--now", "deloop-bridge"], { stdio: "ignore" });
    } catch {}
    await rm(OLD_UNIT, { force: true });
  }
}
// Every account lives on our server; DELOOP_SERVER points the setup elsewhere for development and tests.
const SERVER = process.env.DELOOP_SERVER || "deloop.website";
const NAME = /^[a-z0-9._=\/-]+$/;

// "anna" or "@anna:deloop.website" → "@anna:deloop.website"; null for anything else.
function address(input) {
  const text = input.trim().toLowerCase();
  const name = text.startsWith("@") && text.endsWith(`:${SERVER}`) ? text.slice(1, -SERVER.length - 1) : text;
  return NAME.test(name) ? `@${name}:${SERVER}` : null;
}

const say = (text = "") => console.log(text);

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function writePrivate(file, value) {
  await mkdir(DIR, { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2));
  await chmod(file, 0o600);
}

// Where a command lives, or null; never a temporary npx folder or a project's node_modules.
function which(name) {
  try {
    const path = execFileSync("/bin/sh", ["-c", `command -v ${name}`]).toString().trim();
    return path && !/_npx|node_modules/.test(path) ? path : null;
  } catch {
    return null;
  }
}

// The node binary by a path that survives upgrades: Homebrew's versioned Cellar path
// (/opt/homebrew/Cellar/node/26.10.0_1/bin/node) becomes its stable link.
function stableNode() {
  const node = process.execPath;
  const m = node.match(/^(.*)\/Cellar\/(node(?:@[\d.]+)?)\/[^/]+\/bin\/node$/);
  if (!m) return node;
  for (const link of [`${m[1]}/opt/${m[2]}/bin/node`, `${m[1]}/bin/node`]) if (existsSync(link)) return link;
  return node;
}

// The PATH of the background service: node, the brain (claude, codex) and the system, nothing else.
function servicePath(node) {
  const dirs = [dirname(node), ...["claude", "codex"].map(which).filter(Boolean).map((p) => dirname(p)), "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return [...new Set(dirs)].join(":");
}

// Copies this connector to ~/.deloop/app and installs its dependencies there.
async function install() {
  if (HERE === APP) return;
  say("Installing the connector into ~/.deloop/app…");
  await rm(APP, { recursive: true, force: true });
  const skip = /(^|\/)(node_modules|\.crypto|\.env|\.session\.json)(\/|$)/;
  await cp(HERE, APP, { recursive: true, filter: (src) => !skip.test(src.slice(HERE.length)) });
  // Without the npm_ variables of a running npx, which would point npm at its own temporary folder.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toLowerCase().startsWith("npm_")));
  execFileSync(join(dirname(process.execPath), "npm"), ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: APP, env, stdio: "inherit" });
  await cryptoLibrary(APP);
}

function hasCommand(name) {
  try {
    execFileSync("/bin/sh", ["-c", `command -v ${name}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// The client API of a Matrix server, from the server part of an address (matrix.org → matrix-client.matrix.org).
async function homeserverOf(address) {
  const server = address.slice(address.indexOf(":") + 1);
  try {
    const res = await fetch(`https://${server}/.well-known/matrix/client`);
    const url = (await res.json())["m.homeserver"]?.base_url;
    if (url) return url.replace(/\/$/, "");
  } catch {}
  return `https://${server}`;
}

async function ask(rl, question, check, hint) {
  for (;;) {
    const answer = (await rl.question(question)).trim();
    if (!check || check(answer)) return answer;
    say(hint);
  }
}

// Hidden input for a password: nothing is echoed.
function askHidden(question) {
  process.stdout.write(question);
  return new Promise((resolve) => {
    let value = "";
    const stdin = process.stdin;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === "\u0003") process.exit(130);
        if (c === "\r" || c === "\n") {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off("data", onData);
          say();
          return resolve(value);
        }
        value = c === "\u007f" || c === "\b" ? value.slice(0, -1) : value + c;
      }
    };
    stdin.on("data", onData);
  });
}

// Browser login (Google, Apple, password: whatever the server offers). The server sends the
// browser back to a one-off local address with a login token, exchanged here for a session.
async function browserLogin(homeserver) {
  const { token, server } = await new Promise((resolve) => {
    const server = createServer((req, res) => {
      const token = new URL(req.url, "http://127.0.0.1").searchParams.get("loginToken");
      if (!token) return res.writeHead(404).end();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<p style='font:18px system-ui;margin:40px'>Logged in. You can close this window and go back to the terminal.</p>");
      resolve({ token, server });
    });
    server.listen(0, "127.0.0.1", () => {
      const back = `http://127.0.0.1:${server.address().port}/callback`;
      const url = `${homeserver}/_matrix/client/v3/login/sso/redirect?redirectUrl=${encodeURIComponent(back)}`;
      say("Open this link in a private browser window and log in as the bot (with Google too, if that is how you made it):");
      say();
      say(`  ${url}`);
      say();
      say("A private window, because your browser is probably logged in as you, not as the bot. Waiting…");
    });
  });
  server.close();
  return login(homeserver, { type: "m.login.token", token });
}

async function login(homeserver, body) {
  const res = await fetch(`${homeserver}/_matrix/client/v3/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, initial_device_display_name: "deloop connector" }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Login failed (${res.status})`);
  return data;
}

async function setup() {
  say("Deloop connector: connects your bot (Claude Code on this computer) to Deloop.");
  say();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const owner = address(await ask(rl, "Your name on Deloop (e.g. anna): ", (a) => !!address(a), "  Just the name you signed up with, like anna"));
  // Sign-up makes both accounts with one name and one password: the bot is always name-bot.
  const bot = address(`${owner.slice(1, owner.indexOf(":"))}-bot`);
  rl.close();

  const homeserver = process.env.MATRIX_HOMESERVER || (await homeserverOf(bot));
  const flows = (await (await fetch(`${homeserver}/_matrix/client/v3/login`)).json()).flows?.map((f) => f.type) ?? [];
  say();
  let session;
  for (let tries = 1; ; tries++) {
    if (tries > 5) {
      say("Giving up after five tries.");
      process.exit(1);
    }
    try {
      session = flows.includes("m.login.sso")
        ? await browserLogin(homeserver)
        : await login(homeserver, { type: "m.login.password", identifier: { type: "m.id.user", user: bot }, password: await askHidden("Your password: ") });
    } catch (err) {
      say(/M_FORBIDDEN/.test(err.message) ? "Wrong name or password. Once more." : `Login failed: ${err.message.replace(/\.$/, "")}. Once more.`);
      continue;
    }
    if (session.user_id.toLowerCase() === bot) break;
    say();
    say(`That was ${session.user_id}, not your bot ${bot}. Log out there, or use a private window, and open the link again.`);
    say();
    await fetch(`${homeserver}/_matrix/client/v3/logout`, { method: "POST", headers: { Authorization: `Bearer ${session.access_token}` } }).catch(() => {});
  }
  await writePrivate(SESSION, session);
  await writePrivate(CONFIG, { homeserver, bot, owner, port: 7420 });
  say();
  say(`Logged in as ${bot}.`);

  if (!hasCommand("claude")) {
    say();
    say("Claude Code is not installed: the connector runs, but your bot will not answer by itself.");
    say("Install it from https://claude.com/claude-code, then start the connector again.");
  }

  say();
  const rl2 = createInterface({ input: process.stdin, output: process.stdout });
  const auto = (await rl2.question("Start the connector by itself whenever this computer starts? [Y/n] ")).trim().toLowerCase();
  rl2.close();
  if (auto === "" || auto.startsWith("y")) {
    await install();
    await autostart(true);
    say();
    say("Done. The connector runs in the background now and after every restart.");
    say(`Its log: ${LOG}. Stop it for good with: npx ${PACKAGE} autostart off`);
    return false;
  }
  say();
  say(`Starting it here. Keep this window open; next time start it with: npx ${PACKAGE}`);
  return true;
}

// launchd on macOS, a systemd user service on Linux. Both run the copy in ~/.deloop/app with node.
async function autostart(on) {
  await removeOldService();
  const node = stableNode();
  const cli = join(APP, "cli.mjs");
  const path = servicePath(node);
  if (platform() === "darwin") {
    const uid = process.getuid();
    try {
      execFileSync("launchctl", ["bootout", `gui/${uid}/${LABEL}`], { stdio: "ignore" });
    } catch {}
    if (!on) return rm(PLIST, { force: true });
    const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    await mkdir(dirname(PLIST), { recursive: true });
    await writeFile(
      PLIST,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(cli)}</string><string>start</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG)}</string>
</dict></plist>
`,
    );
    execFileSync("launchctl", ["bootstrap", `gui/${uid}`, PLIST]);
    return;
  }
  if (platform() === "linux") {
    try {
      execFileSync("systemctl", ["--user", "disable", "--now", "deloop-connector"], { stdio: "ignore" });
    } catch {}
    if (!on) return rm(UNIT, { force: true });
    await mkdir(dirname(UNIT), { recursive: true });
    await writeFile(
      UNIT,
      `[Unit]
Description=Deloop connector
After=network-online.target

[Service]
ExecStart=${node} ${cli} start
Environment=PATH=${path}
Restart=always
RestartSec=10
StandardOutput=append:${LOG}
StandardError=append:${LOG}

[Install]
WantedBy=default.target
`,
    );
    execFileSync("systemctl", ["--user", "daemon-reload"]);
    execFileSync("systemctl", ["--user", "enable", "--now", "deloop-connector"]);
    return;
  }
  say("Autostart works on macOS and Linux only.");
}

// The encryption library is a native file fetched by its install script. npm may skip install
// scripts, so a missing file is fetched here, once.
async function cryptoLibrary(base = HERE) {
  const pkg = dirname(createRequire(join(base, "cli.mjs")).resolve("@matrix-org/matrix-sdk-crypto-nodejs/package.json"));
  if ((await readdir(pkg)).some((f) => f.endsWith(".node"))) return;
  say("Fetching the encryption library…");
  execFileSync(process.execPath, ["download-lib.js"], { cwd: pkg, stdio: "inherit" });
}

async function start() {
  const config = await readJson(CONFIG);
  if (!config || !existsSync(SESSION)) {
    say(`Not set up yet: run npx ${PACKAGE}`);
    process.exit(1);
  }
  const env = {
    MATRIX_HOMESERVER: config.homeserver,
    MATRIX_USER: config.bot,
    CONNECTOR_PORT: String(config.port ?? 7420),
    CONNECTOR_SESSION_FILE: SESSION,
    CONNECTOR_CRYPTO_DIR: join(DIR, "crypto"),
    DELOOP_OWNER: config.owner,
    // The owner's time zone, for the date in every wake: this computer's.
    DELOOP_TIMEZONE: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(hasCommand("claude")
      ? { WAKE_COMMAND: join(HERE, "wake-claude.sh") }
      : hasCommand("codex") && { WAKE_COMMAND: join(HERE, "wake-codex.sh") }),
  };
  for (const [k, v] of Object.entries(env)) process.env[k] ??= v;
  await cryptoLibrary();
  await import("./connector.mjs");
}

const [command, arg] = process.argv.slice(2);
if (command === "setup") {
  if (await setup()) await start();
} else if (command === "start") {
  await start();
} else if (command === "update") {
  // Run as `npx github:552020/deloop-connector update`: this newest copy replaces the installed one.
  await install();
  if (installed()) {
    await autostart(true);
    say("Updated. The connector in the background runs the new version.");
  } else say("Updated.");
} else if (command === "autostart") {
  if (arg !== "off") await install();
  await autostart(arg !== "off");
  say(arg === "off" ? "Autostart off; the connector is stopped." : "Autostart on; the connector is running.");
} else if (!command) {
  if (installed()) say(`The connector already runs in the background. Log: ${LOG}. Set it up again with: npx ${PACKAGE} setup`);
  else if ((await readJson(CONFIG)) && existsSync(SESSION)) await start();
  else if (await setup()) await start();
} else {
  say(`Usage: npx ${PACKAGE} [setup | start | update | autostart on|off]`);
}
