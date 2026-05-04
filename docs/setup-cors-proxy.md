# Set up the CORS proxy (self-hosted)

Some upstream APIs that Minerva consumes for paper / video metadata —
**arXiv** (`export.arxiv.org`), **CrossRef** (`api.crossref.org`),
YouTube's **oEmbed** endpoint, and **Semantic Scholar** — do not respond
with `Access-Control-Allow-Origin` headers. Browsers therefore block
the responses with a `NetworkError` ("Failed to fetch"), and metadata
auto-fill stops working.

The fix is a thin proxy that fetches the upstream server-side and
re-emits the response with permissive CORS headers. Minerva ships with
a public default (`https://corsproxy.io/?`) so the feature works out of
the box, but if you want to avoid leaking your reading list to a third
party, a 60-line Python script is enough to self-host.

This document walks through running the reference script.

---

## 1 · Prerequisites

- **Python 3.9+**
- `flask` and `requests`

```sh
pip install --user flask requests
# or:
uv pip install flask requests
```

If `pip install` complains about an "externally managed environment",
either pass `--break-system-packages` or use a venv (or `uv venv`).

---

## 2 · Run the proxy

```sh
cd Minerva
python3 docs/cors-proxy.py
# or with uv:
uv run --with flask --with requests python docs/cors-proxy.py
```

You should see:

```
Minerva CORS proxy listening at http://127.0.0.1:8081
```

Override the bind address with environment variables:

```sh
MINERVA_CORS_PORT=9000 python3 docs/cors-proxy.py
MINERVA_CORS_HOST=0.0.0.0 python3 docs/cors-proxy.py   # exposes to LAN
```

---

## 3 · Wire Minerva to it

1. Open Minerva → **Settings** → "CORS proxy".
2. Replace the default with `http://localhost:8081/?` (mind the trailing `?`).
3. Click **Test** — a green "Proxy reaches CrossRef and returns CORS-friendly JSON" confirms it works.
4. Save.

Add a paper from arXiv or DOI in the URL Import modal — metadata now
flows through your local proxy.

---

## 4 · Allow-list

The reference script restricts forwarding to the specific upstreams
Minerva uses:

```python
ALLOWED_HOSTS = {
    "export.arxiv.org",
    "arxiv.org",
    "api.crossref.org",
    "www.youtube.com",
    "youtube.com",
    "youtu.be",
    "api.semanticscholar.org",
}
```

Edit the set in `docs/cors-proxy.py` to allow more (or fewer) hosts.
Removing the allow-list entirely turns the script into an open relay,
which is a bad idea on any port reachable from the public internet.

---

## 5 · The full script

`docs/cors-proxy.py` is reproduced below for reference. Save it
somewhere outside the repo if you'd rather run it independently — it
has no Minerva-specific dependencies.

```python
#!/usr/bin/env python3
"""Minimal CORS proxy for Minerva's bibliographic fetches."""

import os
import sys
from urllib.parse import unquote, urlparse

try:
    import requests
    from flask import Flask, request, Response, jsonify
except ImportError:
    print("Install dependencies first: pip install flask requests", file=sys.stderr)
    sys.exit(1)

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

@app.route("/", methods=["GET", "POST", "OPTIONS"])
def proxy():
    if request.method == "OPTIONS":
        return ("", 204, _cors_headers())
    target = request.query_string.decode("utf-8", "replace").lstrip("?")
    if not target:
        return ("Empty target.", 400, _cors_headers())
    decoded = unquote(target)
    host = urlparse(decoded).hostname or ""
    if host not in ALLOWED_HOSTS:
        return (f"Host '{host}' not allow-listed.", 403, _cors_headers())
    fwd = {h: request.headers[h] for h in
           ("Accept", "Accept-Language", "Content-Type", "User-Agent")
           if h in request.headers}
    try:
        if request.method == "GET":
            up = requests.get(decoded, headers=fwd, stream=True, timeout=30)
        else:
            up = requests.post(decoded, headers=fwd,
                               data=request.get_data(), stream=True, timeout=30)
    except requests.RequestException as exc:
        return (f"Upstream fetch failed: {exc}", 502, _cors_headers())
    out = dict(_cors_headers())
    for h in ("Content-Type", "Content-Length", "Cache-Control"):
        if h in up.headers:
            out[h] = up.headers[h]
    return Response(up.iter_content(chunk_size=8192),
                    status=up.status_code, headers=out)

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True, "service": "minerva-cors-proxy"})

if __name__ == "__main__":
    host = os.environ.get("MINERVA_CORS_HOST", "127.0.0.1")
    port = int(os.environ.get("MINERVA_CORS_PORT", "8081"))
    print(f"Minerva CORS proxy listening at http://{host}:{port}")
    app.run(host=host, port=port, threaded=True)
```

---

## 6 · Troubleshooting

**"Host 'X' is not in the allow-list."**
Add `X` to `ALLOWED_HOSTS` in the script and restart.

**"Upstream fetch failed: …"**
The upstream API itself is unreachable from your machine (network or
DNS). Try the URL with `curl` from the same shell to confirm.

**"Test" button reports "Cannot reach proxy"**
The Flask server isn't running, isn't on the URL you pasted, or the
trailing `?` is missing.

**Browser still throws NetworkError**
Make sure the trailing `?` is part of the proxy prefix. Settings ⇒ CORS
proxy field ⇒ value should be `http://localhost:8081/?` (Minerva
appends the encoded URL directly after).

---

## 7 · Security note

The allow-list is the only thing keeping random clients from using your
proxy as an open relay. Bind to `127.0.0.1` (the default) and you only
expose it to processes on your own machine. If you intentionally bind
to `0.0.0.0`, put it behind a Tailscale / WireGuard tunnel, add a token
check, or shrink `ALLOWED_HOSTS` to the minimum you need.
