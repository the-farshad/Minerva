#!/usr/bin/env python3
"""
Minimal CORS proxy for Minerva's bibliographic fetches.

Some upstream APIs Minerva consumes (export.arxiv.org, api.crossref.org,
youtube.com/oembed) no longer return Access-Control-Allow-Origin
headers, so direct browser fetches are blocked. This server forwards
the request server-side and re-emits the response with permissive CORS
headers.

Usage:
    pip install flask requests           # or: uv pip install flask requests
    python cors-proxy.py
    # → listens on http://127.0.0.1:8081

Then in Minerva → Settings → "CORS proxy":
    http://localhost:8081/?

Protocol:
    GET  /?<url-encoded-target>          → proxies the GET, streams
                                            the upstream body back.
    POST /?<url-encoded-target>          → forwards the POST body.
    OPTIONS /                            → CORS preflight, returns 204.

The trailing `?` after the host matters — Minerva appends the URL-
encoded target to whatever prefix you paste, so the prefix has to end
with the query separator.
"""

import os
import sys
from urllib.parse import unquote

try:
    import requests
    from flask import Flask, request, Response, jsonify
except ImportError:
    print("Install dependencies first: pip install flask requests", file=sys.stderr)
    sys.exit(1)

app = Flask(__name__)

ALLOWED_HOSTS = {
    # arXiv
    "export.arxiv.org",
    "arxiv.org",
    # CrossRef
    "api.crossref.org",
    # YouTube oEmbed
    "www.youtube.com",
    "youtube.com",
    "youtu.be",
    # Semantic Scholar (alternate metadata source)
    "api.semanticscholar.org",
}


def _cors_headers():
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Expose-Headers": "*",
    }


@app.route("/", methods=["GET", "POST", "OPTIONS"])
def proxy():
    if request.method == "OPTIONS":
        return ("", 204, _cors_headers())

    target = request.query_string.decode("utf-8", "replace").lstrip("?")
    if not target:
        # Plain GET / with no query string: serve the status page.
        if request.method == "GET":
            return index()
        return ("Empty target. Append a URL-encoded URL after `?`.", 400, _cors_headers())

    # query_string carries the raw encoded URL; decode for hostname
    # validation but pass the decoded string to requests so the
    # upstream sees the canonical query.
    try:
        decoded = unquote(target)
    except Exception:  # pragma: no cover
        return ("Bad target encoding.", 400, _cors_headers())

    # Block anything outside the allowlist — the proxy is meant only
    # for Minerva's bibliographic upstreams. Loosen this list if you
    # know what you are doing.
    from urllib.parse import urlparse
    host = urlparse(decoded).hostname or ""
    if host not in ALLOWED_HOSTS:
        return (
            f"Host '{host}' is not in the allow-list. Edit ALLOWED_HOSTS in cors-proxy.py to permit it.",
            403,
            _cors_headers(),
        )

    # Forward selected headers (skip hop-by-hop and host).
    fwd_headers = {}
    for h in ("Accept", "Accept-Language", "Content-Type", "User-Agent"):
        v = request.headers.get(h)
        if v:
            fwd_headers[h] = v

    try:
        if request.method == "GET":
            upstream = requests.get(decoded, headers=fwd_headers, stream=True, timeout=30)
        else:  # POST
            upstream = requests.post(
                decoded,
                headers=fwd_headers,
                data=request.get_data(),
                stream=True,
                timeout=30,
            )
    except requests.RequestException as exc:
        return (f"Upstream fetch failed: {exc}", 502, _cors_headers())

    # Re-emit the body and the upstream's content-type, but always with
    # our CORS headers (the upstream's are usually missing, which is
    # the whole reason this proxy exists).
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


def index():
    # The root path is shadowed by the proxy() handler (which expects a
    # query string). Hitting /index returns this status page so a
    # browser visit to the bare host has somewhere to land.
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
  <p>Usage: append a URL-encoded target after <code>?</code> —
  e.g. <code>/?https%3A%2F%2Fexport.arxiv.org%2Fapi%2Fquery%3Fid_list%3D2401.12345</code>.</p>
  <p>Wire it into Minerva at
  <em>Settings &rarr; CORS proxy</em> with the prefix
  <code>http://localhost:8081/?</code>.</p>
  <p>Health check: <a href="/health">/health</a>.</p>
</body>
</html>""",
        200,
        {"Content-Type": "text/html; charset=utf-8"},
    )


if __name__ == "__main__":
    host = os.environ.get("MINERVA_CORS_HOST", "127.0.0.1")
    port = int(os.environ.get("MINERVA_CORS_PORT", "8081"))
    print(f"Minerva CORS proxy listening at http://{host}:{port}")
    app.run(host=host, port=port, threaded=True)
