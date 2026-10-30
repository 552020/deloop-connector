#!/usr/bin/env python3
"""Builds or updates the agent's index over the paths in archive.md. Incremental: only changed
files are read again; files gone from disk, or no longer under a line of archive.md, are pruned.
From HER's recall (her/lab/recall/index.py).

Vectors are float32 blobs in a plain SQLite table, searched by numpy in recall.py; the words
side is an FTS5 table kept in step. One run at a time (a lock beside index.db): a second run
exits at once. Progress goes into the index's meta table, which `survey.py --index` reads.

  ~/.deloop/recall/venv/bin/python index.py              the paths of archive.md
  ~/.deloop/recall/venv/bin/python index.py --rebuild    drop everything, read all again
"""
import argparse
import fcntl
import hashlib
import os
import sqlite3
import sys
import time

import numpy as np

import common


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def get_meta(db, key):
    try:
        row = db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    except sqlite3.OperationalError:
        return None
    return row[0] if row else None


def set_meta(db, key, value):
    db.execute("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", (key, str(value)))


def drop_all(db):
    for t in ("chunks_fts", "chunks", "files"):
        db.execute("DROP TABLE IF EXISTS " + t)


def ensure_schema(db):
    db.execute("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)")
    db.execute("CREATE TABLE IF NOT EXISTS files("
               "path TEXT PRIMARY KEY, hash TEXT, mtime REAL, size INTEGER, unit TEXT, nchunks INTEGER)")
    db.execute("CREATE TABLE IF NOT EXISTS chunks("
               "id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, start_line INTEGER, "
               "end_line INTEGER, heading TEXT, text TEXT, embedding BLOB)")
    db.execute("CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path)")
    db.execute("CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5("
               "heading, text, path UNINDEXED, tokenize='unicode61 remove_diacritics 2')")


def remove_file(db, path):
    ids = [r[0] for r in db.execute("SELECT id FROM chunks WHERE path=?", (path,))]
    db.executemany("DELETE FROM chunks_fts WHERE rowid=?", [(i,) for i in ids])
    db.execute("DELETE FROM chunks WHERE path=?", (path,))
    db.execute("DELETE FROM files WHERE path=?", (path,))


def index_file(db, path):
    """'skip', 'changed' or 'gone'."""
    try:
        st = os.stat(path)
    except OSError:
        remove_file(db, path)
        return "gone"
    row = db.execute("SELECT hash, mtime, size FROM files WHERE path=?", (path,)).fetchone()
    if row and row[1] == st.st_mtime and row[2] == st.st_size:
        return "skip"
    try:
        h = sha(path)
    except OSError:
        return "skip"   # unreadable now (a mail store without Full Disk Access): keep what is there
    if row and row[0] == h:
        db.execute("UPDATE files SET mtime=?, size=? WHERE path=?", (st.st_mtime, st.st_size, path))
        return "skip"

    remove_file(db, path)
    try:
        unit, ch = common.chunk_file(path)
    except Exception as e:   # one bad file never stops the run
        print("unreadable: %s (%s)" % (path, type(e).__name__), file=sys.stderr)
        unit, ch = "line", []
    if ch:
        texts = [((hd + "\n" + tx).strip() if hd else tx) for (hd, s, e, tx) in ch]
        embs = common.embed_passages(texts)
        for (hd, s, e, tx), emb in zip(ch, embs):
            blob = np.asarray(emb, dtype=np.float32).tobytes()
            cur = db.execute("INSERT INTO chunks(path,start_line,end_line,heading,text,embedding) "
                             "VALUES(?,?,?,?,?,?)", (path, s, e, hd, tx, blob))
            db.execute("INSERT INTO chunks_fts(rowid,heading,text,path) VALUES(?,?,?,?)",
                       (cur.lastrowid, hd, tx, path))
    # Recorded even with no chunks (an empty file, a scan), so it is not tried again each run.
    db.execute("INSERT INTO files(path,hash,mtime,size,unit,nchunks) VALUES(?,?,?,?,?,?)",
               (path, h, st.st_mtime, st.st_size, unit, len(ch)))
    return "changed"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rebuild", action="store_true")
    args = ap.parse_args()

    os.makedirs(common.DATA, mode=0o700, exist_ok=True)
    lock = open(common.LOCK_PATH, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("another index run is active; exiting")
        return

    roots = common.archive_roots()
    t0 = time.time()
    model, name = common.get_model()
    dim = len(next(iter(model.embed(["dim probe"]))))

    db = sqlite3.connect(common.DB_PATH)
    os.chmod(common.DB_PATH, 0o600)
    if (args.rebuild or get_meta(db, "model") not in (None, name)
            or get_meta(db, "schema") not in (None, common.SCHEMA_VERSION)):
        print("rebuilding from scratch (model %s, schema %s)" % (name, common.SCHEMA_VERSION))
        drop_all(db)
    ensure_schema(db)
    for k, v in (("model", name), ("dim", dim), ("schema", common.SCHEMA_VERSION),
                 ("running", "yes"), ("started", time.strftime("%Y-%m-%d %H:%M:%S"))):
        set_meta(db, k, v)
    db.commit()

    counts = {"skip": 0, "changed": 0, "gone": 0}
    try:
        wanted = common.file_list(roots)
        wanted_set = set(wanted)
        for (p,) in db.execute("SELECT path FROM files").fetchall():
            if p not in wanted_set:
                remove_file(db, p)
                counts["gone"] += 1
        set_meta(db, "total", len(wanted))
        db.commit()
        for i, p in enumerate(wanted, 1):
            counts[index_file(db, p)] += 1
            if i % 20 == 0 or i == len(wanted):
                set_meta(db, "done", i)
            db.commit()
            if sys.stdout.isatty() and i % 200 == 0:
                print("  %d/%d" % (i, len(wanted)), flush=True)
        set_meta(db, "last_full_scan", time.strftime("%Y-%m-%d %H:%M:%S"))
    finally:
        set_meta(db, "running", "no")
        db.commit()

    nchunks = db.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
    nfiles = db.execute("SELECT COUNT(*) FROM files").fetchone()[0]
    print("%s model=%s | roots=%d | changed=%d skipped=%d pruned=%d | files=%d chunks=%d | %.0fs"
          % (time.strftime("%Y-%m-%d %H:%M:%S"), name, len(roots), counts["changed"], counts["skip"],
             counts["gone"], nfiles, nchunks, time.time() - t0))


if __name__ == "__main__":
    main()
