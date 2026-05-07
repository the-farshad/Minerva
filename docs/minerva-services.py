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

# Hard requirements — no-import-no-server. yt-dlp + requests + flask
# are baseline. psycopg is needed only by the Postgres mirror routes
# but always-installed so the helper can answer /db/health on any
# minerva-services container.
REQUIREMENTS = ("flask", "yt-dlp", "requests", "psycopg[binary]")
# Best-effort optional deps — if a name doesn't exist on PyPI on a
# given day, or won't compile in the current Python, we keep going
# instead of bricking the whole helper.
OPTIONAL_REQUIREMENTS = ("opendataloader-pdf",)

VENV_DIR = pathlib.Path(
    os.environ.get("MINERVA_VENV") or (pathlib.Path.home() / ".minerva-services")
).expanduser()


def _venv_python() -> pathlib.Path:
    if os.name == "nt":
        return VENV_DIR / "Scripts" / "python.exe"
    return VENV_DIR / "bin" / "python"


def _import_name_for(spec):
    # Map "psycopg[binary]" → "psycopg", "yt-dlp" → "yt_dlp",
    # "opendataloader-pdf" → "opendataloader_pdf".
    base = spec.split('[', 1)[0]
    return base.replace('-', '_')


def _missing_requirements():
    out = []
    for spec in REQUIREMENTS:
        try:
            __import__(_import_name_for(spec))
        except ImportError:
            out.append(spec)
    return out


def _pip_install(specs):
    if not specs:
        return 0
    print(f"[minerva] installing into venv: {', '.join(specs)}", file=sys.stderr)
    proc = subprocess.run(
        [sys.executable, "-m", "pip", "install", "--upgrade", "--quiet", *specs],
        check=False,
    )
    return proc.returncode


