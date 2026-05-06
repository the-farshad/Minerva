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

REQUIREMENTS = ("flask", "yt-dlp", "requests", "psycopg[binary]")
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

try:
    import psycopg  # noqa: E402
    from psycopg.types.json import Jsonb  # noqa: E402
    _HAS_PSYCOPG = True
except Exception:  # noqa: BLE001
    _HAS_PSYCOPG = False

def _first_existing(paths):
    for p in paths:
        if p and os.path.isfile(p):
            return p
    return None


# When MINERVA_STATIC_DIR points at a directory that contains
# index.html, the helper also serves the Minerva front-end so a single
# `docker run` produces the whole app at http://localhost:8765/.
STATIC_DIR = os.environ.get("MINERVA_STATIC_DIR", "/srv/static")
SERVE_STATIC = os.path.isfile(os.path.join(STATIC_DIR, "index.html"))

if SERVE_STATIC:
    app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="")
else:
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
    # YouTube increasingly gates videos behind a "Sign in to confirm
    # you're not a bot" check. yt-dlp can step past it with a Netscape-
    # format cookies file exported from a logged-in browser. We look at
    # MINERVA_COOKIES_FILE first, then a couple of conventional paths so
    # a Docker volume mount at /srv/cookies.txt or ~/.minerva/cookies.txt
    # is picked up automatically.
    cookies_path = (
        os.environ.get("MINERVA_COOKIES_FILE")
        or _first_existing([
            "/srv/cookies.txt",
            os.path.expanduser("~/.minerva/cookies.txt"),
            os.path.expanduser("~/cookies.txt"),
        ])
    )
    if cookies_path and os.path.isfile(cookies_path):
        ydl_opts["cookiefile"] = cookies_path
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
        msg = f"yt-dlp failed: {exc}"
        # Annotate the bot-wall error with what the helper actually saw
        # for cookies, so the user can tell whether the volume mount is
        # broken (no cookies path) versus the file is empty (mount works
        # but --refresh-cookies didn't write anything) versus the cookies
        # are real but YouTube still rejected them (session expired).
        if "Sign in to confirm" in str(exc) or "cookies" in str(exc).lower():
            if cookies_path:
                try:
                    st = os.stat(cookies_path)
                    msg += (
                        f"\n[diagnostic] cookies file: {cookies_path}, "
                        f"size={st.st_size}B, "
                        f"mtime={int(st.st_mtime)}"
                    )
                    if st.st_size == 0:
                        msg += " — file is empty. Run `--refresh-cookies` on the host."
                except Exception:
                    msg += f"\n[diagnostic] cookies file at {cookies_path} could not be stat()ed."
            else:
                msg += (
                    "\n[diagnostic] no cookies file found inside the container. "
                    "Check that the docker-compose.override.yml mounts your host's "
                    "cookies.txt at /srv/cookies.txt, or set MINERVA_COOKIES_FILE."
                )
        return (msg, 500)

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


# ---------- PDF data loader -----------------------------------------------
#
# Wraps `opendataloader-pdf` (https://pypi.org/project/opendataloader-pdf/).
# The browser POSTs { "url": "<pdf url>" } and we:
#   1. fetch the PDF (direct first; falls back to the configured proxy
#      allow-list if the host blocks CORS),
#   2. shell out to the loader CLI against the file,
#   3. return the loader's JSON output verbatim so the front-end can
#      render whatever it makes sense to render.
#
# The JSON is also returned with a "raw_text" string when present so a
# minimal UI can show the extracted body without re-parsing the
# structured representation.

