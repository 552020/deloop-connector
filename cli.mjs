#!/usr/bin/env node
// deloop-bridge: one command for the owner. Without arguments it sets the bridge up the first time
// (bot address, browser login, autostart) and afterwards starts it. Settings live in ~/.deloop.
import { createServer } from "node:http";
import { mkdir, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(homedir(), ".deloop");
const CONFIG = join(DIR, "bridge.json");
const SESSION = join(DIR, "session.json");
const LOG = join(DIR, "bridge.log");
const PACKAGE = "github:552020/deloop-bridge";
const LABEL = "xyz.deloop.bridge";
const PLIST = join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
const UNIT = join(homedir(), ".config/systemd/user/deloop-bridge.service");
const ADDRESS = /^@[^:\s]+:[^\s]+$/;

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
    body: JSON.stringify({ ...body, initial_device_display_name: "deloop bridge" }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Login failed (${res.status})`);
  return data;
}

async function setup() {
  say("Deloop bridge: connects your bot (Claude Code on this computer) to Matrix.");
  say();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const owner = (await ask(rl, "Your own Matrix address (e.g. @anna:matrix.org): ", (a) => ADDRESS.test(a), "  An address looks like @name:matrix.org")).toLowerCase();
  const bot = (await ask(rl, "Your bot's Matrix address (e.g. @anna-bot:matrix.org): ", (a) => ADDRESS.test(a) && a.toLowerCase() !== owner, "  The bot's address, different from yours, like @name:matrix.org")).toLowerCase();
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
        : await login(homeserver, { type: "m.login.password", identifier: { type: "m.id.user", user: bot }, password: await askHidden(`Password of ${bot}: `) });
    } catch (err) {
      say(`Login failed: ${err.message}. Once more.`);
      continue;
    }
    if (session.user_id.toLowerCase() === bot) break;
    say();
    say(`That was ${session.user_id}, not the bot ${bot}. Log out there, or use a private window, and open the link again.`);
    say();
    await fetch(`${homeserver}/_matrix/client/v3/logout`, { method: "POST", headers: { Authorization: `Bearer ${session.access_token}` } }).catch(() => {});
  }
  await writePrivate(SESSION, session);
  await writePrivate(CONFIG, { homeserver, bot, owner, port: 7420 });
  say();
  say(`Logged in as ${bot}.`);

  if (!hasCommand("claude")) {
    say();
    say("Claude Code is not installed: the bridge runs, but your bot will not answer by itself.");
    say("Install it from https://claude.com/claude-code, then start the bridge again.");
  }

  say();
  const rl2 = createInterface({ input: process.stdin, output: process.stdout });
  const auto = (await rl2.question("Start the bridge by itself whenever this computer starts? [Y/n] ")).trim().toLowerCase();
  rl2.close();
  if (auto === "" || auto.startsWith("y")) {
    await autostart(true);
    say();
    say("Done. The bridge runs in the background now and after every restart.");
    say(`Its log: ${LOG}. Stop it for good with: npx ${PACKAGE} autostart off`);
    return false;
  }
  say();
  say(`Starting it here. Keep this window open; next time start it with: npx ${PACKAGE}`);
  return true;
}

// launchd on macOS, a systemd user service on Linux. Both run the published package through npx.
async function autostart(on) {
  const npx = join(dirname(process.execPath), "npx");
  const path = process.env.PATH ?? "";
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
  <key>ProgramArguments</key><array><string>${xml(npx)}</string><string>-y</string><string>${PACKAGE}</string><string>start</string></array>
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
      execFileSync("systemctl", ["--user", "disable", "--now", "deloop-bridge"], { stdio: "ignore" });
    } catch {}
    if (!on) return rm(UNIT, { force: true });
    await mkdir(dirname(UNIT), { recursive: true });
    await writeFile(
      UNIT,
      `[Unit]
Description=Deloop bridge
After=network-online.target

[Service]
ExecStart=${npx} -y ${PACKAGE} start
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
    execFileSync("systemctl", ["--user", "enable", "--now", "deloop-bridge"]);
    return;
  }
  say("Autostart works on macOS and Linux only.");
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
    BRIDGE_PORT: String(config.port ?? 7420),
    BRIDGE_SESSION_FILE: SESSION,
    DELOOP_OWNER: config.owner,
    ...(hasCommand("claude")
      ? { WAKE_COMMAND: join(HERE, "wake-claude.sh") }
      : hasCommand("codex") && { WAKE_COMMAND: join(HERE, "wake-codex.sh") }),
  };
  for (const [k, v] of Object.entries(env)) process.env[k] ??= v;
  await import("./bridge.mjs");
}

const [command, arg] = process.argv.slice(2);
if (command === "setup") {
  if (await setup()) await start();
} else if (command === "start") {
  await start();
} else if (command === "autostart") {
  await autostart(arg !== "off");
  say(arg === "off" ? "Autostart off; the bridge is stopped." : "Autostart on; the bridge is running.");
} else if (!command) {
  if (existsSync(PLIST) || existsSync(UNIT)) say(`The bridge already runs in the background. Log: ${LOG}. Set it up again with: npx ${PACKAGE} setup`);
  else if ((await readJson(CONFIG)) && existsSync(SESSION)) await start();
  else if (await setup()) await start();
} else {
  say(`Usage: npx ${PACKAGE} [setup | start | autostart on|off]`);
}
