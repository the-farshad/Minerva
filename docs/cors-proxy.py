#!/usr/bin/env python3
"""
Minerva CORS proxy — self-bootstrapping.

Run with the system Python:
    python3 cors-proxy.py

On first run the script creates a virtual environment under
~/.minerva-cors, installs Flask + requests into it, then re-executes
itself inside the venv. Subsequent runs reuse the venv and start
immediately.

Override the venv location with the MINERVA_CORS_VENV environment
variable. Bind via MINERVA_CORS_HOST and MINERVA_CORS_PORT.

In Minerva → Settings → "CORS proxy" paste:
    http://localhost:8081/?
(the trailing `?` matters — the prefix is concatenated with a
URL-encoded target).
"""

import os
import pathlib
import subprocess
import sys
import venv as _venv

# ---------------------------------------------------------------------------
# Bootstrap — venv + deps before importing anything not in the stdlib.
# ---------------------------------------------------------------------------

REQUIREMENTS = ("flask", "requests")
VENV_DIR = pathlib.Path(
    os.environ.get("MINERVA_CORS_VENV") or (pathlib.Path.home() / ".minerva-cors")
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
        print(f"[minerva-cors] creating venv at {VENV_DIR} …", file=sys.stderr)
        _venv.create(VENV_DIR, with_pip=True, symlinks=os.name != "nt")

    print(f"[minerva-cors] installing {', '.join(REQUIREMENTS)} into venv …", file=sys.stderr)
    proc = subprocess.run(
        [str(target), "-m", "pip", "install", "--upgrade", "--quiet", *REQUIREMENTS],
        check=False,
    )
    if proc.returncode != 0:
        print(
            "[minerva-cors] pip install failed — re-run manually with verbose output: "
            f"{target} -m pip install {' '.join(REQUIREMENTS)}",
            file=sys.stderr,
        )
        sys.exit(proc.returncode)

    os.execv(str(target), [str(target), os.path.abspath(__file__), *sys.argv[1:]])


_bootstrap_and_reexec()

# ---------------------------------------------------------------------------
# Proxy server (only reached once the venv has Flask + requests).
# ---------------------------------------------------------------------------

from urllib.parse import unquote, urlparse  # noqa: E402

import requests  # noqa: E402
from flask import Flask, request, Response, jsonify  # noqa: E402

app = Flask(__name__)

ALLOWED_HOSTS = {
    "export.arxiv.org", "arxiv.org",
    "api.crossref.org",
    "www.youtube.com", "youtube.com", "youtu.be",
    "api.semanticscholar.org",
}


def _cors_headers():
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Expose-Headers": "*",
    }


def index():
    return (
        """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Minerva CORS proxy</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px;
           margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }
    code { background: #f3f3f3; padding: 0.1rem 0.4rem; border-radius: 4px; }
    .ok { color: #2c8c3e; }
  </style>
</head>
<body>
  <h1>Minerva CORS proxy <span class="ok">ok</span></h1>
  <p>Proxies bibliographic fetches that browsers can't issue directly
  due to missing CORS headers (arXiv, CrossRef, Semantic Scholar,
  YouTube oEmbed).</p>
  <p>Usage: append a URL-encoded target after <code>?</code>, e.g.
  <code>/?https%3A%2F%2Fexport.arxiv.org%2Fapi%2Fquery%3Fid_list%3D2401.12345</code>.</p>
  <p>Wire it into Minerva at <em>Settings &rarr; CORS proxy</em>:
  <code>http://localhost:8081/?</code>.</p>
  <p>Health check: <a href="/health">/health</a>.</p>
</body>
</html>""",
        200,
        {"Content-Type": "text/html; charset=utf-8"},
    )


@app.route("/", methods=["GET", "POST", "OPTIONS"])
def proxy():
    if request.method == "OPTIONS":
        return ("", 204, _cors_headers())

    target = request.query_string.decode("utf-8", "replace").lstrip("?")
    if not target:
        if request.method == "GET":
            return index()
        return ("Empty target. Append a URL-encoded URL after `?`.", 400, _cors_headers())

    decoded = unquote(target)
    host = urlparse(decoded).hostname or ""
    if host not in ALLOWED_HOSTS:
        return (
            f"Host '{host}' is not in the allow-list. Edit ALLOWED_HOSTS in cors-proxy.py to permit it.",
            403,
            _cors_headers(),
        )

    fwd_headers = {
        h: request.headers[h]
        for h in ("Accept", "Accept-Language", "Content-Type", "User-Agent")
        if h in request.headers
    }

    try:
        if request.method == "GET":
            upstream = requests.get(decoded, headers=fwd_headers, stream=True, timeout=30)
        else:
            upstream = requests.post(
                decoded, headers=fwd_headers, data=request.get_data(),
                stream=True, timeout=30,
            )
    except requests.RequestException as exc:
        return (f"Upstream fetch failed: {exc}", 502, _cors_headers())

    out_headers = dict(_cors_headers())
    for h in ("Content-Type", "Content-Length", "Cache-Control"):
        if h in upstream.headers:
            out_headers[h] = upstream.headers[h]

    return Response(
        upstream.iter_content(chunk_size=8192),
        status=upstream.status_code,
        headers=out_headers,
    )


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True, "service": "minerva-cors-proxy"})


if __name__ == "__main__":
    host = os.environ.get("MINERVA_CORS_HOST", "127.0.0.1")
    port = int(os.environ.get("MINERVA_CORS_PORT", "8081"))
    print(f"[minerva-cors] listening at http://{host}:{port}")
    app.run(host=host, port=port, threaded=True)