@app.route("/pdf/extract", methods=["POST", "OPTIONS"])
def pdf_extract():
    if request.method == "OPTIONS":
        return ("", 204, _cors_dict())
    body = request.get_json(silent=True) or {}
    pdf_url = (body.get("url") or "").strip()
    if not pdf_url:
        return (jsonify({"ok": False, "error": "Missing 'url' in body."}), 400, _cors_dict())
    if not shutil.which("opendataloader-pdf"):
        return (
            jsonify({
                "ok": False,
                "error": "opendataloader-pdf is not installed in this image. "
                         "Rebuild minerva-services after the dep was added, "
                         "or pip install opendataloader-pdf in your venv.",
            }),
            500,
            _cors_dict(),
        )
    tmpdir = tempfile.mkdtemp(prefix="minerva-pdfextract-")
    pdf_path = os.path.join(tmpdir, "in.pdf")
    out_path = os.path.join(tmpdir, "out.json")
    try:
        try:
            up = requests.get(pdf_url, timeout=60)
            up.raise_for_status()
        except Exception as exc:  # noqa: BLE001
            return (
                jsonify({"ok": False, "error": f"PDF fetch failed: {exc}"}),
                502,
                _cors_dict(),
            )
        with open(pdf_path, "wb") as fh:
            fh.write(up.content)
        try:
            proc = subprocess.run(
                ["opendataloader-pdf", "--input", pdf_path, "--output", out_path],
                capture_output=True, timeout=180,
            )
        except subprocess.TimeoutExpired:
            return (
                jsonify({"ok": False, "error": "opendataloader-pdf timed out after 180s."}),
                504,
                _cors_dict(),
            )
        if proc.returncode != 0:
            return (
                jsonify({
                    "ok": False,
                    "error": "opendataloader-pdf exited non-zero.",
                    "stderr": proc.stderr.decode("utf-8", "replace"),
                }),
                500,
                _cors_dict(),
            )
        # The loader writes its result to --output; some builds also
        # echo to stdout. Prefer the file when present.
        payload = None
        if os.path.isfile(out_path):
            with open(out_path, "r", encoding="utf-8", errors="replace") as fh:
                txt = fh.read()
            try:
                payload = __import__("json").loads(txt)
            except Exception:  # noqa: BLE001
                payload = {"raw_text": txt}
        elif proc.stdout:
            txt = proc.stdout.decode("utf-8", "replace")
            try:
                payload = __import__("json").loads(txt)
            except Exception:  # noqa: BLE001
                payload = {"raw_text": txt}
        else:
            payload = {"raw_text": ""}
        return jsonify({"ok": True, "data": payload})
    finally:
        try:
            shutil.rmtree(tmpdir, ignore_errors=True)
        except Exception:
            pass


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
            up = requests.get(decoded, headers=fwd, timeout=30)
        else:
            up = requests.post(
                decoded, headers=fwd, data=request.get_data(), timeout=30,
            )
    except requests.RequestException as exc:
        return (f"Upstream fetch failed: {exc}", 502, _cors_dict())

    # Materialize the body before responding. `up.content` is the
    # fully-decompressed payload; pairing it with the matching length
    # avoids any chunked / Content-Length mismatch that the streaming
    # path could surface depending on the upstream's headers.
    body = up.content
    out = dict(_cors_dict())
    if "Content-Type" in up.headers:
        out["Content-Type"] = up.headers["Content-Type"]
    out["Content-Length"] = str(len(body))

    return Response(body, status=up.status_code, headers=out)


# ---------- Postgres mirror -----------------------------------------------
#
# When MINERVA_DATABASE_URL is set and psycopg is importable, the service
# exposes a small CRUD surface that the browser uses to mirror every
# spreadsheet write into a local Postgres instance. Schema is intentionally
# schema-less from PG's view: one table, one jsonb column per row, keyed
# by (tab, id). The browser already enforces the column shape via the
# spreadsheet's row-2 type hints, so the database doesn't need to.
#
# When the env var isn't set the endpoints all return 503 — the browser
# treats that as "no PG, fall back to Sheets only".

DATABASE_URL = os.environ.get("MINERVA_DATABASE_URL", "").strip()
_DB_READY = False