def _bootstrap_and_reexec() -> None:
    target = _venv_python()
    # Compare *without* resolving symlinks: both this venv and any
    # other project venv on the same machine usually symlink python
    # to the same /usr/bin/python3.x, so .resolve() collapses them
    # together and we'd incorrectly assume we're already in our own
    # venv. The literal path containment check distinguishes
    # ~/.minerva-services/bin/python from any other venv path.
    sys_exe = os.path.abspath(sys.executable)
    venv_dir = os.path.abspath(str(VENV_DIR))
    in_venv = target.exists() and (
        sys_exe == str(target)
        or sys_exe.startswith(venv_dir + os.sep)
    )

    # Already running in the venv: just heal any missing deps in place
    # (catches the "stale venv was created before this require list
    # grew a new entry" trap that surfaces as ModuleNotFoundError on
    # imports below this function).
    if in_venv:
        missing = _missing_requirements()
        if missing:
            rc = _pip_install(missing)
            if rc != 0:
                print(
                    f"[minerva] pip install failed for {missing}. Try manually:\n"
                    f"    {sys.executable} -m pip install {' '.join(missing)}",
                    file=sys.stderr,
                )
                sys.exit(rc)
        # Optional deps are best-effort — log on failure, never abort.
        for spec in OPTIONAL_REQUIREMENTS:
            try:
                __import__(_import_name_for(spec))
            except ImportError:
                rc = _pip_install([spec])
                if rc != 0:
                    print(
                        f"[minerva] optional dep {spec!r} not available; "
                        "the matching endpoint will return a 500 with a clear "
                        "message until you install it manually.",
                        file=sys.stderr,
                    )
        return

    if not target.exists():
        print(f"[minerva] creating venv at {VENV_DIR} …", file=sys.stderr)
        _venv.create(VENV_DIR, with_pip=True, symlinks=os.name != "nt")

    print(f"[minerva] installing into venv (one-time): {', '.join(REQUIREMENTS)}", file=sys.stderr)
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
    # Optional — silent failure, the venv re-exec below still proceeds.
    subprocess.run(
        [str(target), "-m", "pip", "install", "--upgrade", "--quiet", *OPTIONAL_REQUIREMENTS],
        check=False,
    )

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
    # SPA gets mounted under /app/ — that keeps `/` available for the
    # status page (which is what most folks land on when checking the
    # helper is alive). Static assets resolve to /app/assets/...
    # automatically because the SPA's index.html uses relative paths.
    app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="/app")
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
        # YouTube serves an n-parameter JS challenge yt-dlp must
        # execute to get usable stream URLs. Without the EJS solver
        # script published on GitHub, the response is stripped to
        # storyboard images and every download fails with "Requested
        # format is not available." Deno is installed in the image
        # to run the script. The flag tells yt-dlp where to fetch the
        # solver lib from on first need (cached after that).
        "remote_components": ["ejs:github"],
    }
    # YouTube increasingly gates videos behind a "Sign in to confirm
    # you're not a bot" check. yt-dlp can step past it with a Netscape-
    # format cookies file exported from a logged-in browser. We look at
    # MINERVA_COOKIES_FILE first, then a couple of conventional paths so
    # a Docker volume mount at /srv/cookies.txt or ~/.minerva/cookies.txt
    # is picked up automatically.
    # Authenticate yt-dlp via the live browser cookie DB when the host
    # mounted a profile in (MINERVA_BROWSER_PROFILE → bind-mount path).
    # This is more reliable than cookies.txt: snapshots go stale every
    # time YouTube rotates a session, but the live DB updates as the
    # user browses. Falls back to the snapshot if no profile is
    # mounted (older minerva-up.sh deploys, or manual exports).
    cookies_path = None
    using_live_profile = False
    browser_profile = os.environ.get("MINERVA_BROWSER_PROFILE", "").strip()
    browser_kind = os.environ.get("MINERVA_BROWSER_KIND", "firefox").strip() or "firefox"
    if browser_profile and os.path.isdir(browser_profile):
        ydl_opts["cookiesfrombrowser"] = (browser_kind, browser_profile, None, None)
        using_live_profile = True
    else:
        cookies_path = (
            os.environ.get("MINERVA_COOKIES_FILE")
            or _first_existing([
                "/srv/cookies.txt",
                os.path.expanduser("~/.minerva/cookies.txt"),
                os.path.expanduser("~/cookies.txt"),
            ])
        )
        if cookies_path and os.path.isfile(cookies_path):
            # Skip a malformed cookies file rather than letting yt-dlp's
            # strict loader explode the whole download. A non-Netscape
            # first line is the failure mode we've actually observed
            # (partial save from a previous failed --refresh-cookies),
            # and the request is better off proceeding without auth
            # than failing with a confusing CookieLoadError.
            try:
                if os.path.getsize(cookies_path) < 64:
                    cookies_path = None
                else:
                    with open(cookies_path, "r", encoding="utf-8", errors="replace") as fh:
                        first = fh.readline().strip()
                    if not first.startswith("# Netscape HTTP Cookie File"):
                        cookies_path = None
            except Exception:
                cookies_path = None
            if cookies_path:
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
        # Default mp4 path: prefer a single-file mp4 when one exists,
        # but fall back to "pick any best video + audio and let ffmpeg
        # merge into mp4". Using a hard "mp4" string fails on videos
        # that publish only DASH-split streams (older lectures, some
        # MIT OCW uploads) — yt-dlp returns "Requested format is not
        # available". The combined expression below succeeds on both
        # progressive-mp4 and DASH-only cases.
        ydl_opts["format"] = "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/bestvideo+bestaudio/best"

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
            if using_live_profile:
                msg += (
                    f"\n[diagnostic] live browser profile in use: {browser_profile} ({browser_kind}). "
                    "If yt-dlp still rejects, your browser session is genuinely "
                    "expired — open " + browser_kind + " on the host, sign back into "
                    "youtube.com, and retry."
                )
            elif cookies_path:
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
    # Translate URL shapes that fetch HTML rather than the PDF bytes
    # the loader expects. arxiv abs pages, for instance, are the
    # paper's HTML record — opendataloader-pdf crashes when fed HTML.
    # Server-side rewrite means clients can pass either form.
    import re as _re
    abs_match = _re.match(r"^(https?://arxiv\.org/)abs/(.+?)(?:v\d+)?(?:\.pdf)?$", pdf_url, _re.I)
    if abs_match:
        pdf_url = abs_match.group(1) + "pdf/" + abs_match.group(2) + ".pdf"
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
        out_dir = os.path.join(tmpdir, "out")
        os.makedirs(out_dir, exist_ok=True)
        try:
            # opendataloader-pdf takes the PDF as a positional, writes
            # the result(s) into -o OUTPUT_DIR, format selected via -f.
            # Markdown output is the most useful single representation
            # for "show me the extracted text" — falls back to JSON
            # whenever the markdown file isn't there.
            proc = subprocess.run(
                ["opendataloader-pdf", "-q", "-f", "markdown", "-o", out_dir, pdf_path],
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
                    "stdout": proc.stdout.decode("utf-8", "replace"),
                }),
                500,
                _cors_dict(),
            )
        # Walk the output dir and pull the first .md or .json found.
        payload = None
        try:
            picked = None
            for root, _dirs, files in os.walk(out_dir):
                for name in sorted(files):
                    lower = name.lower()
                    if lower.endswith(".md") or lower.endswith(".markdown"):
                        picked = os.path.join(root, name); break
                if picked:
                    break
            if not picked:
                for root, _dirs, files in os.walk(out_dir):
                    for name in sorted(files):
                        if name.lower().endswith(".json"):
                            picked = os.path.join(root, name); break
                    if picked:
                        break
            if picked:
                with open(picked, "r", encoding="utf-8", errors="replace") as fh:
                    txt = fh.read()
                if picked.lower().endswith(".json"):
                    try:
                        payload = __import__("json").loads(txt)
                    except Exception:  # noqa: BLE001
                        payload = {"raw_text": txt}
                else:
                    payload = {"raw_text": txt, "format": "markdown"}
            elif proc.stdout:
                payload = {"raw_text": proc.stdout.decode("utf-8", "replace")}
            else:
                payload = {"raw_text": ""}
        except Exception as exc:  # noqa: BLE001
            return (
                jsonify({"ok": False, "error": f"output read failed: {exc}"}),
                500,
                _cors_dict(),
            )
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


