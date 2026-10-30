"""The agent's recall: an index over the paths in ~/.deloop/agent/archive.md, on this computer.

From HER's recall (her/lab/recall). Files are the source of truth; the index is a rebuildable
finder beside them, in ~/.deloop/recall, outside the package so that update keeps it.
Pipeline: the archive's paths -> text per file or per mail, by code -> chunks -> FTS5 words
plus vectors from a small local model (fastembed). Nothing leaves the computer except the
model's one download on first use.
"""
import email
import email.policy
from email.header import decode_header, make_header
import mailbox
import os
import re
import subprocess
from email.utils import parsedate_to_datetime

DELOOP = os.environ.get("DELOOP_HOME") or os.path.expanduser("~/.deloop")
ARCHIVE = os.path.join(DELOOP, "agent", "archive.md")
DATA = os.path.join(DELOOP, "recall")
DB_PATH = os.path.join(DATA, "index.db")
LOCK_PATH = DB_PATH + ".lock"
SCHEMA_VERSION = "deloop-2"  # raise when the text a file gives changes, so every index is rebuilt

# Multilingual is the requirement, not the size. fastembed offers three: MiniLM-L12 (0.22 GB),
# mpnet-base (1.0 GB, the default) and e5-large (2.24 GB, HER's); DELOOP_RECALL_MODEL picks another.
MODEL = os.environ.get("DELOOP_RECALL_MODEL") or "sentence-transformers/paraphrase-multilingual-mpnet-base-v2"

SKIP_DIRS = {"node_modules", ".git", ".next", ".venv", "venv", "__pycache__", "dist", "build",
             "Attachments"}  # Apple Mail's copies of attachments; the .emlx holds them already

TEXT_EXTS = (".md", ".txt")
TEXTUTIL_EXTS = (".docx", ".doc", ".odt", ".rtf")
PDF_EXTS = (".pdf",)
EMLX_EXTS = (".emlx",)
EML_EXTS = (".eml",)
MBOX_EXTS = (".mbox",)
EXTS = TEXT_EXTS + TEXTUTIL_EXTS + PDF_EXTS + EMLX_EXTS + EML_EXTS + MBOX_EXTS

PDF_MAX_PAGES = 60
MAX_FILE_BYTES = 5_000_000
MAX_MAIL_WORDS = 3000   # a mail longer than this is a newsletter or a pasted log; its head is enough

MAX_WORDS = 280
OVERLAP_WORDS = 50

_model = None


# ---- the archive's paths ----

def archive_roots(archive=ARCHIVE):
    """The paths of archive.md, one per '- ' line: the first `backticked` text, else the text
    before ' — ', ': ' or ' ('. Expanded and absolute; lines without a path are skipped."""
    roots = []
    try:
        lines = open(archive, encoding="utf-8").read().split("\n")
    except OSError:
        return roots
    for line in lines:
        m = re.match(r"^\s*[-*]\s+(.*)$", line)
        if not m or not m.group(1).strip():
            continue
        item = m.group(1).strip()
        b = re.search(r"`([^`]+)`", item)
        path = b.group(1) if b else re.split(r" — | - |: | \(", item, maxsplit=1)[0]
        path = os.path.abspath(os.path.expanduser(path.strip()))
        if path.startswith("/") and os.path.exists(path):
            roots.append(path)
    return sorted(set(roots))


def under(path, roots):
    return any(path == r or path.startswith(r.rstrip("/") + "/") for r in roots)


def is_mbox_file(path):
    """Thunderbird's folders are mbox files without an extension."""
    if os.path.splitext(path)[1]:
        return path.lower().endswith(MBOX_EXTS) and os.path.isfile(path)
    try:
        with open(path, "rb") as f:
            return f.read(5) == b"From "
    except OSError:
        return False


def wanted(path):
    low = path.lower()
    name = os.path.basename(path)
    if name.startswith("._") or name.startswith("."):
        return False
    return low.endswith(EXTS) or is_mbox_file(path)