def _db_ready() -> bool:
    global _DB_READY
    if _DB_READY:
        return True
    if not (DATABASE_URL and _HAS_PSYCOPG):
        return False
    try:
        with psycopg.connect(DATABASE_URL, connect_timeout=5) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS minerva_rows (
                        tab        TEXT        NOT NULL,
                        id         TEXT        NOT NULL,
                        data       JSONB       NOT NULL,
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        deleted    BOOLEAN     NOT NULL DEFAULT FALSE,
                        row_index  INTEGER,
                        PRIMARY KEY (tab, id)
                    );
                    """
                )
                cur.execute(
                    "CREATE INDEX IF NOT EXISTS minerva_rows_tab_updated "
                    "ON minerva_rows (tab, updated_at);"
                )
                cur.execute(
                    "CREATE INDEX IF NOT EXISTS minerva_rows_tab_live "
                    "ON minerva_rows (tab) WHERE NOT deleted;"
                )
            conn.commit()
        _DB_READY = True
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"[minerva-db] init failed: {exc}", file=sys.stderr)
        return False


def _db_unavailable():
    return (
        jsonify({"ok": False, "error": "Postgres not configured on this service."}),
        503,
        _cors_dict(),
    )


@app.route("/db/health", methods=["GET", "OPTIONS"])
def db_health():
    if request.method == "OPTIONS":
        return ("", 204, _cors_dict())
    if not (DATABASE_URL and _HAS_PSYCOPG):
        return jsonify({"ok": False, "configured": False})
    ready = _db_ready()
    return jsonify({"ok": ready, "configured": True})


@app.route("/db/rows/<tab>", methods=["GET", "OPTIONS"])
def db_rows(tab):
    if request.method == "OPTIONS":
        return ("", 204, _cors_dict())
    if not _db_ready():
        return _db_unavailable()
    since = (request.args.get("since") or "").strip()
    include_deleted = request.args.get("include_deleted") == "1"
    try:
        with psycopg.connect(DATABASE_URL, connect_timeout=5) as conn:
            with conn.cursor() as cur:
                clauses = ["tab = %s"]
                params = [tab]
                if not include_deleted:
                    clauses.append("NOT deleted")
                if since:
                    clauses.append("updated_at > %s")
                    params.append(since)
                cur.execute(
                    "SELECT id, data, EXTRACT(EPOCH FROM updated_at) * 1000 AS updated_ms, "
                    "deleted, row_index FROM minerva_rows WHERE "
                    + " AND ".join(clauses)
                    + " ORDER BY updated_at ASC",
                    params,
                )
                out = []
                for row in cur.fetchall():
                    rid, data, updated_ms, deleted, row_index = row
                    rec = dict(data or {})
                    rec["id"] = rid
                    rec["_updated_ms"] = int(updated_ms or 0)
                    rec["_deleted"] = 1 if deleted else 0
                    if row_index is not None:
                        rec["_rowIndex"] = row_index
                    out.append(rec)
        return jsonify({"ok": True, "tab": tab, "rows": out})
    except Exception as exc:  # noqa: BLE001
        return (jsonify({"ok": False, "error": str(exc)}), 500, _cors_dict())


@app.route("/db/upsert/<tab>", methods=["POST", "OPTIONS"])
def db_upsert(tab):
    if request.method == "OPTIONS":
        return ("", 204, _cors_dict())
    if not _db_ready():
        return _db_unavailable()
    body = request.get_json(silent=True) or {}
    rows = body.get("rows")
    if rows is None and body:
        rows = [body]
    if not isinstance(rows, list) or not rows:
        return (jsonify({"ok": False, "error": "Body must include rows[]."}), 400, _cors_dict())
    try:
        with psycopg.connect(DATABASE_URL, connect_timeout=5) as conn:
            with conn.cursor() as cur:
                for r in rows:
                    if not isinstance(r, dict):
                        continue
                    rid = r.get("id")
                    if not rid:
                        continue
                    row_index = r.get("_rowIndex")
                    payload = {
                        k: v for k, v in r.items()
                        if not (isinstance(k, str) and k.startswith("_")) and k != "id"
                    }
                    cur.execute(
                        """
                        INSERT INTO minerva_rows (tab, id, data, updated_at, deleted, row_index)
                        VALUES (%s, %s, %s, NOW(), FALSE, %s)
                        ON CONFLICT (tab, id) DO UPDATE
                          SET data = EXCLUDED.data,
                              updated_at = NOW(),
                              deleted = FALSE,
                              row_index = EXCLUDED.row_index
                        """,
                        (tab, rid, Jsonb(payload), row_index),
                    )
            conn.commit()
        return jsonify({"ok": True, "count": len(rows)})
    except Exception as exc:  # noqa: BLE001
        return (jsonify({"ok": False, "error": str(exc)}), 500, _cors_dict())


@app.route("/db/delete/<tab>", methods=["POST", "OPTIONS"])
def db_delete(tab):
    if request.method == "OPTIONS":
        return ("", 204, _cors_dict())
    if not _db_ready():
        return _db_unavailable()
    body = request.get_json(silent=True) or {}
    ids = body.get("ids")
    if isinstance(body.get("id"), str):
        ids = [body["id"]]
    hard = body.get("hard") is True
    if not isinstance(ids, list) or not ids:
        return (jsonify({"ok": False, "error": "Body must include ids[]."}), 400, _cors_dict())
    try:
        with psycopg.connect(DATABASE_URL, connect_timeout=5) as conn:
            with conn.cursor() as cur:
                if hard:
                    cur.execute(
                        "DELETE FROM minerva_rows WHERE tab = %s AND id = ANY(%s)",
                        (tab, ids),
                    )
                else:
                    cur.execute(
                        "UPDATE minerva_rows SET deleted = TRUE, updated_at = NOW() "
                        "WHERE tab = %s AND id = ANY(%s)",
                        (tab, ids),
                    )
            conn.commit()
        return jsonify({"ok": True, "count": len(ids), "hard": hard})
    except Exception as exc:  # noqa: BLE001
        return (jsonify({"ok": False, "error": str(exc)}), 500, _cors_dict())


@app.route("/db/dump", methods=["GET", "OPTIONS"])
def db_dump():
    # Stream a pg_dump of the minerva database back to the caller.
    # The browser-side flow uploads the resulting file to Drive, so this
    # endpoint just needs to materialise a portable plain-text dump.
    if request.method == "OPTIONS":
        return ("", 204, _cors_dict())
    if not _db_ready():
        return _db_unavailable()
    if not shutil.which("pg_dump"):
        return (
            jsonify({"ok": False, "error": "pg_dump is not installed in this image."}),
            500,
            _cors_dict(),
        )
    parsed = urlparse(DATABASE_URL)
    env = os.environ.copy()
    if parsed.password:
        env["PGPASSWORD"] = parsed.password
    cmd = [
        "pg_dump",
        "--format=plain",
        "--no-owner",
        "--no-privileges",
        f"--host={parsed.hostname or 'localhost'}",
        f"--port={parsed.port or 5432}",
        f"--username={parsed.username or 'minerva'}",
        f"--dbname={(parsed.path or '/minerva').lstrip('/') or 'minerva'}",
    ]
    try:
        proc = subprocess.run(cmd, env=env, capture_output=True, timeout=120)
    except Exception as exc:  # noqa: BLE001
        return (jsonify({"ok": False, "error": f"pg_dump invocation failed: {exc}"}), 500, _cors_dict())
    if proc.returncode != 0:
        return (
            jsonify({
                "ok": False,
                "error": "pg_dump exited non-zero",
                "stderr": proc.stderr.decode("utf-8", "replace"),
            }),
            500,
            _cors_dict(),
        )
    headers = dict(_cors_dict())
    headers["Content-Type"] = "application/sql; charset=utf-8"
    headers["Content-Length"] = str(len(proc.stdout))
    headers["Content-Disposition"] = 'attachment; filename="minerva.sql"'
    return Response(proc.stdout, status=200, headers=headers)


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
        "endpoints": [
            "/download", "/proxy", "/pdf/extract",
            "/db/health", "/db/rows/<tab>", "/db/upsert/<tab>",
            "/db/delete/<tab>", "/db/dump",
            "/health", "/shutdown", "/",
        ],
        "postgres": {
            "configured": bool(DATABASE_URL and _HAS_PSYCOPG),
            "ready": _DB_READY,
        },
        "pdf_extractor": {
            "available": shutil.which("opendataloader-pdf") is not None,
        },
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


def _helper_status_html():
    port = int(os.environ.get("MINERVA_PORT", "8765"))
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
  <p>One process, multiple endpoints. Wire them into Minerva at
  <em>Settings</em>:</p>
  <ul>
    <li>yt-dlp server &rarr; <code>http://localhost:""" + str(port) + """</code></li>
    <li>CORS proxy &rarr; <code>http://localhost:""" + str(port) + """/proxy?</code></li>
  </ul>
  <p>Health: <a href="/health">/health</a>.</p>
</body>
</html>""",
        200,
        {"Content-Type": "text/html; charset=utf-8"},
    )