@app.route("/db/stats", methods=["GET", "OPTIONS"])
def db_stats():
    if request.method == "OPTIONS":
        return ("", 204, _cors_dict())
    if not _db_ready():
        return _db_unavailable()
    try:
        with psycopg.connect(DATABASE_URL, connect_timeout=5) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT tab, "
                    "  count(*) FILTER (WHERE NOT deleted) AS live, "
                    "  count(*) FILTER (WHERE deleted) AS soft_deleted, "
                    "  EXTRACT(EPOCH FROM max(updated_at)) * 1000 AS last_write_ms "
                    "FROM minerva_rows GROUP BY tab ORDER BY live DESC NULLS LAST"
                )
                rows = []
                total = 0
                for tab, live, soft, last_ms in cur.fetchall():
                    rows.append({
                        "tab": tab,
                        "live": int(live or 0),
                        "deleted": int(soft or 0),
                        "last_write_ms": int(last_ms or 0),
                    })
                    total += int(live or 0)
        return jsonify({"ok": True, "total_live": total, "tabs": rows})
    except Exception as exc:  # noqa: BLE001
        return (jsonify({"ok": False, "error": str(exc)}), 500, _cors_dict())


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


# ---------- save-to-host + reveal-in-file-manager ------------------------
#
# These let the SPA put a downloaded blob in a known place on the host
# (default ~/Minerva/<kind>/...) and open the user's file manager there.
# Both routes are loopback-only by default so a tab that ends up on
# minerva.thefarshad.com can't accidentally reach them; the SPA served
# from the same container is on 127.0.0.1.

MINERVA_FILES_ROOT = pathlib.Path(
    os.environ.get("MINERVA_FILES_ROOT", str(pathlib.Path.home() / "Minerva"))
).expanduser()


def _safe_join(root, *parts):
    """Join + normalise; refuse to break out of root via .. or absolute
    components. Returns the resolved absolute path or None."""
    base = root.resolve()
    candidate = base
    for part in parts:
        if not part:
            continue
        sub = pathlib.Path(part)
        if sub.is_absolute() or ".." in sub.parts:
            return None
        candidate = candidate / sub
    try:
        candidate = candidate.resolve()
    except Exception:
        return None
    try:
        candidate.relative_to(base)
    except Exception:
        return None
    return candidate


@app.route("/file/save", methods=["POST", "OPTIONS"])
def file_save():
    if request.method == "OPTIONS":
        return ("", 204, _cors_dict())
    kind = (request.args.get("kind") or "misc").strip().lower()
    name = (request.args.get("name") or "").strip()
    if not name:
        return (jsonify({"ok": False, "error": "Missing 'name'."}), 400, _cors_dict())
    safe = _safe_join(MINERVA_FILES_ROOT, kind, name)
    if not safe:
        return (jsonify({"ok": False, "error": "Path outside files root."}), 400, _cors_dict())
    safe.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open(str(safe), "wb") as fh:
            fh.write(request.get_data())
    except Exception as exc:  # noqa: BLE001
        return (jsonify({"ok": False, "error": f"write failed: {exc}"}), 500, _cors_dict())
    return jsonify({"ok": True, "path": str(safe)})


