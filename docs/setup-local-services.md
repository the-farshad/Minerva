# Run Minerva's local services

A single helper process powers two optional Minerva features:

- **yt-dlp server** — one-click YouTube downloads from the per-row
  Download button (saves into the browser's IndexedDB; works offline
  once cached).
- **CORS proxy** — forwards bibliographic fetches (arXiv, CrossRef,
  Semantic Scholar, YouTube oEmbed) so the in-browser metadata
  importer stops hitting CORS errors.

Both endpoints are served from one process. Three ways to run it.

---

## 1 · One Python script (lightest)

```sh
python3 docs/minerva-services.py
```

First run creates a virtualenv at `~/.minerva-services` and installs
Flask, yt-dlp, and `requests`. Subsequent runs reuse that venv and
start in <1 s.

Default bind: `http://127.0.0.1:8765`. Environment overrides:

| Variable        | Default                  | What it controls          |
|-----------------|--------------------------|---------------------------|
| `MINERVA_HOST`  | `127.0.0.1`              | bind address              |
| `MINERVA_PORT`  | `8765`                   | bind port                 |
| `MINERVA_VENV`  | `~/.minerva-services`    | virtualenv location       |

Wire into Minerva → **Settings**:

| Field            | Value                                |
|------------------|--------------------------------------|
| yt-dlp server    | `http://localhost:8765`              |
| CORS proxy       | `http://localhost:8765/proxy?`       |

The Settings page shows live status pills next to each field — green
when the server answers `/health`, red when the request fails.

---

## 2 · Docker (one container, both services)

```sh
cd docs
docker build -t minerva-services -f Dockerfile .
docker run --rm -p 8765:8765 minerva-services
```

Image is `python:3.12-slim` + `ffmpeg` + the three Python deps. ~120
MB. Ports the same as option 1.

### docker compose

```sh
cd docs
docker compose up -d   # background
docker compose logs -f # tail logs
docker compose down    # stop
```

The compose file in `docs/docker-compose.yml` adds a healthcheck
and `restart: unless-stopped` so the container survives reboots when
Docker is set to autostart.

---

## 3 · System service

### systemd (Linux)

`~/.config/systemd/user/minerva-services.service`:

```ini
[Unit]
Description=Minerva local services (yt-dlp + CORS proxy)
After=network.target

[Service]
ExecStart=%h/.minerva-services/bin/python %h/code/Minerva/docs/minerva-services.py
Restart=on-failure
Environment=MINERVA_HOST=127.0.0.1
Environment=MINERVA_PORT=8765

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now minerva-services
journalctl --user -u minerva-services -f
```

The `ExecStart` path assumes you have run `python3 minerva-services.py`
once already so the bootstrap step has populated the venv.

### launchd (macOS)

`~/Library/LaunchAgents/com.minerva.services.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>           <string>com.minerva.services</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>/Users/YOU/code/Minerva/docs/minerva-services.py</string>
  </array>
  <key>RunAtLoad</key>       <true/>
  <key>KeepAlive</key>       <true/>
  <key>StandardOutPath</key> <string>/tmp/minerva-services.log</string>
  <key>StandardErrorPath</key><string>/tmp/minerva-services.err</string>
</dict>
</plist>
```

```sh
launchctl load ~/Library/LaunchAgents/com.minerva.services.plist
```

---

## 4 · Endpoints (for the curious)

| Method | Path                       | Body / query                                 |
|--------|----------------------------|----------------------------------------------|
| `POST` | `/download`                | `{ "url": "...", "format": "mp4" }`          |
| `GET`  | `/proxy?<encoded-url>`     | (empty)                                      |
| `POST` | `/proxy?<encoded-url>`     | forwarded as the upstream POST body          |
| `POST` | `/pdf/extract`             | `{ "url": "<pdf url>" }` — runs `opendataloader-pdf`, returns extracted JSON |
| `GET`  | `/db/health`               | returns `{ ok, configured }` for the PG mirror |
| `GET`  | `/db/rows/<tab>?since=<ts>`| live rows in the named section                |
| `POST` | `/db/upsert/<tab>`         | `{ "rows": [...] }`                          |
| `POST` | `/db/delete/<tab>`         | `{ "ids": [...] , "hard": false }`           |
| `GET`  | `/db/dump`                 | streams a `pg_dump` of the database          |
| `GET`  | `/health`                  | returns `{ ok, service, endpoints, postgres, pdf_extractor }` |
| `GET`  | `/`                        | minimal HTML status page                     |

The CORS proxy enforces a host allow-list (`PROXY_ALLOWED_HOSTS` in
`minerva-services.py`). Add hosts you trust; remove the allow-list at
your own risk.

---

## 5 · Troubleshooting

**Status pill in Settings is red, but `curl http://localhost:8765/health` works.**
Browsers block localhost requests from a hosted page when the page is
served over HTTPS and tries to call `http://`. Either run the Minerva
front-end over HTTP (e.g. `python3 -m http.server 8000` on the repo)
or point the Settings field at `https://localhost:8765` and set up a
self-signed cert in front of the script (out of scope for this doc).

**`yt-dlp failed: Sign in to confirm you're not a bot`**
YouTube increasingly gates videos behind a cookie check. Export a
Netscape-format `cookies.txt` from a logged-in browser (the
[Get cookies.txt LOCALLY](https://github.com/kairi003/Get-cookies.txt-LOCALLY)
extension produces the right format) and:

- **Bare-script setup** — save it as `~/.minerva/cookies.txt`. The
  service auto-detects this path on each download.
- **Docker setup** — save it at `~/.minerva/cookies.txt` on the host,
  then uncomment the `volumes:` block under `minerva-services` in
  `docker-compose.yml` so the file shows up at `/srv/cookies.txt`
  inside the container. Run `docker compose up -d` again to pick it up.

Or override the path explicitly with `MINERVA_COOKIES_FILE=/some/path`.

**`/proxy` returns 403 "Host 'X' is not in the allow-list"**
The CORS proxy intentionally restricts forwarding. Add the host to
`PROXY_ALLOWED_HOSTS` and restart.

**Slow downloads.**
yt-dlp throttling is YouTube-side. Try a different `format` (e.g.
`best` instead of `bestvideo+bestaudio/best`).

---

## 6 · Security note

Bind to `127.0.0.1` (the default) and only processes on your own
machine can hit the endpoints. If you bind to `0.0.0.0` for LAN
access, put the service behind Tailscale / WireGuard or add an
auth token check inside the Flask handlers — there is no
authentication built in.
