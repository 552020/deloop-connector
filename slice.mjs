// What of the agent's directory (docs/template.md) reaches a wake. For the bots and people rooms, the slice:
// catalogue.md cut to the lowest level mandate.md grants to anyone else present, in code and with no
// model. It fails closed: a category it cannot read is not carried. For the owner room, the whole directory.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const read = (dir, file) => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8") : "");
const clean = (s) => s.trim().toLowerCase();

// "## Name" sections of a Markdown file: [{ title, body }].
function sections(text, mark = "## ") {
  const out = [];
  for (const block of text.split(new RegExp(`^${mark}`, "m")).slice(1)) {
    const [title, ...rest] = block.split("\n");
    out.push({ title: title.trim(), body: rest.join("\n") });
  }
  return out;
}

// catalogue.md: category -> { level number -> text }; "archive:" lines stay on the owner side.
export function parseCatalogue(text) {
  const out = new Map();
  for (const { title, body } of sections(text)) {
    const levels = new Map();
    for (const sub of sections(body, "### ")) {
      const n = Number(sub.title);
      if (!Number.isInteger(n) || n < 1) continue;
      const value = sub.body.split("\n").filter((l) => !/^\s*archive:/i.test(l)).join("\n").trim();
      levels.set(n, value);
    }
    if (levels.size) out.set(title, levels);
  }
  return out;
}

// Rows "| Category | Level |" of a table, as category -> level (numbers only).
function table(body) {
  const out = new Map();
  for (const line of body.split("\n")) {
    const cells = line.split("|").map((c) => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1);
    if (cells.length < 2 || !/^\d+$/.test(cells[1])) continue;
    out.set(cells[0], Number(cells[1]));
  }
  return out;
}

const items = (body) => body.split("\n").filter((l) => /^\s*-\s+\S/.test(l)).map((l) => l.replace(/^\s*-\s+/, "").trim());

// mandate.md: levels for everyone, overrides per address, needs a yes, never, how the person decides.
export function parseMandate(text) {
  const m = { everyone: new Map(), byAddress: new Map(), needsYes: [], never: [], decides: "" };
  for (const { title, body } of sections(text)) {
    const t = clean(title);
    if (t === "everyone") m.everyone = table(body);
    else if (t === "per address") for (const sub of sections(body, "### ")) if (sub.title.startsWith("@")) m.byAddress.set(clean(sub.title), table(sub.body));
    else if (t === "needs a yes") m.needsYes = items(body);
    else if (t === "never") m.never = items(body);
    else if (t === "how the person decides") m.decides = body.trim();
  }
  return m;
}

const filled = (text) => text && clean(text) !== "not given";

// The level of a category for a room: the lowest granted to anyone in it (no one else: everyone's).
export function levelFor(mandate, category, counterparts) {
  const base = mandate.everyone.get(category) ?? 0;
  if (!counterparts.length) return base;
  return Math.min(...counterparts.map((a) => mandate.byAddress.get(clean(a))?.get(category) ?? base));
}

export function slice(dir, counterparts) {
  const catalogue = parseCatalogue(read(dir, "catalogue.md"));
  const mandate = parseMandate(read(dir, "mandate.md"));
  const never = new Set(mandate.never.map(clean));
  const lines = [];
  for (const [category, levels] of catalogue) {
    if (never.has(clean(category))) continue;
    const anything = [...levels.values()].some(filled);
    if (!anything) {
      lines.push(`### ${category}\nnot given`);
      continue;
    }
    const level = levelFor(mandate, category, counterparts);
    if (level === 0) {
      lines.push(`### ${category}\nnot released to this room. If asked, say you cannot share it, or ask your owner.`);
      continue;
    }
    const given = [...levels].filter(([n, t]) => n <= level && filled(t)).sort((a, b) => a[0] - b[0]).map(([, t]) => t);
    const more = [...levels].some(([n, t]) => n > level && filled(t));
    lines.push(`### ${category} (level ${level})\n${given.join("\n") || "not given"}${more ? "\nThere is more above this level: not released to this room; ask your owner." : ""}`);
  }
  const out = [
    read(dir, "agent.md").trim(),
    `## Catalogue for this room\n\nWho else is here: ${counterparts.join(", ") || "no one else"}. Every value below may be said in this room; nothing else from your owner may.\n\n${lines.join("\n\n")}`,
  ];
  if (mandate.needsYes.length) out.push(`## Needs a yes\n\nSaid only after your owner has said yes in the owner room, for this session:\n\n${mandate.needsYes.map((i) => `- ${i}`).join("\n")}`);
  if (mandate.decides) out.push(`## How your owner decides\n\n${mandate.decides}`);
  return out.filter(Boolean).join("\n\n");
}

// The owner room: the whole directory, memory index included (the archive is read only through its paths).
export function ownerFolder(dir) {
  const parts = ["agent.md", "catalogue.md", "mandate.md", "archive.md"].map((f) => read(dir, f).trim()).filter(Boolean);
  const memory = read(join(dir, "memory"), "MEMORY.md").trim();
  if (memory) parts.push(memory);
  return parts.join("\n\n");
}

export const hasFolder = (dir) => !!dir && existsSync(join(dir, "catalogue.md")) && existsSync(join(dir, "mandate.md"));
export const files = (dir) => (existsSync(dir) ? readdirSync(dir) : []);
