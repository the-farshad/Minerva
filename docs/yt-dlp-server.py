#!/usr/bin/env python3
"""
Minimal yt-dlp HTTP wrapper for Minerva's one-click Download.

Usage:
    pip install flask yt-dlp
    python yt-dlp-server.py
    # → listens on http://localhost:8080

Then in Minerva → Settings → "yt-dlp server (recommended)":
    http://localhost:8080

When you click Download on a YouTube row, Minerva POSTs to /download with
{url, format}. This server runs yt-dlp on the URL, then streams the
resulting file straight back. The browser saves the bytes into IndexedDB
as the row's offline copy.

Protocol:
    POST /download   Content-Type: application/json
    body: { "url": "<video-url>", "format": "mp4" | "best" | "mp3" | ... }
    200 OK with the video bytes; Content-Disposition carries the filename.
    400 / 500 with a plain-text error otherwise.

CORS is wide-open (allow any origin) so a browser-side Minerva can talk
to it. Bind to 127.0.0.1 by default — keep it that way unless you want
neighbors on your LAN to be able to download through your machine.
"""

import os
import shutil
import tempfile
from flask import Flask, request, send_file, jsonify, after_this_request

import yt_dlp

app = Flask(__name__)


def _cors_headers(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
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

    # Build yt-dlp options from the requested format.
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
        # default & explicit "mp4"
        ydl_opts["format"] = "mp4"

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            path = ydl.prepare_filename(info)
            # Postprocessor may have changed the extension (e.g. mp3).
            if not os.path.exists(path):
                base, _ = os.path.splitext(path)
                for ext in (".mp3", ".m4a", ".webm", ".mkv", ".mp4"):
                    if os.path.exists(base + ext):
                        path = base + ext
                        break
    except Exception as exc:  # noqa: BLE001 — surface any yt-dlp error
        shutil.rmtree(tmpdir, ignore_errors=True)
        return (f"yt-dlp failed: {exc}", 500)

    @after_this_request
    def _cleanup(resp):
        # Drop the temp dir once the response is fully sent.
        try:
            shutil.rmtree(tmpdir, ignore_errors=True)
        except Exception:
            pass
        return resp

    filename = os.path.basename(path)
    return send_file(
        path,
        as_attachment=True,
        download_name=filename,
        conditional=False,
    )


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True, "service": "minerva-ytdlp"})


@app.route("/", methods=["GET"])
def index():
    # Plain GET to / lands here. Confirms the server is alive and
    # documents the only protocol it speaks.
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
  <p>Wire it into Minerva at
  <em>Settings &rarr; yt-dlp server</em> with the URL of this host
  (e.g. <code>http://localhost:8080</code>).</p>
  <p>Health check: <a href="/health">/health</a>.</p>
</body>
</html>""",
        200,
        {"Content-Type": "text/html; charset=utf-8"},
    )


if __name__ == "__main__":
    host = os.environ.get("MINERVA_YTDL_HOST", "127.0.0.1")
    port = int(os.environ.get("MINERVA_YTDL_PORT", "8080"))
    print(f"Minerva yt-dlp server listening at http://{host}:{port}")
    app.run(host=host, port=port, threaded=True)
