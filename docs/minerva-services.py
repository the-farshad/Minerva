#!/usr/bin/env python3
"""
Minerva local services — combined yt-dlp downloader + CORS proxy.

Run with the system Python:
    python3 minerva-services.py

On first run the script creates a virtual environment under
~/.minerva-services, installs Flask + yt-dlp + requests into it, then
re-executes itself inside the venv. Subsequent runs reuse the venv
and start immediately.

Both endpoints are served from one process on a single port (default
8765) to minimise setup. In Minerva → Settings, set:

    yt-dlp server      http://localhost:8765
    CORS proxy         http://localhost:8765/proxy?

Override:
    MINERVA_HOST          bind address (default 127.0.0.1)
    MINERVA_PORT          port (default 8765)
    MINERVA_VENV          venv path (default ~/.minerva-services)

Health probe:  GET /health   → { ok: true, services: [...] }
Status page:   GET /         → small HTML overview
"""

import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import venv as _venv

# ---------------------------------------------------------------------------
# Bootstrap.
# ---------------------------------------------------------------------------

REQUIREMENTS = ("flask", "yt-dlp", "requests")
VENV_DIR = pathlib.Path(
    os.environ.get("MINERVA_VENV") or (pathlib.Path.home() / ".minerva-services")
).expanduser()


def _venv_python() -> pathlib.Path:
    if os.name == "nt":
        return VENV_DIR / "Scripts" / "python.exe"
    return VENV_DIR / "bin" / "python"


def _bootstrap_and_reexec() -> None:
    target = _venv_python()
    current = pathlib.Path(sys.executable).resolve()
    if target.exists() and current == target.resolve():
        return

    if not target.exists():
        print(f"[minerva] creating venv at {VENV_DIR} …", file=sys.stderr)
        _venv.create(VENV_DIR, with_pip=True, symlinks=os.name != "nt")

    print(f"[minerva] installing {', '.join(REQUIREMENTS)} into venv (one-time) …", file=sys.stderr)
    proc = subprocess.run(
        [str(target), "-m", "pip", "install", "--upgrade", "--quiet", *REQUIREMENTS],
        check=False,
    )
    if proc.returncode != 0:
        print(
            "[minerva] pip install failed. Re-run for verbose output: "
            f"{target} -m pip install {' '.join(REQUIREMENTS)}",
            file=sys.stderr,
        )
        sys.exit(proc.returncode)

    os.execv(str(target), [str(target), os.path.abspath(__file__), *sys.argv[1:]])


_bootstrap_and_reexec()

# ---------------------------------------------------------------------------
# Server.
# ---------------------------------------------------------------------------

from urllib.parse import unquote, urlparse  # noqa: E402

import requests  # noqa: E402
import yt_dlp  # noqa: E402
from flask import (  # noqa: E402
    Flask,
    Response,
    after_this_request,
    jsonify,
    request,
    send_file,
)

app = Flask(__name__)

PROXY_ALLOWED_HOSTS = {
    "export.arxiv.org", "arxiv.org",
    "api.crossref.org",
    "www.youtube.com", "youtube.com", "youtu.be",
    "api.semanticscholar.org",
}


def _cors_dict():
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Expose-Headers": "*",
    }


@app.after_request
def _add_cors(resp):
    for k, v in _cors_dict().items():
        resp.headers.setdefault(k, v)
    return resp


# ---------- yt-dlp downloader ---------------------------------------------