@app.route("/helper", methods=["GET"])
def helper_status():
    return _helper_status_html()


@app.route("/", methods=["GET"])
def index():
    # Serve the Minerva SPA when baked into the image; otherwise fall
    # back to the helper status page so a bare `docker run` of the old
    # image still tells the user what they hit.
    if SERVE_STATIC:
        return send_file(os.path.join(STATIC_DIR, "index.html"))
    return _helper_status_html()


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


def _refresh_cookies(browser):
    """Dump cookies from a local browser into ~/.minerva/cookies.txt.

    Tries the requested browser first, then falls through every other
    common browser so a user who specifies "firefox" but actually has
    a Snap-sandboxed Firefox (cookie DB unreadable) still recovers via
    Chrome / Brave / etc. Prints a per-browser breakdown on total
    failure so the operator can see why each candidate refused.

    Returns 0 on success, non-zero on failure.
    """
    target = pathlib.Path(
        os.environ.get("MINERVA_COOKIES_FILE")
        or (pathlib.Path.home() / ".minerva" / "cookies.txt")
    ).expanduser()
    target.parent.mkdir(parents=True, exist_ok=True)

    all_browsers = ["firefox", "chrome", "chromium", "brave", "edge", "vivaldi", "opera"]
    if browser:
        candidates = [browser] + [b for b in all_browsers if b != browser]
    else:
        candidates = all_browsers

    errors = []
    for b in candidates:
        if not b:
            continue
        try:
            from yt_dlp.cookies import load_cookies  # type: ignore
            cj = load_cookies(None, [b], None)
            n = sum(1 for _ in cj)
            if n == 0:
                errors.append(f"{b}: 0 cookies (not logged in or profile DB unreadable)")
                continue
            cj.save(str(target), ignore_discard=True, ignore_expires=True)
            print(f"[minerva] wrote {target} from {b} ({n} cookies)")
            return 0
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{b}: {type(exc).__name__}: {exc}")
            continue

    print("[minerva] could not refresh cookies. Browsers tried:", file=sys.stderr)
    for e in errors:
        print(f"           {e}", file=sys.stderr)
    print(
        "[minerva] If every browser shows '0 cookies' or 'unreadable', the\n"
        "          most common cause is a Snap / Flatpak / Mac App Store\n"
        "          install — the cookie DB lives in a sandboxed path yt-dlp\n"
        "          can't read. Install the native package (apt/dnf/brew/.deb)\n"
        "          or fall back to a manual cookies.txt export.",
        file=sys.stderr,
    )
    return 1


