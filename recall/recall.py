#!/usr/bin/env python3
"""Searches the agent's index. From HER's recall (her/lab/recall/recall.py).

Hybrid: vectors (meaning) and FTS5 bm25 (exact words: names, numbers, references), fused by
reciprocal rank; one hit per file, its best chunk. Bounded: a hit whose path is not under a line
of archive.md as it stands now is never returned, even if the index still holds it.

  recall.py "question" [k] [--json] [--mode hybrid|vector|keyword]
  recall.py --show PATH [START]     the text of one hit (a mail, a page, lines), within the bound
"""
import argparse
import json
import re
import sqlite3
import sys

import numpy as np

import common

RRF_K = 60
POOL = 200


def fts_query(text):
    words = re.findall(r"\w+", text, re.UNICODE)
    return " OR ".join('"%s"' % w for w in words if len(w) > 1)


def open_db():
    try:
        return sqlite3.connect("file:%s?mode=ro" % common.DB_PATH, uri=True)
    except sqlite3.OperationalError:
        return None


def vector_ranks(db, query, allowed):
    rows = [r for r in db.execute("SELECT id, path, embedding FROM chunks") if r[1] in allowed]
    if not rows:
        return {}, {}
    ids = np.array([r[0] for r in rows])
    mat = np.vstack([np.frombuffer(r[2], dtype=np.float32) for r in rows])
    mat /= (np.linalg.norm(mat, axis=1, keepdims=True) + 1e-12)
    q = np.asarray(common.embed_query(query), dtype=np.float32)
    q /= (np.linalg.norm(q) + 1e-12)
    scores = mat @ q
    top = np.argsort(-scores)[:POOL]
    return ({int(ids[i]): r for r, i in enumerate(top)}, {int(ids[i]): float(scores[i]) for i in top})


def keyword_ranks(db, query, allowed):
    q = fts_query(query)
    if not q:
        return {}
    try:
        rows = db.execute("SELECT rowid, path FROM chunks_fts WHERE chunks_fts MATCH ? "
                          "ORDER BY bm25(chunks_fts) LIMIT ?", (q, POOL * 4)).fetchall()
    except sqlite3.OperationalError:
        return {}
    rows = [r for r in rows if r[1] in allowed][:POOL]
    return {r[0]: i for i, r in enumerate(rows)}


def allowed_paths(db, roots):
    return {p for (p,) in db.execute("SELECT path FROM files") if common.under(p, roots)}


def location(unit, s, e):
    return {"page": "p.%d" % s, "mail": "mail", "message": "message %d" % s}.get(unit, "%d-%d" % (s, e))


def search(query, k=8, mode="hybrid"):
    db = open_db()
    if db is None:
        return []
    allowed = allowed_paths(db, common.archive_roots())
    vec, cos = vector_ranks(db, query, allowed) if mode != "keyword" else ({}, {})
    kw = keyword_ranks(db, query, allowed) if mode != "vector" else {}

    fused = {}
    for ranks in (vec, kw):
        for cid, r in ranks.items():
            fused[cid] = fused.get(cid, 0.0) + 1.0 / (RRF_K + r + 1)

    best, extra = {}, {}
    for cid in sorted(fused, key=fused.get, reverse=True):
        path, s, e, hd, text = db.execute(
            "SELECT path,start_line,end_line,heading,text FROM chunks WHERE id=?", (cid,)).fetchone()
        unit = (db.execute("SELECT unit FROM files WHERE path=?", (path,)).fetchone() or ["line"])[0]
        key = "%s#%d" % (path, s) if unit == "message" else path   # one hit per mail of an mbox
        if key in best:
            extra[key] += 1
            continue
        if len(best) >= k:
            continue
        extra[key] = 0
        best[key] = {"path": path, "start": s, "loc": location(unit, s, e), "heading": hd,
                      "score": round(fused[cid], 5), "snippet": " ".join(text.split())[:300]}
    for key, h in best.items():
        h["more"] = extra[key]
    return list(best.values())


def show(path, start=None, max_words=2000):
    """The indexed text of one file (or one mbox message), only under archive.md's lines."""
    if not common.under(path, common.archive_roots()):
        return None
    db = open_db()
    if db is None:
        return None
    q = "SELECT heading, text FROM chunks WHERE path=?" + (" AND start_line=?" if start else "") + " ORDER BY id"
    rows = db.execute(q, (path, start) if start else (path,)).fetchall()
    if not rows:
        return None
    # Chunks overlap by OVERLAP_WORDS; joining them as they are repeats a little, which is harmless.
    words = " ".join(t for _, t in rows).split()
    return {"path": path, "heading": rows[0][0], "text": " ".join(words[:max_words]),
            "truncated": len(words) > max_words}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("query", nargs="?")
    ap.add_argument("k", nargs="?", type=int, default=8)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--mode", choices=("hybrid", "vector", "keyword"), default="hybrid")
    ap.add_argument("--show", nargs="+", metavar=("PATH", "START"))
    args = ap.parse_args()

    if args.show:
        r = show(args.show[0], int(args.show[1]) if len(args.show) > 1 else None)
        print(json.dumps(r, ensure_ascii=False) if args.json else (r["text"] if r else "(not in the archive)"))
        return
    if not args.query:
        ap.error("a question, or --show PATH")
    hits = search(args.query, args.k, args.mode)
    if args.json:
        print(json.dumps(hits, ensure_ascii=False))
        return
    if not hits:
        print("(no results; is the index built?)")
        return
    for h in hits:
        head = (" [" + h["heading"] + "]") if h["heading"] else ""
        more = (" +%d more" % h["more"]) if h["more"] else ""
        print("%s:%s%s%s\n       %s\n" % (h["path"], h["loc"], head, more, h["snippet"]))


if __name__ == "__main__":
    sys.exit(main())