@app.route("/file/reveal", methods=["POST", "OPTIONS"])
def file_reveal():
    if request.method == "OPTIONS":
        return ("", 204, _cors_dict())
    body = request.get_json(silent=True) or {}
    path = (body.get("path") or "").strip()
    if not path:
        return (jsonify({"ok": False, "error": "Missing 'path'."}), 400, _cors_dict())
    p = pathlib.Path(path).expanduser()
    try:
        p_resolved = p.resolve()
        # Only allow paths inside MINERVA_FILES_ROOT — never expose
        # arbitrary host filesystem to the network even on loopback.
        p_resolved.relative_to(MINERVA_FILES_ROOT.resolve())
    except Exception:
        return (jsonify({"ok": False, "error": "Path outside files root."}), 400, _cors_dict())
    if not p_resolved.exists():
        return (jsonify({"ok": False, "error": "Path not found."}), 404, _cors_dict())
    # Inside Docker, xdg-open won't reach the host's display server.
    # Detect: if /.dockerenv exists, return the path so the browser
    # surface (which IS on the host) can do the work via a download
    # affordance instead. Otherwise spawn the OS opener.
    in_container = pathlib.Path("/.dockerenv").exists()
    if in_container:
        return jsonify({"ok": True, "path": str(p_resolved), "in_container": True})
    try:
        if sys.platform == "darwin":
            subprocess.Popen(["open", "-R", str(p_resolved)])
        elif os.name == "nt":
            subprocess.Popen(["explorer", "/select,", str(p_resolved)])
        else:
            # xdg-open on the parent dir reveals the file in most file
            # managers (which highlight the most recent entry).
            subprocess.Popen(["xdg-open", str(p_resolved.parent)])
    except Exception as exc:  # noqa: BLE001
        return (jsonify({"ok": False, "error": f"reveal failed: {exc}"}), 500, _cors_dict())
    return jsonify({"ok": True, "path": str(p_resolved), "in_container": False})


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
            "/db/health", "/db/stats", "/db/rows/<tab>",
            "/db/upsert/<tab>", "/db/delete/<tab>", "/db/dump",
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
  <p>Run the bundled SPA: <a href=\"/app/\">/app/</a>.
  Health probe: <a href=\"/health\">/health</a>.</p>
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
    # `/` is always the status page — the SPA lives at /app/ so a
    # bare "is the helper alive?" hit doesn't bounce the user into
    # client-side routing they didn't ask for.
    return _helper_status_html()


@app.route("/app", methods=["GET"])
def spa_redirect():
    # Trailing-slash form is what the static URL path expects.
    from flask import redirect
    return redirect("/app/", code=302)


@app.route("/app/", methods=["GET"])
def spa_index():
    if not SERVE_STATIC:
        return ("Minerva SPA isn't baked into this image.", 404, _cors_dict())
    return send_file(os.path.join(STATIC_DIR, "index.html"))


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
            # yt-dlp's loader is strict about the first line — if for
            # any reason the saved file lacks the Netscape header,
            # prepend it so a downstream `cookiefile=` read doesn't
            # throw "does not look like a Netscape format cookies file".
            try:
                with open(str(target), "r", encoding="utf-8", errors="replace") as fh:
                    head = fh.read(80)
                if not head.startswith("# Netscape HTTP Cookie File"):
                    with open(str(target), "r", encoding="utf-8", errors="replace") as fh:
                        body = fh.read()
                    with open(str(target), "w", encoding="utf-8") as fh:
                        fh.write("# Netscape HTTP Cookie File\n")
                        fh.write("# https://curl.se/docs/http-cookies.html\n")
                        fh.write(body if body.startswith("\n") else body)
            except Exception:
                pass
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
    # Don't leave a corrupted / partial cookies file behind — yt-dlp
    # rejects any non-Netscape file at load time and an empty file is
    # worse than a missing one (the container's snapshot path picks
    # it up and crashes the whole /download call).
    try:
        if target.exists() and target.stat().st_size < 64:
            target.unlink()
            print(f"[minerva] removed empty/short cookies file at {target}.", file=sys.stderr)
    except Exception:
        pass
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


EMBEDDED_COMPOSE = """# Minerva — Docker Compose stack.
# Auto-generated by `minerva-services.py up` when missing. Edit only
# if you know what you're changing; re-running the bootstrap won't
# overwrite an existing file.

name: minerva

services:
  postgres:
    image: postgres:16-alpine
    container_name: minerva-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: minerva
      POSTGRES_PASSWORD: minerva
      POSTGRES_DB: minerva
    volumes:
      - minerva-pgdata:/var/lib/postgresql/data
    ports:
      - "127.0.0.1:5544:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U minerva -d minerva"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 5s

  minerva-services:
    image: thefarshad/minerva-services:latest
    container_name: minerva-services
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    ports:
      - "${MINERVA_PORT:-8765}:8765"
    environment:
      MINERVA_HOST: "0.0.0.0"
      MINERVA_PORT: "8765"
      MINERVA_DATABASE_URL: "postgres://minerva:minerva@postgres:5432/minerva"
      MINERVA_COOKIES_FILE: "/srv/cookies.txt"

volumes:
  minerva-pgdata:
    name: minerva-pgdata
"""


def _ensure_compose_file(here):
    """Drop a docker-compose.yml next to this script when missing.

    Lets a user bootstrap with nothing but minerva-services.py — no
    git checkout, no curl of the compose file. Idempotent: never
    overwrites an existing file (so user edits survive a re-run).
    """
    target = here / "docker-compose.yml"
    if target.exists():
        return target, False
    target.write_text(EMBEDDED_COMPOSE)
    print(f"[minerva] wrote {target}")
    return target, True


