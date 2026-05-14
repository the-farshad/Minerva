# Minerva local yt-dlp worker

The DigitalOcean droplet's IP range is hard-blocked by YouTube
anti-bot. Cookies + PO token + 5 player-clients + 6 Piped fallbacks
all return *Sign in to confirm you're not a bot* even for the very
first public YouTube video. Running yt-dlp on a residential IP
sidesteps the problem entirely.

This worker runs on **your machine** (laptop, home server, NAS),
polls the droplet for queued downloads, runs `yt-dlp` locally, and
uploads the resulting bytes straight to **your** Google Drive (using
a short-lived access token the droplet mints per claim). The bytes
never cross the droplet — saves bandwidth and dodges the anti-bot
wall in one go.

## Setup

### 1. Generate a shared secret

```sh
openssl rand -hex 32
```

### 2. Configure the droplet

Add to `/etc/minerva/app.env` (or wherever the droplet's compose
reads env from):

```env
WORKER_QUEUE_ENABLED=1
WORKER_SECRET=<the secret you just generated>
```

Restart the minerva-web container so it picks up the new env.

### 3. Install prerequisites on the worker machine

```sh
# Node 18+ (built-in fetch / FormData / Blob)
node --version

# yt-dlp + ffmpeg (pip preferred — keeps yt-dlp current)
pip install --upgrade --pre yt-dlp
brew install ffmpeg     # macOS
# OR
sudo apt install ffmpeg # Debian / Ubuntu
```

### 4. Run the worker

```sh
MINERVA_BASE=https://minerva.thefarshad.com \
WORKER_SECRET=<the same secret> \
node tools/yt-worker.js
```

You should see:

```
2026-05-14T01:23:45.000Z minerva yt-worker → https://minerva.thefarshad.com, poll every 5000ms
```

Trigger a "Save offline" on a YouTube row in the web UI. The worker
log line will follow:

```
… job <id>: yt-dlp https://www.youtube.com/watch?v=…
… job <id>: uploading <title>.mp4 (87.4 MB)
… job <id>: drive <fileId>
```

…and the web UI's row picks up its `drive:` offline marker through
the existing SSE channel, no refresh needed.

## Running the worker as a service

### macOS (`launchd`)

`~/Library/LaunchAgents/com.thefarshad.minerva-worker.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.thefarshad.minerva-worker</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/Minerva/tools/yt-worker.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MINERVA_BASE</key><string>https://minerva.thefarshad.com</string>
    <key>WORKER_SECRET</key><string>...</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/minerva-worker.out.log</string>
  <key>StandardErrorPath</key><string>/tmp/minerva-worker.err.log</string>
</dict>
</plist>
```

Load with `launchctl load ~/Library/LaunchAgents/com.thefarshad.minerva-worker.plist`.

### Linux (`systemd --user`)

`~/.config/systemd/user/minerva-worker.service`:

```ini
[Unit]
Description=Minerva yt-dlp local worker

[Service]
Type=simple
Environment=MINERVA_BASE=https://minerva.thefarshad.com
Environment=WORKER_SECRET=...
ExecStart=/usr/bin/node /path/to/Minerva/tools/yt-worker.js
Restart=always
RestartSec=10s

[Install]
WantedBy=default.target
```

`systemctl --user enable --now minerva-worker.service`

## When the worker is offline

Jobs accumulate in the `download_jobs` table. The web UI shows the
row as "queued"; the moment the worker comes back up and starts
polling, it drains them in FIFO order. No data loss.

## Tearing down

To revert to the in-droplet (synchronous) path:

```env
WORKER_QUEUE_ENABLED=
```

…and restart `minerva-web`. The legacy helper path lights back up
immediately. Existing queued jobs stay in the DB until manually
dequeued (or until the user re-triggers the row's save-offline).
