#!/usr/bin/env python3
"""Catalogue proposals from the archive, written by the local model: for each category of catalogue.md,
the recall finds the passages, the model in Ollama proposes the text for each level, and only the
proposals come out. /deloop agent shows them to the person, who confirms, corrects or strikes each;
nothing is written to catalogue.md here. The passages themselves never leave this computer.

  ~/.deloop/recall/venv/bin/python propose.py --model qwen3:8b [--category "Working hours"] [--about "..."]

--about: what the person said about themselves (name, city, work), as a hint for the queries.
One JSON object per category, one line each, as soon as it is done.
"""
import argparse
import json
import os
import re
import sys
import urllib.request

import common
import recall

OLLAMA = (os.environ.get("OLLAMA_HOST") or "http://127.0.0.1:11434").rstrip("/")
PASSAGES = 12
PASSAGE_WORDS = 160


def categories(path=None):
    """[(name, levels line, [level numbers])] from catalogue.md."""
    text = open(path or os.path.join(common.DELOOP, "agent", "catalogue.md"), encoding="utf-8").read()
    out = []
    for block in re.split(r"(?m)^## ", text)[1:]:
        name = block.split("\n", 1)[0].strip()
        m = re.search(r"(?m)^Levels:\s*(.+)$", block)
        levels = sorted({int(n) for n in re.findall(r"(?m)^### (\d+)\s*$", block)})
        if levels:
            out.append((name, m.group(1).strip() if m else "", levels))
    return out


def passages(name, levels_line, about):
    seen, out = set(), []
    for q in (name, name + " " + levels_line, (about + " " + name).strip()):
        for h in recall.search(q, k=PASSAGES):
            key = (h["path"], h["start"])
            if key in seen:
                continue
            seen.add(key)
            out.append(h)
    return out[:PASSAGES]


def ask(model, prompt):
    body = json.dumps({"model": model, "stream": False, "format": "json", "options": {"temperature": 0.1},
                       "messages": [{"role": "user", "content": prompt}]}).encode()
    req = urllib.request.Request(OLLAMA + "/api/chat", body, {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.load(r)["message"]["content"]


PROMPT = """You help one person fill the catalogue of their own agent. The agent may later say, at each level, exactly the text you propose, so every text must be sentences the agent can say as they stand, in the person's first language, and contain nothing about other people beyond what the level needs.

Category: {name}
What its levels mean: {levels_line}
Levels to fill: {levels}
{about}
Passages from the person's own mail and files (for you only; quote nothing private that the level does not need; never passwords, account numbers, codes):

{passages}

Answer with JSON only: {{"levels": {{"1": "text or null", ...}}, "basis": "one sentence on what the passages show, without names of third persons"}}. Use null for a level the passages do not support. Propose nothing you would have to guess."""


def propose(model, name, levels_line, levels, about):
    hits = passages(name, levels_line, about)
    if not hits:
        return {"category": name, "levels": {str(n): None for n in levels}, "basis": "nothing in the archive", "passages": 0}
    text = "\n\n".join("[%d] %s\n%s" % (i + 1, h["heading"] or os.path.basename(h["path"]),
                                       " ".join(h["snippet"].split()[:PASSAGE_WORDS])) for i, h in enumerate(hits))
    raw = ask(model, PROMPT.format(name=name, levels_line=levels_line, levels=", ".join(map(str, levels)),
                                   about=("What the person said about themselves: " + about) if about else "",
                                   passages=text))
    try:
        data = json.loads(raw)
    except ValueError:
        data = {"levels": {}, "basis": "the model gave no readable answer"}
    lv = data.get("levels") or {}
    return {"category": name, "levels": {str(n): (lv.get(str(n)) or None) for n in levels},
            "basis": data.get("basis", ""), "passages": len(hits)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--category", action="append")
    ap.add_argument("--about", default="")
    ap.add_argument("--catalogue")
    args = ap.parse_args()
    for name, levels_line, levels in categories(args.catalogue):
        if args.category and name not in args.category:
            continue
        try:
            out = propose(args.model, name, levels_line, levels, args.about)
        except OSError as e:
            out = {"category": name, "error": "Ollama not reachable: %s" % e}
        print(json.dumps(out, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    sys.exit(main())