def _detect_browser_profile():
    """Find a host browser profile directory yt-dlp can read live.
    Tries the common Linux + macOS paths plus the Flatpak namespaces,
    returns (path, browser_kind) or None. Logs every path it checked
    so a missing-detection failure is self-diagnosing — the next `up`
    output reveals whether the user's browser is somewhere unexpected.
    """
    home = pathlib.Path.home()
    candidates = [
        (home / ".mozilla" / "firefox", "firefox"),
        (home / "snap" / "firefox" / "common" / ".mozilla" / "firefox", "firefox"),
        (home / ".var" / "app" / "org.mozilla.firefox" / ".mozilla" / "firefox", "firefox"),
        (home / ".config" / "google-chrome", "chrome"),
        (home / ".var" / "app" / "com.google.Chrome" / "config" / "google-chrome", "chrome"),
        (home / ".config" / "chromium", "chromium"),
        (home / ".var" / "app" / "org.chromium.Chromium" / "config" / "chromium", "chromium"),
        (home / ".config" / "BraveSoftware" / "Brave-Browser", "brave"),
        (home / ".var" / "app" / "com.brave.Browser" / "config" / "BraveSoftware" / "Brave-Browser", "brave"),
        (home / ".config" / "vivaldi", "vivaldi"),
        (home / "Library" / "Application Support" / "Firefox" / "Profiles", "firefox"),
        (home / "Library" / "Application Support" / "Google" / "Chrome", "chrome"),
    ]
    print("[minerva] scanning host browser profile paths…", file=sys.stderr)
    for path, kind in candidates:
        try:
            ok = path.is_dir()
        except Exception as exc:  # noqa: BLE001
            print(f"           {path} → error: {exc}", file=sys.stderr)
            continue
        marker = "✓" if ok else "·"
        print(f"           {marker} {path}", file=sys.stderr)
        if ok:
            return (path, kind)
    return None


def _write_cookies_override(here, cookies_path, browser_profile=None):
    """Write a docker-compose.override.yml that bind-mounts the host
    cookies file into the minerva-services container at /srv/cookies.txt
    AND, when present, bind-mounts the host's browser profile into
    /host-browser so yt-dlp can use --cookies-from-browser for live
    (non-snapshot) cookies. Also mounts the host's ~/Minerva tree at
    /srv/files so /file/save lands files where the user can find them
    in their file manager. Compose auto-loads override files, so this
    composes with whatever the upstream docker-compose.yml says.
    """
    target = here / "docker-compose.override.yml"
    files_dir = pathlib.Path.home() / "Minerva"
    files_dir.mkdir(parents=True, exist_ok=True)
    lines = [
        "# Auto-generated by `minerva-services.py up` — safe to delete.",
        "# Bind-mounts cookies.txt + browser profile + the host Minerva",
        "# files dir so authenticated downloads + Save-to-disk land in",
        "# ~/Minerva on the host where you can open them in a file manager.",
        "services:",
        "  minerva-services:",
        "    environment:",
        "      MINERVA_FILES_ROOT: /srv/files",
        "      MINERVA_FILES_HOST: " + str(files_dir),
    ]
    if browser_profile is not None:
        host_path, kind = browser_profile
        container_path = "/host-browser/" + kind
        lines += [
            f"      MINERVA_BROWSER_PROFILE: {container_path}",
            f"      MINERVA_BROWSER_KIND: {kind}",
        ]
        lines += [
            "    volumes:",
            f"      - {cookies_path}:/srv/cookies.txt:ro",
            f"      - {host_path}:{container_path}:ro",
            f"      - {files_dir}:/srv/files",
        ]
    else:
        lines += [
            "    volumes:",
            f"      - {cookies_path}:/srv/cookies.txt:ro",
            f"      - {files_dir}:/srv/files",
        ]
    target.write_text("\n".join(lines) + "\n")
    return target