def file_list(roots):
    out = set()
    for root in roots:
        if os.path.isfile(root):
            if wanted(root):
                out.add(root)
            continue
        for dirpath, dirs, files in os.walk(root):
            # An Apple Mail folder ends in .mbox but is a directory: walk into it.
            dirs[:] = [d for d in dirs if not d.startswith(".") and d not in SKIP_DIRS]
            for fn in files:
                p = os.path.join(dirpath, fn)
                if wanted(p):
                    out.add(p)
    return sorted(out)


# ---- the model ----

def get_model():
    global _model
    if _model is None:
        from fastembed import TextEmbedding
        _model = TextEmbedding(model_name=MODEL, cache_dir=os.path.join(DATA, "models"))
    return _model, MODEL


def _is_e5(name):
    return "e5" in name.lower()


def embed_passages(texts):
    model, name = get_model()
    if _is_e5(name):
        texts = ["passage: " + t for t in texts]
    return [list(map(float, v)) for v in model.embed(texts)]


def embed_query(text):
    model, name = get_model()
    if _is_e5(name):
        text = "query: " + text
    return list(map(float, next(iter(model.embed([text])))))


# ---- text, by code ----

def _run(cmd):
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout.decode("utf-8", errors="replace") if r.returncode == 0 else None


def pdf_pages(path):
    """Page texts, or None if unreadable, too long, or without a text layer."""
    info = _run(["pdfinfo", path]) or ""
    m = re.search(r"^Pages:\s+(\d+)", info, re.M)
    if not m or int(m.group(1)) > PDF_MAX_PAGES:
        return None
    text = _run(["pdftotext", "-layout", "-enc", "UTF-8", path, "-"])
    if text is None:
        return None
    pages = text.split("\f")
    if sum(len(p.split()) for p in pages) < 20:   # a scan without OCR
        return None
    return pages


def office_text(path):
    text = _run(["textutil", "-convert", "txt", "-stdout", path])   # macOS
    if text is None:
        text = _run(["pandoc", "-t", "plain", path])                 # Linux, if present
    return text or ""


def read_lines(path):
    if path.lower().endswith(TEXTUTIL_EXTS):
        return office_text(path).split("\n")
    try:
        if os.path.getsize(path) > MAX_FILE_BYTES:
            return []
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read().split("\n")
    except OSError:
        return []


def _strip_html(html):
    html = re.sub(r"(?is)<(script|style|head).*?</\1>", " ", html)
    html = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</tr>", "\n", html)
    text = re.sub(r"<[^>]+>", " ", html)
    for a, b in (("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&#39;", "'")):
        text = text.replace(a, b)
    return text


def _quoted_away(text):
    """Drops quoted earlier mails ('> ' lines, and everything after 'On … wrote:'), which
    are indexed already as their own messages."""
    out = []
    for line in text.split("\n"):
        if re.match(r"^\s*(On|Am|Il|Le) .{5,200}(wrote|schrieb|ha scritto|a écrit)\b.{0,100}:\s*$", line):
            break
        if line.lstrip().startswith(">"):
            continue
        out.append(line)
    return "\n".join(out)


def _header(msg, name):
    """A header as text: RFC 2047 words decoded, raw 8-bit bytes read as UTF-8."""
    v = msg.get(name)
    if v is None:
        return ""
    try:
        v = str(make_header(decode_header(str(v))))
    except (UnicodeError, LookupError, ValueError):
        v = str(v)
    return v.encode("utf-8", "surrogateescape").decode("utf-8", "replace").strip()


