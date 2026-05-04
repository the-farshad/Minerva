#!/usr/bin/env python3
"""
Minerva yt-dlp server — self-bootstrapping.

Run with the system Python:
    python3 yt-dlp-server.py

On first run the script creates a virtual environment under
~/.minerva-ytdlp, installs Flask + yt-dlp into it, then re-executes
itself inside that venv. Subsequent runs reuse the venv and start
immediately.

Override the venv location with the MINERVA_YTDL_VENV environment
variable. Bind address / port via MINERVA_YTDL_HOST and
MINERVA_YTDL_PORT.

Once running, point Minerva → Settings → "yt-dlp server" at
http://localhost:8080 (or whatever port). Click Test to confirm.
"""

import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import venv as _venv

# ---------------------------------------------------------------------------
# Bootstrap: create a venv with Flask + yt-dlp the first time we run.
# ---------------------------------------------------------------------------

REQUIREMENTS = ("flask", "yt-dlp")
VENV_DIR = pathlib.Path(
    os.environ.get("MINERVA_YTDL_VENV") or (pathlib.Path.home() / ".minerva-ytdlp")
).expanduser()


def _venv_python() -> pathlib.Path:
    if os.name == "nt":
        return VENV_DIR / "Scripts" / "python.exe"
    return VENV_DIR / "bin" / "python"


def _bootstrap_and_reexec() -> None:
    target = _venv_python()
    current = pathlib.Path(sys.executable).resolve()
    if target.exists() and current == target.resolve():
        return  # Already running inside the venv — nothing to do.

    if not target.exists():
        print(f"[minerva-ytdl] creating venv at {VENV_DIR} …", file=sys.stderr)
        _venv.create(VENV_DIR, with_pip=True, symlinks=os.name != "nt")

    # Install deps with whatever pip the venv has (always via -m pip so
    # the right interpreter wins).
    print(f"[minerva-ytdl] installing {', '.join(REQUIREMENTS)} into venv …", file=sys.stderr)
    proc = subprocess.run(
        [str(target), "-m", "pip", "install", "--upgrade", "--quiet", *REQUIREMENTS],
        check=False,
    )
    if proc.returncode != 0:
        print(
            "[minerva-ytdl] pip install failed — re-run manually with verbose output: "
            f"{target} -m pip install {' '.join(REQUIREMENTS)}",
            file=sys.stderr,
        )
        sys.exit(proc.returncode)

    # Re-exec the same script through the venv interpreter so the rest
    # of the file runs with the right imports available.
    os.execv(str(target), [str(target), os.path.abspath(__file__), *sys.argv[1:]])


_bootstrap_and_reexec()

# ---------------------------------------------------------------------------
# Server (only reached once we're inside the venv with deps installed).
# ---------------------------------------------------------------------------

import yt_dlp  # noqa: E402  (post-bootstrap import)
from flask import Flask, request, send_file, jsonify, after_this_request  # noqa: E402

app = Flask(__name__)


def _cors_headers(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS, GET"
    return resp


@app.after_request
def _add_cors(resp):
    return _cors_headers(resp)


@app.route("/download", methods=["POST", "OPTIONS"])
def download():
    if request.method == "OPTIONS":
        return _cors_headers(app.response_class(status=204))

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

    filename = os.path.basename(path)
    return send_file(path, as_attachment=True, download_name=filename, conditional=False)


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True, "service": "minerva-ytdlp"})


@app.route("/", methods=["GET"])
def index():
    return (
        """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Minerva yt-dlp server</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px;
           margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }
    code { background: #f3f3f3; padding: 0.1rem 0.4rem; border-radius: 4px; }
    .ok { color: #2c8c3e; }
  </style>
</head>
<body>
  <h1>Minerva yt-dlp server <span class="ok">ok</span></h1>
  <p>This process accepts <code>POST /download</code> with a JSON body
  <code>{ "url": "...", "format": "mp4" }</code> and streams the
  resulting media bytes back.</p>
  <p>Wire it into Minerva at <em>Settings &rarr; yt-dlp server</em>
  with the URL of this host (e.g. <code>http://localhost:8080</code>).</p>
  <p>Health check: <a href="/health">/health</a>.</p>
</body>
</html>""",
        200,
        {"Content-Type": "text/html; charset=utf-8"},
    )


if __name__ == "__main__":
    host = os.environ.get("MINERVA_YTDL_HOST", "127.0.0.1")
    port = int(os.environ.get("MINERVA_YTDL_PORT", "8080"))
    print(f"[minerva-ytdl] listening at http://{host}:{port}")
    app.run(host=host, port=port, threaded=True)
