#!/usr/bin/env python3
"""What this computer can carry as the agent's local learner: chip, memory, free disk, Ollama,
and from them the model class and one sentence for the person. System python3, no packages.

  machine.py           one JSON object
  machine.py --text    the sentence alone

The learner reads the archive for the catalogue proposals and writes memory, in the owner room,
on this computer. Speaking in rooms with others stays on the cloud model.
"""
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import urllib.request

# Memory (GB) -> the model class and the Ollama model of the learner. Qwen 3: tool calls, and German,
# Italian and English in one archive. Sizes are the 4-bit downloads.
TIERS = [
    (64, "32B", "qwen3:32b", 20.0),
    (32, "14B", "qwen3:14b", 9.3),
    (16, "8B", "qwen3:8b", 5.2),
    (8, "3B", "qwen3:4b", 2.6),
]
EMBEDDING_GB = 1.0   # the recall's default embedding model


def _out(cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return ""


def chip():
    system = platform.system()
    if system == "Darwin":
        name = _out(["sysctl", "-n", "machdep.cpu.brand_string"])
        apple = _out(["sysctl", "-n", "hw.optional.arm64"]) == "1"
        return name or platform.machine(), apple
    name = ""
    try:
        m = re.search(r"^model name\s*:\s*(.+)$", open("/proc/cpuinfo").read(), re.M)
        name = m.group(1) if m else ""
    except OSError:
        pass
    return name or platform.machine(), False


def nvidia():
    """(name, memory in GB) of the first NVIDIA card, or None."""
    if not shutil.which("nvidia-smi"):
        return None
    line = _out(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]).split("\n")[0]
    if "," not in line:
        return None
    name, mib = [x.strip() for x in line.split(",", 1)]
    try:
        return name, round(int(mib) / 1024, 1)
    except ValueError:
        return None


def memory():
    """(total, available) in GB."""
    if platform.system() == "Darwin":
        total = int(_out(["sysctl", "-n", "hw.memsize"]) or 0) / 1e9
        vm = _out(["vm_stat"])
        page = int((re.search(r"page size of (\d+)", vm) or [0, 16384])[1])
        pages = sum(int(x) for k in ("Pages free", "Pages inactive", "Pages speculative", "Pages purgeable")
                    for x in re.findall(r"^%s:\s+(\d+)" % k, vm, re.M))
        return round(total, 1), round(pages * page / 1e9, 1)
    info = {}
    try:
        for line in open("/proc/meminfo"):
            k, v = line.split(":", 1)
            info[k] = int(v.split()[0]) * 1024 / 1e9
    except OSError:
        pass
    return round(info.get("MemTotal", 0), 1), round(info.get("MemAvailable", 0), 1)


def ollama():
    """Installed, running, and the models it holds."""
    installed = bool(shutil.which("ollama")) or os.path.exists("/Applications/Ollama.app")
    try:
        with urllib.request.urlopen("http://127.0.0.1:11434/api/tags", timeout=2) as r:
            models = [m["name"] for m in json.load(r).get("models", [])]
        return {"installed": True, "running": True, "models": models}
    except (OSError, ValueError):
        return {"installed": installed, "running": False, "models": []}


def tier_index(gb):
    for i, (floor, _, _, _) in enumerate(TIERS):
        if gb >= floor * 0.94:   # an "8 GB" machine reports a little less
            return i
    return None


def survey():
    name, apple = chip()
    gpu = nvidia()
    total, available = memory()
    disk = round(shutil.disk_usage(os.path.expanduser("~")).free / 1e9, 1)
    # Apple Silicon shares its memory with the GPU; an NVIDIA card counts with its own memory;
    # a CPU alone runs at half the size.
    if apple:
        usable, accel = total, "Apple Silicon"
    elif gpu:
        usable, accel = gpu[1], "NVIDIA " + gpu[0]
    else:
        usable, accel = total / 2, "CPU only"
    i = tier_index(usable)
    stepped = False
    # Free memory beside what the person already runs (shared memory only): below twice the model, one size down.
    while i is not None and i < len(TIERS) - 1 and (apple or not gpu) and available < 2 * TIERS[i][3]:
        i += 1
        stepped = True
    tier = TIERS[i][1:] if i is not None else None
    out = {"chip": name, "accelerator": accel, "memory_gb": total, "available_gb": available,
           "gpu_memory_gb": gpu[1] if gpu else None, "disk_free_gb": disk, "ollama": ollama()}
    if not tier:
        out.update(tier=None, model=None, choice="cloud")
        out["sentence"] = ("This computer is too small for a local model: your agent can read your mail only through "
                           "the cloud model, which then sees it.")
        return out
    cls, model, size = tier
    need = size + EMBEDDING_GB
    out.update(tier=cls, model=model, model_gb=size, stepped_down=stepped, disk_needed_gb=round(need + 1, 1))
    if disk < need + 1:
        out["choice"] = "cloud"
        out["sentence"] = ("This computer could carry a %s model, but has only %s GB free and needs about %s: free some "
                           "space, or let the cloud model read your mail, which then sees it." % (cls, disk, round(need + 1)))
    elif cls == "3B":
        out["choice"] = "ask"
        out["sentence"] = ("This computer carries a small model (3B): your mail is read here and nothing leaves it, but "
                           "its proposals for your catalogue are poorer. Or the cloud model reads your mail: better "
                           "proposals, and it sees the mail.")
    else:
        out["choice"] = "local"
        out["sentence"] = ("This computer carries a %s model: your mail is read here, by a model on this computer, and "
                           "nothing of it leaves." % cls)
    return out


if __name__ == "__main__":
    s = survey()
    print(s["sentence"] if sys.argv[1:] == ["--text"] else json.dumps(s))
