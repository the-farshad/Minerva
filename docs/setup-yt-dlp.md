# Set up the yt-dlp downloader server

Minerva's per-row **Download** button (in the YouTube tracker section) can save videos for offline playback in two ways:

1. **yt-dlp server** (recommended) — a tiny local Python server you run. Click Download → Minerva POSTs the URL → the server runs `yt-dlp` → file streams back into your browser's offline storage. No API key, no third-party.
2. **Cobalt** — alternative path via a self-hosted [Cobalt](https://github.com/imputnet/cobalt) instance. See its repo for setup; this doc covers yt-dlp.

If neither is configured, clicking Download falls back to copying a `yt-dlp …` command to your clipboard so you can run it manually.

---

## 1 · Prerequisites

- **Python 3.9+**
- **`pip`** (comes with Python)
- **`ffmpeg`** on your `$PATH` (only required if you want merged-stream / mp3 / mp4 conversion — yt-dlp picks it up automatically when present)

Quick checks:

```sh
python3 --version
pip --version
ffmpeg -version       # optional but strongly recommended
```

If `ffmpeg` is missing:
- macOS: `brew install ffmpeg`
- Debian/Ubuntu: `sudo apt-get install ffmpeg`
- Windows: <https://www.gyan.dev/ffmpeg/builds/> (add the `bin/` folder to PATH)

---

## 2 · Install dependencies

Pick whichever package manager you have. `uv` is recommended where available — it resolves and installs in seconds.

### With `uv` (recommended)

Install `uv` once: `curl -LsSf https://astral.sh/uv/install.sh | sh` (or `brew install uv`, `pipx install uv`, etc.).

Then either:

```sh
# One-shot run via uv (no venv to manage):
uv run --with flask --with yt-dlp python docs/yt-dlp-server.py
```

or as a project venv:

```sh
uv venv ~/.minerva-ytdl
uv pip install --python ~/.minerva-ytdl/bin/python flask yt-dlp
~/.minerva-ytdl/bin/python docs/yt-dlp-server.py
```

### With `pip`

```sh
pip install --user flask yt-dlp
```

If `pip install` rejects with "externally managed environment" (newer Python on macOS/Linux), use a venv:

```sh
python3 -m venv ~/.minerva-ytdl
~/.minerva-ytdl/bin/pip install flask yt-dlp
~/.minerva-ytdl/bin/python /path/to/Minerva/docs/yt-dlp-server.py
```

### With `pipx`

```sh
pipx install flask
pipx inject flask yt-dlp
pipx run --spec . python docs/yt-dlp-server.py   # from inside the repo
```

---

## 3 · Run the server

The reference server is shipped in this repo at [`docs/yt-dlp-server.py`](yt-dlp-server.py) — about 100 lines, no dependencies beyond Flask + yt-dlp.

```sh
cd Minerva
python3 docs/yt-dlp-server.py
# or with uv:
uv run --with flask --with yt-dlp python docs/yt-dlp-server.py
```

You should see:

```
Minerva yt-dlp server listening at http://127.0.0.1:8080
```

Leave that terminal window open. The server runs as long as you do.

### Port already in use?

```sh
MINERVA_YTDL_PORT=9090 python3 docs/yt-dlp-server.py
```

### Bind to your LAN

By default the server only listens on `127.0.0.1` (your own machine). To let other devices on your network hit it:

```sh
MINERVA_YTDL_HOST=0.0.0.0 python3 docs/yt-dlp-server.py
```

⚠️ Anyone on your LAN can then download through your machine. Keep the default unless you need this.

### Run as a background service

A minimal `systemd` user unit (`~/.config/systemd/user/minerva-ytdl.service`):

```ini
[Unit]
Description=Minerva yt-dlp downloader
After=network.target

[Service]
ExecStart=%h/.minerva-ytdl/bin/python %h/code/Minerva/docs/yt-dlp-server.py
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now minerva-ytdl
```

On macOS, a `launchd` plist in `~/Library/LaunchAgents/` does the same thing.

---

## 4 · Tell Minerva where it lives

1. Open Minerva → **Settings** → scroll to **yt-dlp server**.
2. Paste `http://localhost:8080` (or whatever port you used).
3. Click **Save**.

That's it. The Download button on every YouTube row now POSTs to your server.

---

## 5 · Use it

- **Per-row Download** — open any YouTube row and click **Download**. A progress card appears bottom-right; when it finishes you get a **Watch offline** button.
- **Per-playlist** — group headers in the YouTube section have a one-click ⬇ icon that downloads every video in the playlist.
- **Bulk** — tick the checkbox on rows you want, then **Download** in the bulk-action bar.

The downloaded video is stored in your browser's IndexedDB. It survives reloads and works offline. Click **Watch offline** in the row's actions, or open the row's URL preview — Minerva uses the local copy if one exists.

### Format choice

Minerva uses your last-saved format (default **mp4**). To change it, **shift-click** the Download button on any row to open the full options modal. Available formats:

- `mp4` — best mp4 yt-dlp can pull
- `best` — best of any single-stream format
- `bestvideo+bestaudio/best` — merge highest-quality video + audio (needs ffmpeg)
- `bestaudio` — audio-only
- `mp3` — audio re-encoded to mp3 (needs ffmpeg)

Whatever format you pick is remembered for next time.

---

## 6 · Troubleshooting

**"yt-dlp failed: Sign in to confirm you're not a bot"**
YouTube occasionally requires cookies for some videos. Edit `docs/yt-dlp-server.py` and add `'cookiefile': '/path/to/cookies.txt'` to `ydl_opts`. Export cookies from your browser via the [Get cookies.txt](https://github.com/kairi003/Get-cookies.txt-LOCALLY) extension.

**"net::ERR_CONNECTION_REFUSED"**
The server isn't running, or Minerva is pointed at the wrong port. Check the terminal where you ran `python3 docs/yt-dlp-server.py` is still alive, and re-paste the URL in Settings.

**"net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin"**
Older browsers / proxies sometimes mangle the CORS preflight. The reference server sets `Access-Control-Allow-Origin: *`; if you've put it behind a reverse proxy, mirror that header in the proxy config.

**Slow downloads**
yt-dlp throttling is YouTube-side, not the server's fault. Try a different format (e.g. `best` instead of `bestvideo+bestaudio/best`), or wait a few minutes.

**The server died**
Check the terminal output for a Python traceback. Most failures are `yt-dlp` complaining about a deleted/private video, an unsupported URL, or a missing dependency (`ffmpeg`).

---

## 7 · Security note

The reference server has zero authentication — anyone who can reach it can download videos through your machine. The default bind is `127.0.0.1` so only you can; **don't expose it to the public internet without adding auth in front of it**. If you need network access, put it behind a Tailscale / WireGuard tunnel, or add a token check to the Flask handler.