def mail_text(msg):
    """(heading, date, body) of one message: heading 'Subject — From', body the plain text."""
    subject, sender, to = _header(msg, "Subject"), _header(msg, "From"), _header(msg, "To")
    date = None
    try:
        date = parsedate_to_datetime(str(msg.get("Date"))) if msg.get("Date") else None
    except (TypeError, ValueError):
        pass
    plain, html = [], []
    for part in msg.walk():
        if part.is_multipart() or part.get_content_disposition() == "attachment":
            continue
        ctype = part.get_content_type()
        if ctype not in ("text/plain", "text/html"):
            continue
        try:
            payload = part.get_payload(decode=True) or b""
            text = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
        except (LookupError, AssertionError):
            continue
        (plain if ctype == "text/plain" else html).append(text)
    body = "\n".join(plain) if plain else _strip_html("\n".join(html))
    words = _quoted_away(body).split()[:MAX_MAIL_WORDS]
    head = "\n".join(x for x in (
        "Subject: " + subject if subject else "",
        "From: " + sender if sender else "",
        "To: " + to if to else "",
        "Date: " + date.strftime("%Y-%m-%d %H:%M") if date else "") if x)
    heading = " — ".join(x for x in (subject, sender) if x)[:200]
    return heading, date, head + "\n\n" + " ".join(words)


def read_emlx(path):
    """Apple Mail: one line with the byte length, the RFC 822 message, then an XML plist."""
    with open(path, "rb") as f:
        raw = f.read()
    nl = raw.find(b"\n")
    try:
        length = int(raw[:nl].strip())
        raw = raw[nl + 1:nl + 1 + length]
    except ValueError:
        raw = raw[nl + 1:]
    return email.message_from_bytes(raw, policy=email.policy.default)


def read_eml(path):
    with open(path, "rb") as f:
        return email.message_from_bytes(f.read(), policy=email.policy.default)


def mbox_messages(path):
    try:
        return list(mailbox.mbox(path, create=False,
                                 factory=lambda f: email.message_from_binary_file(f, policy=email.policy.default)))
    except (OSError, mailbox.Error):
        return []


# ---- chunks ----

def _window(text):
    words = text.split()
    if len(words) <= MAX_WORDS:
        return [text]
    step = max(1, MAX_WORDS - OVERLAP_WORDS)
    return [" ".join(words[j:j + MAX_WORDS]) for j in range(0, len(words), step)]


def chunk_file(path):
    """(unit, chunks), chunks = [(heading, start, end, text)].
    unit 'line': 1-indexed lines; 'page': PDF pages; 'mail': one mail, start = end = 1;
    'message': the n-th message of an mbox file."""
    low = path.lower()
    if low.endswith(PDF_EXTS):
        pages = pdf_pages(path)
        if not pages:
            return "page", []
        return "page", [("", n, n, sub) for n, page in enumerate(pages, 1) if page.strip()
                        for sub in _window(page)]

    if low.endswith(EMLX_EXTS + EML_EXTS):
        try:
            msg = read_emlx(path) if low.endswith(EMLX_EXTS) else read_eml(path)
        except OSError:
            return "mail", []
        heading, _, text = mail_text(msg)
        return "mail", [(heading, 1, 1, sub) for sub in _window(text)] if text.strip() else []

    if is_mbox_file(path):
        chunks = []
        for n, msg in enumerate(mbox_messages(path), 1):
            heading, _, text = mail_text(msg)
            chunks.extend((heading, n, n, sub) for sub in _window(text))
        return "message", chunks

    lines = read_lines(path)
    sections, buf = [], []
    cur_heading, cur_start = "", 0

    def flush(end_idx):
        if any(l.strip() for l in buf):
            sections.append((cur_heading, cur_start, end_idx, "\n".join(buf)))

    for i, line in enumerate(lines):
        if re.match(r"^#{1,6}\s", line):
            flush(i - 1)
            cur_heading, cur_start, buf = line.lstrip("#").strip(), i, [line]
        else:
            buf.append(line)
    flush(len(lines) - 1)
    return "line", [(h, s + 1, e + 1, sub) for h, s, e, text in sections for sub in _window(text)]
