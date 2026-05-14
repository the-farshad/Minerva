# Minerva

A schema-driven personal **and research** planner — goals, tasks, projects, notes, habits, a paper library, a YouTube tracker, and a vector sketch editor, all over sections you define yourself.

**Live:** <https://minerva.thefarshad.com> — running **Minerva v2**.

> **This repo holds two codebases.**
> - **`web/` — Minerva v2.** The multi-user Next.js application that powers the hosted instance. This is where active development happens.
> - **Repo root (`index.html`, `assets/`, `sw.js`, …) — Minerva v1.** The original zero-backend static SPA: a single-page app backed entirely by a Google Sheet you own, no server, no database. It still works and is still self-hostable on any static host, but v2 is what's deployed and maintained. v1 is kept for reference and for anyone who wants the pure no-backend version.
>
> The rest of this README describes **v2** (what's live). For v1, see the git history of this file or the `assets/` directory.

---

## What it is

Minerva is a planner whose structure you control. Every "section" (Tasks, Notes, a paper library, a reading list, anything) is defined by a schema — a set of typed columns — so adding a new kind of thing to track is a configuration change, not a code change. The same engine renders a to-do list, a habit heatmap, a Kanban board, a citation graph, and a multi-page sketch, because they're all just sections with different schemas and views.

v2 is **multi-user**: you sign in with Google, your data lives in a per-user partition of the app's database, and files you create (sketches, uploaded papers, exported PDFs) go to *your* Google Drive under the minimal `drive.file` scope.

---

## v2 — what's live

### Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router — RSC + route handlers) |
| Language | TypeScript, React 19 |
| UI | Tailwind CSS v4 + Radix primitives + Lucide icons |
| Auth | Auth.js (NextAuth v5) — Google OAuth, `drive.file` scope |
| Database | Postgres via Drizzle ORM, per-user row partitioning |
| Live updates | Server-Sent Events on every mutation |
| Helper service | `minerva-services` (Python) — yt-dlp + PDF text extraction |
| Deploy | Docker Compose on a DigitalOcean droplet; GitHub Actions build → Docker Hub → SSH deploy |

### Core planner

- **Schema-driven sections + presets** — Tasks, Projects, Notes, Habits, YouTube, Papers, Bookmarks, Inbox out of the box; define your own with typed columns (text, number, date, select, multiselect, check, link, ref, rating, progress, color, markdown, drawing, …).
- **Views** — list, grid, grouped grid, Kanban, tree (for self-referential `ref` columns), and a cross-section graph view.
- **Editing** — click-to-edit cells with type-aware editors, add/delete rows, bulk operations, per-section live filter, saved views, global search (`⌘/Ctrl+K`).
- **Home dashboard** — aggregate stats, per-section cards, charts; a Today view; per-section calendars; a habit contribution heatmap.
- **Live sync** — mutations push over SSE, so changes appear without a refresh.

### Research workflow

- **Smart import** — paste an arXiv id/URL, a DOI, or a YouTube URL and Minerva fetches the metadata; drop a PDF to extract its arXiv id / DOI and backfill rich CrossRef metadata.
- **Papers** — a PDF preview and an iPad-style reader with a bound notes pane, page-resume, and annotation tools; papers can be mirrored into your Drive and organised into per-category folders.
- **Related-papers explorer** — for any paper, a bibliographic-coupling **graph** and a citation-flow **Sankey** diagram over the recommended set.
- **Reading-time estimates** and **BibTeX export** (per row and bulk).

### Sketching

- **Vector sketch editor** — multi-page canvas; pen / pencil / marker / highlighter / line / rectangle / ellipse / arrow / lasso / eraser (pixel + whole-object modes); pan + pinch-zoom; paper sizes, background patterns, and a light/dark drawing surface; handwriting smoothing; a **Pencil-only** mode that ignores stray finger/palm input; and an **iPad text tool** whose editing overlay is a real `<textarea>`, so Apple Pencil Scribble converts handwriting to text on-device. Drawings persist as a vector document and export to PDF / SVG.

### YouTube tracker

- Tiles view, multi-value categories, channel/playlist URL import, watched-progress bars, fullscreen + resume.
- **Offline downloads** — the hosted droplet's datacenter IP is bot-walled by YouTube, so downloads run through a small **local worker** you run on a machine you control (residential IP); it polls the app for queued jobs, runs yt-dlp, and uploads the result to your Drive.

### Sharing & integrations

- Public share links + QR codes, an iCal calendar feed and an RSS feed (both published to your Drive), a Telegram bot for reminders, chained "when2meet" availability polls, and a BYO-key AI assistant.

### Look & feel

- Themes (`light · dark · sepia · vt323`), multiple fonts, a Pomodoro timer, extensive keyboard shortcuts, and PWA install with offline reads.

---

## Architecture

The browser talks to a Next.js App Router backend — React Server Components for reads, route handlers (`web/src/app/api/**`) for mutations, every query scoped to the signed-in user. Persistent state lives in **Postgres** (Drizzle ORM); each row carries a JSONB `data` blob so the schema-driven model doesn't need a migration per column. File-shaped artefacts — sketches, uploaded papers, generated PDFs, the iCal/RSS feeds — go to the user's **Google Drive** under `drive.file`.

A companion **`minerva-services`** container (Python) handles the things Node shouldn't: yt-dlp invocations and PDF text extraction. The whole stack — `minerva-web`, `minerva-services`, Postgres, and a PO-token sidecar — runs from one Docker Compose file on a DigitalOcean droplet. GitHub Actions builds the web image, publishes it to Docker Hub, and SSH-deploys to the droplet on every push to `main`.

---

## Run it

**Hosted:** just visit <https://minerva.thefarshad.com> and sign in with Google.

**Self-host v2:** the full setup — environment variables, the Google OAuth client, the Drizzle schema push, and the Docker Compose stack — is documented in [`web/README.md`](web/README.md) and [`docs/`](docs/). In short, it's a `docker compose up` of `docs/docker-compose.yml` (web + Postgres + helper) plus your own OAuth credentials.

**Develop:**

```sh
cd web
cp .env.example .env.local   # fill in DATABASE_URL, AUTH_SECRET, GOOGLE_OAUTH_*
npx drizzle-kit push
npm run dev                  # http://localhost:3000
```

---

## Legacy: Minerva v1 (static SPA)

The repo root still contains the original Minerva — a single static page (`index.html` + `assets/*.js`) with **no backend at all**: it reads and writes a Google Sheet you own, keeps a local IndexedDB mirror, and runs on plain GitHub Pages. It has its own feature set (public sharing, iCal, a Telegram bridge, a touch sketch editor) and remains fully usable. If you want the zero-infrastructure version — fork the repo, enable Pages, bring your own Google OAuth client — v1 is still there. v2 supersedes it for the hosted instance; a `web/src/app/api/migrate/v1` route exists to import a v1 user's Sheets data into v2.

---

## Privacy

- **Minimal OAuth scope** — `drive.file` (only files this app created) + `userinfo.email` + `openid`. All non-sensitive.
- **No third-party telemetry** — no analytics or error reporters.
- **v2 has a backend** — unlike v1, v2 stores your rows in the app's own Postgres database (per-user partitioned). File artefacts still live in *your* Google Drive.
- **Public sharing is opt-in** — share links and the iCal/RSS feeds are only reachable if you hand out their URLs.

Full policy: [`privacy.html`](privacy.html).

---

## License

GNU General Public License v3.0 — see [`LICENSE`](LICENSE). Forks and derivative works (self-hosted or redistributed) must remain GPL-3 and source-available.
