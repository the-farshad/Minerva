# Running Minerva locally

Minerva as a **local, single-machine app** — no public host, no cloud database.
Your data lives in a local Postgres (a Docker volume on your machine). This is
the minimal setup: the web app + its database, nothing else.

## Prerequisites

- Docker + Docker Compose
- A Google OAuth **Web** client (you can reuse the existing one). Add this
  redirect URI to it in Google Cloud Console → Credentials:
  ```
  http://localhost:3000/api/auth/callback/google
  ```

## 1. Configure

```sh
cd web
cp .env.example .env
```

Edit `web/.env`:

```sh
AUTH_SECRET=            # openssl rand -base64 32
NEXTAUTH_URL=http://localhost:3000
GOOGLE_OAUTH_CLIENT_ID=      # reuse your existing client
GOOGLE_OAUTH_CLIENT_SECRET=
# DATABASE_URL is set by the compose file — leave the default.
```

## 2. Start

```sh
cd docs
docker compose -f docker-compose.local.yml up -d
# add --build to build the web image from ../web instead of pulling
open http://localhost:3000
```

The web container runs its database migrations automatically on boot, so a fresh
start gives you an empty, working Minerva.

## 3. Restore your data (first run only)

To load the data exported from the old hosted instance, restore the archived
dump **before** first use, so the app's boot-time migration is a no-op:

```sh
# bring up only the database first
cd docs
docker compose -f docker-compose.local.yml up -d postgres
# wait a few seconds for it to become healthy, then restore:
zcat ~/backups/thefarshad-sunset/minerva/db/minerva-postgres.sql.gz \
  | docker exec -i minerva-postgres psql -U minerva -d minerva
# now start the app (its startup migration will see everything already applied)
docker compose -f docker-compose.local.yml up -d
```

> The dump includes the drizzle migration ledger, so the app won't try to
> re-apply anything. Files you'd created (sketches, uploaded papers, exported
> PDFs) live in **your Google Drive**, not the database — they reattach once you
> sign in with the same Google account.

## Everyday use

```sh
docker compose -f docker-compose.local.yml up -d     # start
docker compose -f docker-compose.local.yml down      # stop (data persists)
docker compose -f docker-compose.local.yml logs -f minerva-web
```

Back up your local data anytime:

```sh
docker exec minerva-postgres pg_dump -U minerva -d minerva | gzip > minerva-$(date +%F).sql.gz
```

## Want the import/download extras?

The yt-dlp downloader and PDF/arXiv **import** helpers need the Python service
(and, for YouTube, the PO-token sidecar). To run the full stack instead, use
`docker-compose.yml` (see its header) — it adds `minerva-services` and
`minerva-pot`. Everything else works without them.
