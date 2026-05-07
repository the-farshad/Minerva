# Minerva — full-stack image. Bakes the static SPA + minerva-services
# (yt-dlp downloader, CORS proxy, Postgres mirror endpoints, opendataloader-pdf
# extractor) into one container. Open http://localhost:8765/ to use the app
# without GitHub Pages or a separate static host.
#
# Build (from the repo root):
#     docker build -t minerva-services -f docs/Dockerfile .
#
# Run:
#     docker run --rm -p 8765:8765 minerva-services
#     # → http://localhost:8765
#
# Or with docker-compose:
#     cd docs && docker compose up

FROM python:3.12-slim

# ffmpeg lets yt-dlp merge separate video / audio streams and produce
# mp3. postgresql-client provides pg_dump for the /db/dump endpoint.
# unzip + curl are needed to fetch the Deno tarball below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ffmpeg ca-certificates postgresql-client curl unzip \
    && rm -rf /var/lib/apt/lists/*

# Deno is the JS runtime yt-dlp's EJS solver uses to crack YouTube's
# n-challenge — without it, recent uploads return only storyboard
# images and every download fails with "Requested format not available."
# Pin a known-good version so the build is reproducible. Multi-arch
# Docker selects amd64/arm64 via TARGETARCH.
ARG TARGETARCH
RUN set -e; \
    case "${TARGETARCH:-amd64}" in \
        amd64) DENO_ARCH=x86_64-unknown-linux-gnu ;; \
        arm64) DENO_ARCH=aarch64-unknown-linux-gnu ;; \
        *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/denoland/deno/releases/download/v2.0.6/deno-${DENO_ARCH}.zip" -o /tmp/deno.zip; \
    unzip -q /tmp/deno.zip -d /usr/local/bin; \
    chmod +x /usr/local/bin/deno; \
    rm /tmp/deno.zip; \
    deno --version

# Python deps. The script self-bootstraps a venv on first host-side run;
# inside the container we install system-wide so startup is instant.
RUN pip install --no-cache-dir flask yt-dlp requests "psycopg[binary]" opendataloader-pdf

WORKDIR /srv

# Application code + static frontend. The build context for this
# Dockerfile is the repo root (see docker-compose.yml: context: ..),
# so we can pull both the helper script and the SPA assets in one go.
COPY docs/minerva-services.py /srv/minerva-services.py
COPY index.html manifest.webmanifest opensearch.xml privacy.html terms.html rss.html sw.js /srv/static/
COPY assets /srv/static/assets

ENV MINERVA_HOST=0.0.0.0 \
    MINERVA_PORT=8765 \
    MINERVA_STATIC_DIR=/srv/static \
    PYTHONUNBUFFERED=1

EXPOSE 8765

# Self-upgrade yt-dlp on container start. YouTube rotates anti-bot
# logic frequently; an image built two weeks ago is often the reason
# downloads start failing with "Sign in to confirm you're not a bot"
# even when cookies are valid. The upgrade is bounded by a 30s timeout
# so a flaky network can't block the helper from coming up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/health').read()"

CMD ["sh", "-c", "timeout 30 pip install --quiet --no-cache-dir --upgrade yt-dlp 2>/dev/null || true; exec python minerva-services.py"]