def _install_cookie_timer(browser):
    """Install a systemd-user timer that runs --refresh-cookies hourly.

    The timer + service unit pair lives under ~/.config/systemd/user/.
    Once enabled, cookies stay fresh as long as the user is logged in
    on the host — no cron entry to copy, no script to remember.
    Idempotent: re-running rewrites both unit files and re-enables.
    """
    if os.name == "nt":
        print("[minerva] systemd timer is Linux-only. Use Task Scheduler on Windows.", file=sys.stderr)
        return 1
    if not shutil.which("systemctl"):
        print(
            "[minerva] systemctl not found. On macOS use a launchd plist; on a "
            "non-systemd Linux drop the cron snippet from setup-local-services.md instead.",
            file=sys.stderr,
        )
        return 1
    home = pathlib.Path.home()
    config_dir = home / ".config" / "systemd" / "user"
    config_dir.mkdir(parents=True, exist_ok=True)
    script_path = pathlib.Path(__file__).resolve()
    py = sys.executable or "/usr/bin/python3"
    chosen = browser or "firefox"

    service = (
        "[Unit]\n"
        "Description=Minerva — refresh YouTube cookies for yt-dlp\n"
        "\n"
        "[Service]\n"
        "Type=oneshot\n"
        f"ExecStart={py} {script_path} --refresh-cookies {chosen}\n"
    )
    timer = (
        "[Unit]\n"
        "Description=Refresh Minerva cookies on a schedule\n"
        "\n"
        "[Timer]\n"
        "OnBootSec=2min\n"
        "OnUnitActiveSec=1h\n"
        "Persistent=true\n"
        "\n"
        "[Install]\n"
        "WantedBy=timers.target\n"
    )
    (config_dir / "minerva-cookies.service").write_text(service)
    (config_dir / "minerva-cookies.timer").write_text(timer)
    try:
        subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
        subprocess.run(
            ["systemctl", "--user", "enable", "--now", "minerva-cookies.timer"],
            check=True,
        )
    except subprocess.CalledProcessError as exc:
        print(f"[minerva] systemctl failed: {exc}", file=sys.stderr)
        return exc.returncode or 1
    print(f"[minerva] cookie-refresh timer installed (browser={chosen}).")
    print("           First fire: ~2 min after this command. Then every hour.")
    print("           Status:    systemctl --user status minerva-cookies.timer")
    print("           Logs:      journalctl --user -u minerva-cookies.service")
    print("           Stop:      systemctl --user disable --now minerva-cookies.timer")
    return 0


if __name__ == "__main__":
    # --refresh-cookies [browser] runs the dump and exits without
    # starting the Flask server. Useful in a cron entry like:
    #     */60 * * * *  /usr/bin/python3 /path/to/minerva-services.py --refresh-cookies firefox
    if "--refresh-cookies" in sys.argv:
        i = sys.argv.index("--refresh-cookies")
        chosen = sys.argv[i + 1] if i + 1 < len(sys.argv) and not sys.argv[i + 1].startswith("-") else None
        sys.exit(_refresh_cookies(chosen))
    # --install-cookie-timer [browser] writes a systemd-user timer that
    # runs the refresh hourly. One-shot setup; nothing to remember after.
    if "--install-cookie-timer" in sys.argv:
        i = sys.argv.index("--install-cookie-timer")
        chosen = sys.argv[i + 1] if i + 1 < len(sys.argv) and not sys.argv[i + 1].startswith("-") else None
        sys.exit(_install_cookie_timer(chosen))

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
