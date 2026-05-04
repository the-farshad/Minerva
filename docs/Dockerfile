# Minerva local services — yt-dlp downloader + CORS proxy in one image.
#
# Build:
#     docker build -t minerva-services -f docs/Dockerfile docs/
#
# Run:
#     docker run --rm -p 8765:8765 minerva-services
#     # → http://localhost:8765
#
# Or with docker-compose:
#     cd docs && docker compose up
#
# Wire into Minerva (Settings):
#     yt-dlp server   http://localhost:8765
#     CORS proxy      http://localhost:8765/proxy?

FROM python:3.12-slim

# ffmpeg lets yt-dlp merge separate video / audio streams and produce
# mp3. Skip it and yt-dlp falls back to single-stream formats only.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY minerva-services.py /srv/minerva-services.py

# The script self-bootstraps a venv on first run. Inside the
# container we install deps directly so the image starts instantly
# and survives ephemeral filesystems.
RUN pip install --no-cache-dir flask yt-dlp requests

ENV MINERVA_HOST=0.0.0.0 \
    MINERVA_PORT=8765 \
    PYTHONUNBUFFERED=1

EXPOSE 8765

# Use a non-bootstrapping invocation so the container boots straight
# into the Flask server (the script's _bootstrap_and_reexec() exits
# early when the active interpreter is already in the venv path; here
# the system Python suffices because deps are already installed).
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/health').read()"

CMD ["python", "minerva-services.py"]
