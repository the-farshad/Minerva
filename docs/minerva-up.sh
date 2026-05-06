#!/usr/bin/env bash
# minerva-up — refresh YouTube cookies from your local browser, then
# bring the Docker stack up. Run this instead of `docker compose up -d`
# so the bind-mounted cookies.txt stays fresh as YouTube rotates
# session tokens.
#
# Usage:
#     ./minerva-up.sh                 # auto-pick browser
#     MINERVA_BROWSER=chrome ./minerva-up.sh
#
# Required:
#   - python3 on PATH (uses the same script's --refresh-cookies mode)
#   - docker compose v2
#   - the volumes: line under minerva-services in docker-compose.yml
#     uncommented (so /srv/cookies.txt resolves)

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BROWSER="${MINERVA_BROWSER:-firefox}"
COOKIES_DIR="${HOME}/.minerva"
COOKIES_FILE="${COOKIES_DIR}/cookies.txt"

mkdir -p "$COOKIES_DIR"

if python3 "$HERE/minerva-services.py" --refresh-cookies "$BROWSER" 2>/dev/null; then
  echo "[minerva-up] cookies refreshed from $BROWSER → $COOKIES_FILE"
else
  echo "[minerva-up] cookie refresh failed (browser not running, sandboxed, or logged out)."
  if [ ! -s "$COOKIES_FILE" ]; then
    : > "$COOKIES_FILE"  # touch a stub so the bind mount doesn't fail
    echo "[minerva-up] no cookies.txt found — yt-dlp may hit YouTube's bot wall on gated videos."
  else
    echo "[minerva-up] reusing the previous cookies.txt at $COOKIES_FILE."
  fi
fi

cd "$HERE"
docker compose up -d
docker compose ps