def _reap_orphan_containers(names):
    """Force-remove the named containers if they exist. Compose stalls
    when a container_name slot is already taken by an unrelated
    container (e.g. from a previous standalone `docker run`)."""
    for name in names:
        try:
            out = subprocess.run(
                ["docker", "ps", "-aq", "--filter", f"name=^/{name}$"],
                capture_output=True, text=True, check=True,
            )
            if out.stdout.strip():
                subprocess.run(["docker", "rm", "-f", name], check=True,
                               stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
                print(f"[minerva] removed orphan container {name}")
        except Exception as exc:  # noqa: BLE001
            print(f"[minerva] could not check {name}: {exc}", file=sys.stderr)


def _cmd_up(browser):
    """One-shot bring-up: cookies + override + timer + pull + up."""
    if not shutil.which("docker"):
        print("[minerva] docker not found on PATH. Install Docker first.", file=sys.stderr)
        return 1

    here = pathlib.Path(__file__).resolve().parent
    cookies_dir = pathlib.Path.home() / ".minerva"
    cookies_dir.mkdir(parents=True, exist_ok=True)
    cookies_file = cookies_dir / "cookies.txt"
    if not cookies_file.exists():
        cookies_file.touch()

    print("[minerva] step 1/5: refreshing cookies from your browser…")
    rc = _refresh_cookies(browser)
    if rc != 0 and cookies_file.stat().st_size == 0:
        print(
            "[minerva] no cookies were captured — yt-dlp will hit YouTube's bot wall on\n"
            "          gated videos until you log in to a supported browser. Continuing\n"
            "          with the rest of the setup so the rest of Minerva still works.",
            file=sys.stderr,
        )

    print("[minerva] step 2/5: ensuring docker-compose.yml exists…")
    _ensure_compose_file(here)

    print("[minerva] step 3/5: writing docker-compose.override.yml for cookies mount…")
    profile = _detect_browser_profile()
    if profile:
        print(f"[minerva]            also mounting browser profile {profile[0]} ({profile[1]}) "
              "→ live --cookies-from-browser inside the container.")
    _write_cookies_override(here, cookies_file, profile)

    if os.environ.get("MINERVA_NO_TIMER") != "1":
        print("[minerva] step 4/5: installing systemd-user timer for hourly refresh…")
        _install_cookie_timer(browser)
    else:
        print("[minerva] step 4/5: skipping timer (MINERVA_NO_TIMER=1).")

    # Prefer building from local source when a Dockerfile is present
    # next to the compose file — that's the case for anyone with a
    # checkout, and it sidesteps the lag between a `services-v*` tag
    # push and Docker Hub finishing the multi-arch build. Falls back
    # to pull when there's no local Dockerfile (the no-checkout path).
    has_local_dockerfile = (here / "Dockerfile").is_file()
    if has_local_dockerfile:
        print("[minerva] step 5/8: building image from local source…")
        try:
            subprocess.run(
                ["docker", "compose", "build", "--pull"],
                cwd=here, check=True,
            )
        except subprocess.CalledProcessError as exc:
            print(f"[minerva] docker compose build failed: {exc}", file=sys.stderr)
            return exc.returncode or 1
    else:
        print("[minerva] step 5/8: pulling latest image and starting the stack…")
        try:
            subprocess.run(["docker", "compose", "pull"], cwd=here, check=False)
        except Exception as exc:  # noqa: BLE001
            print(f"[minerva] docker compose pull failed: {exc}", file=sys.stderr)

    _reap_orphan_containers(["minerva-services", "minerva-postgres"])

    try:
        subprocess.run(
            ["docker", "compose", "up", "-d", "--remove-orphans"],
            cwd=here, check=True,
        )
    except subprocess.CalledProcessError as exc:
        print(f"[minerva] docker compose up failed: {exc}", file=sys.stderr)
        return exc.returncode or 1

    print("[minerva] step 6/8: waiting for container to be ready…")
    if not _wait_for_health("http://127.0.0.1:8765/health", timeout=60):
        print("[minerva] container didn't report healthy in 60s; continuing anyway.", file=sys.stderr)

    print("[minerva] step 7/8: upgrading yt-dlp inside the container…")
    # YouTube's anti-bot logic moves faster than published images. Force
    # the freshest yt-dlp into the running container so first-use isn't
    # gambling on whatever shipped in the image. Idempotent — pip exits
    # quickly when nothing's to upgrade.
    try:
        subprocess.run(
            ["docker", "exec", "minerva-services",
             "pip", "install", "--upgrade", "--no-cache-dir", "--quiet", "yt-dlp"],
            check=False, timeout=120,
        )
        subprocess.run(["docker", "restart", "minerva-services"],
                       check=False, stdout=subprocess.DEVNULL)
        # Restart triggers another health probe; give the container a beat.
        _wait_for_health("http://127.0.0.1:8765/health", timeout=60)
    except Exception as exc:  # noqa: BLE001
        print(f"[minerva] yt-dlp upgrade in-container skipped: {exc}", file=sys.stderr)

    print("[minerva] step 8/9: verifying cookies file has YouTube entries…")
    yt_count = _count_youtube_cookies(cookies_file)
    if yt_count == 0 and cookies_file.stat().st_size > 0:
        print(
            "[minerva] heads-up: cookies.txt is populated but contains 0 cookies for\n"
            "          youtube.com domains. (Snapshot mode only — ignore if you're\n"
            "          on live-profile mode confirmed in the next step.)",
            file=sys.stderr,
        )
    elif yt_count == 0:
        print("[minerva] no cookies dumped — gated YouTube videos will fail to download.",
              file=sys.stderr)
    else:
        print(f"[minerva] {yt_count} YouTube cookies present in snapshot.")

    print("[minerva] step 9/9: confirming what the container actually sees…")
    _probe_container_auth_mode()

    subprocess.run(["docker", "compose", "ps"], cwd=here, check=False)
    print("\n[minerva] ready:")
    print("           status:  http://localhost:8765/")
    print("           app:     http://localhost:8765/app/")
    return 0


def _probe_container_auth_mode():
    """Ask the running container which auth mode it'll use for the
    next yt-dlp call. Catches misconfigurations end-to-end:
    - env var present but bind-mount empty (bad path on host),
    - bind-mount present but no MINERVA_BROWSER_PROFILE (stale image
      that doesn't know about the new env contract),
    - neither (snapshot fallback).
    """
    try:
        out = subprocess.run(
            ["docker", "exec", "minerva-services", "python3", "-c", (
                "import os, json; "
                "p = os.environ.get('MINERVA_BROWSER_PROFILE',''); "
                "k = os.environ.get('MINERVA_BROWSER_KIND',''); "
                "live = bool(p) and os.path.isdir(p); "
                "snap = '/srv/cookies.txt'; "
                "snap_ok = os.path.isfile(snap) and os.path.getsize(snap) > 0; "
                "print(json.dumps({'profile': p, 'kind': k, 'live': live, "
                "  'profile_listing': sorted(os.listdir(p))[:5] if live else [], "
                "  'snapshot_path': snap, 'snapshot_ok': snap_ok}))"
            )],
            capture_output=True, text=True, timeout=10,
        )
        if out.returncode != 0:
            print(f"[minerva]   probe failed: {out.stderr.strip()}", file=sys.stderr)
            return
        import json as _json
        info = _json.loads(out.stdout.strip().splitlines()[-1])
        if info.get("live"):
            print(f"[minerva]   ✓ live mode: {info['kind']} profile at {info['profile']}")
            print(f"[minerva]     profile contains: {', '.join(info['profile_listing']) or '(empty?)'}")
            if not info["profile_listing"]:
                print("[minerva]     bind mount looks empty — the host directory may be "
                      "wrong or your browser profile lives elsewhere.", file=sys.stderr)
        elif info.get("snapshot_ok"):
            print(f"[minerva]   ⚠ snapshot mode: {info['snapshot_path']} (will go stale).")
            print("[minerva]     If this is unexpected, the override didn't pick up your "
                  "browser profile path. Paste docker-compose.override.yml and I'll "
                  "diagnose.", file=sys.stderr)
        else:
            print("[minerva]   ✗ no auth available — both live profile and snapshot are "
                  "unreachable. Gated YouTube videos will fail.", file=sys.stderr)
    except Exception as exc:  # noqa: BLE001
        print(f"[minerva]   probe failed: {exc}", file=sys.stderr)


def _wait_for_health(url, timeout=60):
    """Poll until a GET on `url` returns 2xx, or `timeout` seconds elapse."""
    import time
    import urllib.request
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if 200 <= r.status < 300:
                    return True
        except Exception:
            pass
        time.sleep(1.5)
    return False


def _count_youtube_cookies(path):
    """Return the number of YouTube-domain cookies in a Netscape file.
    Zero means: the file exists but the browser hasn't set any
    google.com / youtube.com cookies — usually because the user hasn't
    actually visited youtube.com signed in recently."""
    try:
        if not path.is_file() or path.stat().st_size == 0:
            return 0
        n = 0
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if line.startswith("#") or not line.strip():
                    continue
                domain = line.split("\t", 1)[0].lower()
                if "youtube.com" in domain or "google.com" in domain:
                    n += 1
        return n
    except Exception:
        return 0


def _cmd_down():
    here = pathlib.Path(__file__).resolve().parent
    return subprocess.run(
        ["docker", "compose", "down"], cwd=here, check=False,
    ).returncode


def _cmd_logs():
    here = pathlib.Path(__file__).resolve().parent
    return subprocess.run(
        ["docker", "compose", "logs", "-f", "--tail=200"], cwd=here, check=False,
    ).returncode


def _cmd_test_cookies(url):
    """Exercise yt-dlp inside the container with the active auth mode
    and dump the raw outcome. Surfaces the genuine yt-dlp error when
    `up` reports live mode but downloads still fail."""
    print(f"[minerva] testing yt-dlp against {url} via the container's active auth…")
    script = (
        "import os, sys, json, traceback\n"
        "import yt_dlp\n"
        "opts = {'quiet': True, 'skip_download': True}\n"
        "p = os.environ.get('MINERVA_BROWSER_PROFILE','')\n"
        "k = os.environ.get('MINERVA_BROWSER_KIND','firefox') or 'firefox'\n"
        "if p and os.path.isdir(p):\n"
        "    opts['cookiesfrombrowser'] = (k, p, None, None)\n"
        "    print('AUTH: live profile', k, p)\n"
        "elif os.path.isfile('/srv/cookies.txt'):\n"
        "    opts['cookiefile'] = '/srv/cookies.txt'\n"
        "    print('AUTH: snapshot /srv/cookies.txt')\n"
        "else:\n"
        "    print('AUTH: none')\n"
        "try:\n"
        "    with yt_dlp.YoutubeDL(opts) as ydl:\n"
        "        info = ydl.extract_info(sys.argv[1], download=False)\n"
        "        print('OK title:', info.get('title'))\n"
        "except Exception as exc:\n"
        "    print('ERROR:', type(exc).__name__, exc)\n"
        "    traceback.print_exc()\n"
    )
    rc = subprocess.run(
        ["docker", "exec", "minerva-services", "python3", "-c", script, url],
        check=False,
    ).returncode
    return rc


def _cmd_status():
    here = pathlib.Path(__file__).resolve().parent
    return subprocess.run(
        ["docker", "compose", "ps"], cwd=here, check=False,
    ).returncode


def _print_help():
    print(
        "Minerva — single-script setup + helper.\n"
        "\n"
        "Usage:\n"
        "  minerva-services.py up [browser]        bootstrap + start the stack\n"
        "  minerva-services.py down                stop the stack\n"
        "  minerva-services.py logs                tail container logs\n"
        "  minerva-services.py status              docker compose ps\n"
        "  minerva-services.py refresh-cookies     dump cookies into ~/.minerva/cookies.txt\n"
        "  minerva-services.py install-timer       hourly systemd-user cookie refresh\n"
        "  minerva-services.py test-cookies [url]  run yt-dlp against the configured auth\n"
        "                                          and dump the raw outcome (handy when\n"
        "                                          `up` says live mode but downloads fail)\n"
        "  minerva-services.py serve               run the Flask server (used inside\n"
        "                                          the container; not for end users)\n"
        "\n"
        "Run with no args inside a checkout to start the Flask server\n"
        "directly (back-compat). With no checkout, prefer `up`.\n"
        "\n"
        "Examples:\n"
        "  python3 minerva-services.py up               # firefox cookies\n"
        "  python3 minerva-services.py up chrome        # chrome cookies\n"
        "  MINERVA_NO_TIMER=1 ./minerva-services.py up  # skip the timer install\n"
    )


if __name__ == "__main__":
    # ---- Subcommand dispatch ----
    # Backwards-compat flags first so existing cron jobs keep working.
    if "--refresh-cookies" in sys.argv:
        i = sys.argv.index("--refresh-cookies")
        chosen = sys.argv[i + 1] if i + 1 < len(sys.argv) and not sys.argv[i + 1].startswith("-") else None
        sys.exit(_refresh_cookies(chosen))
    if "--install-cookie-timer" in sys.argv:
        i = sys.argv.index("--install-cookie-timer")
        chosen = sys.argv[i + 1] if i + 1 < len(sys.argv) and not sys.argv[i + 1].startswith("-") else None
        sys.exit(_install_cookie_timer(chosen))

    sub = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("-") else None
    if sub in ("-h", "--help", "help"):
        _print_help(); sys.exit(0)
    if sub == "up":
        chosen = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("MINERVA_BROWSER", "firefox")
        sys.exit(_cmd_up(chosen))
    if sub == "down":
        sys.exit(_cmd_down())
    if sub == "logs":
        sys.exit(_cmd_logs())
    if sub == "status":
        sys.exit(_cmd_status())
    if sub == "refresh-cookies":
        chosen = sys.argv[2] if len(sys.argv) > 2 else None
        sys.exit(_refresh_cookies(chosen))
    if sub == "test-cookies":
        target_url = sys.argv[2] if len(sys.argv) > 2 else "https://www.youtube.com/watch?v=a3iCti5W6PY"
        sys.exit(_cmd_test_cookies(target_url))
    if sub == "install-timer":
        chosen = sys.argv[2] if len(sys.argv) > 2 else None
        sys.exit(_install_cookie_timer(chosen))
    # Catch typos: any non-empty `sub` that isn't an explicit `serve`
    # is treated as an unknown subcommand. Without this, a fat-finger
    # like `test-cockies` silently fell through to "start the Flask
    # server", which then collided with whatever was already on 8765.
    if sub and sub != "serve":
        print(f"[minerva] unknown subcommand: {sub!r}", file=sys.stderr)
        _print_help()
        sys.exit(2)
    # Bare invocation (or `serve`) → start the Flask server. This is the
    # path the container's CMD uses; running it on the host with no
    # subcommand drops you straight into the helper, same as before.

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
    print(f"  Status page:               {base}/")
    print(f"  Bundled SPA:               {base}/app/")
    print(f"  Health check:              {base}/health")
    print(f"  Stop the server:           POST {base}/shutdown")
    print(f"  Docs:                      docs/setup-local-services.md")
    print("─" * 60)
    if not detach:
        print("  Press Ctrl-C to stop. Run with --detach to background.")
    print("─" * 60)
    app.run(host=host, port=port, threaded=True)
