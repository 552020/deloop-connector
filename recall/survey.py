#!/usr/bin/env python3
"""Counts and dates of a path the person names, never its contents: what /deloop agent reports
before a path goes into archive.md. Runs with the system python3, no packages needed.

  survey.py PATH ...    one JSON line per path
  survey.py --index     the index: running or not, progress, files, chunks, last run

Apple Mail: from the catalogue (MailData/Envelope Index, SQLite), copied with its -wal and -shm
and opened read-only, so no mail is opened. mbox (Thunderbird, exports): message separators and
Date headers only. A folder: files by kind and the range of their modification dates.
"""
import glob
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import time
from email.utils import parsedate_to_datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402  (no third-party imports at module level)


def day(ts):
    return time.strftime("%Y-%m-%d", time.localtime(ts)) if ts else None


def apple_mail(path):
    """The Envelope Index under PATH (~/Library/Mail, or one V* folder), or None."""
    found = sorted(glob.glob(os.path.join(path, "V*", "MailData", "Envelope Index")) +
                   glob.glob(os.path.join(path, "MailData", "Envelope Index")))
    if not found:
        return None
    src = found[-1]
    tmp = tempfile.mkdtemp(prefix="deloop-survey-")
    try:
        for suffix in ("", "-wal", "-shm"):
            if os.path.exists(src + suffix):
                shutil.copy2(src + suffix, os.path.join(tmp, "Envelope Index" + suffix))
        db = sqlite3.connect("file:%s?mode=ro" % os.path.join(tmp, "Envelope Index"), uri=True)
        n, first, last = db.execute(
            "SELECT COUNT(*), MIN(date_received), MAX(date_received) FROM messages "
            "WHERE date_received > 0").fetchone()
        boxes = db.execute("SELECT COUNT(DISTINCT mailbox) FROM messages").fetchone()[0]
        accounts = set()
        for (url,) in db.execute("SELECT url FROM mailboxes"):
            m = re.match(r"^[a-z]+://([^/]+)", url or "")
            if m:
                accounts.add(m.group(1))
        db.close()
        local = sum(1 for p in common.file_list([path]) if p.endswith(".emlx"))
        return {"kind": "Apple Mail", "messages": n, "on_this_computer": local, "from": day(first),
                "to": day(last), "mailboxes": boxes, "accounts": len(accounts)}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def mbox(paths):
    n, first, last = 0, None, None
    expect_date = False
    for p in paths:
        try:
            f = open(p, "rb")
        except OSError:
            continue
        with f:
            for line in f:
                if line.startswith(b"From "):
                    n += 1
                    expect_date = True
                elif expect_date and line[:5].lower() == b"date:":
                    expect_date = False
                    try:
                        d = parsedate_to_datetime(line[5:].decode("latin-1").strip()).timestamp()
                    except (TypeError, ValueError, IndexError, OverflowError):
                        continue
                    first = d if first is None or d < first else first
                    last = d if last is None or d > last else last
                elif expect_date and line in (b"\n", b"\r\n"):
                    expect_date = False   # end of headers without a Date
    return {"kind": "mbox", "messages": n, "files": len(paths), "from": day(first), "to": day(last)}


def folder(path):
    kinds, first, last, total = {}, None, None, 0
    for p in common.file_list([path]):
        try:
            m = os.stat(p).st_mtime
        except OSError:
            continue
        total += 1
        ext = os.path.splitext(p)[1].lower().lstrip(".") or "mbox"
        kinds[ext] = kinds.get(ext, 0) + 1
        first = m if first is None or m < first else first
        last = m if last is None or m > last else last
    return {"kind": "folder", "files": total, "by_kind": dict(sorted(kinds.items(), key=lambda kv: -kv[1])),
            "from": day(first), "to": day(last)}


def survey(path):
    path = os.path.abspath(os.path.expanduser(path))
    out = {"path": path}
    if not os.path.exists(path):
        return dict(out, error="not found")
    if not os.access(path, os.R_OK) or (os.path.isdir(path) and not _listable(path)):
        return dict(out, error="not readable: on macOS, give the terminal or editor Full Disk Access")
    try:
        mail = apple_mail(path) if os.path.isdir(path) else None
    except (OSError, sqlite3.Error):
        return dict(out, error="not readable: on macOS, give the terminal or editor Full Disk Access")
    if mail:
        return dict(out, **mail)
    if os.path.isfile(path):
        return dict(out, **(mbox([path]) if common.is_mbox_file(path) else folder(path)))
    files = common.file_list([path])
    mboxes = [p for p in files if common.is_mbox_file(p)]
    if mboxes and len(mboxes) * 2 >= len(files):   # a Thunderbird profile or a folder of exports
        return dict(out, **mbox(mboxes))
    return dict(out, **folder(path))


def _listable(path):
    try:
        os.listdir(path)
        return True
    except OSError:
        return False


def index_state():
    if not os.path.exists(common.DB_PATH):
        return {"index": "none"}
    db = sqlite3.connect("file:%s?mode=ro" % common.DB_PATH, uri=True)
    meta = dict(db.execute("SELECT key, value FROM meta").fetchall())
    files = db.execute("SELECT COUNT(*) FROM files").fetchone()[0]
    chunks = db.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
    return {"index": common.DB_PATH, "running": meta.get("running") == "yes",
            "done": int(meta.get("done", 0)), "total": int(meta.get("total", 0)),
            "files": files, "chunks": chunks, "model": meta.get("model"),
            "last_full_scan": meta.get("last_full_scan"),
            "size_mb": round(os.path.getsize(common.DB_PATH) / 1e6, 1)}


def main():
    if sys.argv[1:] == ["--index"]:
        print(json.dumps(index_state()))
        return
    if not sys.argv[1:]:
        sys.exit(__doc__)
    for p in sys.argv[1:]:
        print(json.dumps(survey(p), ensure_ascii=False))


if __name__ == "__main__":
    main()