@app.route("/download", methods=["POST", "OPTIONS"])
def download():
    if request.method == "OPTIONS":
        return ("", 204, _cors_dict())

    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    fmt = (data.get("format") or "mp4").strip()
    if not url:
        return ("Missing 'url' in request body.", 400)

    tmpdir = tempfile.mkdtemp(prefix="minerva-ytdl-")
    out_template = os.path.join(tmpdir, "%(id)s.%(ext)s")
    ydl_opts = {
        "outtmpl": out_template,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "merge_output_format": "mp4",
    }
    if fmt == "mp3":
        ydl_opts["format"] = "bestaudio/best"
        ydl_opts["postprocessors"] = [
            {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"}
        ]
    elif fmt == "bestaudio":
        ydl_opts["format"] = "bestaudio/best"
    elif fmt == "best":
        ydl_opts["format"] = "best"
    elif fmt == "bestvideo+bestaudio/best":
        ydl_opts["format"] = "bestvideo+bestaudio/best"
    else:
        ydl_opts["format"] = "mp4"

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            path = ydl.prepare_filename(info)
            if not os.path.exists(path):
                base, _ = os.path.splitext(path)
                for ext in (".mp3", ".m4a", ".webm", ".mkv", ".mp4"):
                    if os.path.exists(base + ext):
                        path = base + ext
                        break
    except Exception as exc:  # noqa: BLE001
        shutil.rmtree(tmpdir, ignore_errors=True)
        return (f"yt-dlp failed: {exc}", 500)

    @after_this_request
    def _cleanup(resp):
        try:
            shutil.rmtree(tmpdir, ignore_errors=True)
        except Exception:
            pass
        return resp

    return send_file(
        path,
        as_attachment=True,
        download_name=os.path.basename(path),
        conditional=False,
    )


# ---------- CORS proxy -----------------------------------------------------

@app.route("/proxy", methods=["GET", "POST", "OPTIONS"])
def proxy():
    if request.method == "OPTIONS":
        return ("", 204, _cors_dict())

    target = request.query_string.decode("utf-8", "replace").lstrip("?")
    if not target:
        return ("Empty target. Append a URL-encoded URL after `?`.", 400, _cors_dict())

    decoded = unquote(target)
    host = urlparse(decoded).hostname or ""
    if host not in PROXY_ALLOWED_HOSTS:
        return (
            f"Host '{host}' is not in the allow-list. "
            "Edit PROXY_ALLOWED_HOSTS in minerva-services.py to permit it.",
            403,
            _cors_dict(),
        )

    fwd = {
        h: request.headers[h]
        for h in ("Accept", "Accept-Language", "Content-Type", "User-Agent")
        if h in request.headers
    }

    try:
        if request.method == "GET":
            up = requests.get(decoded, headers=fwd, stream=True, timeout=30)
        else:
            up = requests.post(
                decoded, headers=fwd, data=request.get_data(),
                stream=True, timeout=30,
            )
    except requests.RequestException as exc:
        return (f"Upstream fetch failed: {exc}", 502, _cors_dict())

    out = dict(_cors_dict())
    for h in ("Content-Type", "Content-Length", "Cache-Control"):
        if h in up.headers:
            out[h] = up.headers[h]

    return Response(
        up.iter_content(chunk_size=8192),
        status=up.status_code,
        headers=out,
    )


# ---------- meta endpoints ------------------------------------------------

@app.route("/health", methods=["GET"])
def health():
    # Browsers asking for /health (e.g. via the Settings status pill)
    # get JSON back; humans following a link from a chat / log get a
    # tiny human-readable status page when their Accept header asks
    # for HTML. Same data either way.
    accept = (request.headers.get("Accept") or "").lower()
    payload = {
        "ok": True,
        "service": "minerva-services",
        "endpoints": ["/download", "/proxy", "/health", "/shutdown", "/"],
    }
    if "text/html" in accept and "application/json" not in accept:
        return (
            """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>minerva-services / health</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 560px;
           margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }
    .ok { color: #2c8c3e; font-weight: 600; }
    code { background: #f3f3f3; padding: 0.1rem 0.4rem; border-radius: 4px; }
    ul { padding-left: 1.2rem; }
  </style>
</head>
<body>
  <h1>minerva-services <span class="ok">healthy</span></h1>
  <p>Endpoints exposed by this process:</p>
  <ul>
    <li><code>POST /download</code></li>
    <li><code>GET /proxy?&lt;encoded-url&gt;</code></li>
    <li><code>POST /shutdown</code> (loopback only)</li>
    <li><code>GET /health</code> (this page)</li>
  </ul>
  <p>Need the JSON form?
  <a href=\"/health\" onclick=\"event.preventDefault();fetch('/health',{headers:{Accept:'application/json'}}).then(function(r){return r.json()}).then(function(d){document.getElementById('json').textContent=JSON.stringify(d,null,2)});\">click here</a>:</p>
  <pre id=\"json\" style=\"background:#f3f3f3;padding:0.6rem;border-radius:4px;\"></pre>
</body>
</html>""",
            200,
            {"Content-Type": "text/html; charset=utf-8"},
        )
    return jsonify(payload)


@app.route("/shutdown", methods=["POST", "OPTIONS"])
def shutdown():
    # Soft remote stop. Accepts only loopback connections by default;
    # set MINERVA_ALLOW_REMOTE_SHUTDOWN=1 to opt into accepting LAN
    # requests too. The actual exit is delayed by a thread so the
    # response can flush back to the client.
    if request.method == "OPTIONS":
        return ("", 204, _cors_dict())
    remote = request.remote_addr or ""
    allow_remote = os.environ.get("MINERVA_ALLOW_REMOTE_SHUTDOWN") == "1"
    if not allow_remote and remote not in ("127.0.0.1", "::1", "localhost"):
        return ("Shutdown is restricted to loopback callers.", 403, _cors_dict())
    import threading
    threading.Timer(0.2, lambda: os._exit(0)).start()
    return jsonify({"ok": True, "stopping": True})


@app.route("/", methods=["GET"])
def index():
    return (
        """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Minerva local services</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px;
           margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }
    code { background: #f3f3f3; padding: 0.1rem 0.4rem; border-radius: 4px; }
    .ok { color: #2c8c3e; }
    ul { padding-left: 1.2rem; }
  </style>
</head>
<body>
  <h1>Minerva local services <span class="ok">running</span></h1>
  <p>One process, two endpoints. Wire them into Minerva at
  <em>Settings</em>:</p>
  <ul>
    <li>yt-dlp server &rarr; <code>http://localhost:""" + str(int(os.environ.get("MINERVA_PORT", "8765"))) + """</code></li>
    <li>CORS proxy &rarr; <code>http://localhost:""" + str(int(os.environ.get("MINERVA_PORT", "8765"))) + """/proxy?</code></li>
  </ul>
  <p>Health: <a href="/health">/health</a>.</p>
</body>
</html>""",
        200,
        {"Content-Type": "text/html; charset=utf-8"},
    )


def _detach() -> None:
    """Fork the current process into the background (POSIX only).

    Returns to the caller in the child; the parent exits cleanly. The
    child is reparented to init so closing the controlling terminal
    doesn't kill the server. Logs go to ~/.minerva-services/server.log.
    """
    if os.name == "nt":
        print("[minerva] --detach is POSIX-only. Run via 'pythonw' or a Windows service.", file=sys.stderr)
        return
    log_path = VENV_DIR / "server.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    pid = os.fork()
    if pid > 0:
        # Parent.
        print(f"[minerva] backgrounded (pid {pid}). Logs: {log_path}")
        sys.exit(0)
    # Child: detach from controlling terminal, redirect std streams.
    os.setsid()
    sys.stdout.flush(); sys.stderr.flush()
    f = open(log_path, "ab", buffering=0)
    os.dup2(f.fileno(), sys.stdout.fileno())
    os.dup2(f.fileno(), sys.stderr.fileno())


if __name__ == "__main__":
    host = os.environ.get("MINERVA_HOST", "127.0.0.1")
    port = int(os.environ.get("MINERVA_PORT", "8765"))
    detach = "--detach" in sys.argv or "-d" in sys.argv

    base = f"http://{host}:{port}"
    if detach:
        _detach()
    print("─" * 60)
    print(f"  minerva-services running at {base}")
    print("─" * 60)
    print(f"  Settings → yt-dlp server   {base}")
    print(f"  Settings → CORS proxy      {base}/proxy?")
    print(f"  Open in browser:           {base}/")
    print(f"  Health check:              {base}/health")
    print(f"  Stop the server:           POST {base}/shutdown")
    print(f"  Docs:                      docs/setup-local-services.md")
    print("─" * 60)
    if not detach:
        print("  Press Ctrl-C to stop. Run with --detach to background.")
    print("─" * 60)
    app.run(host=host, port=port, threaded=True)
