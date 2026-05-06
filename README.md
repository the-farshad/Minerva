# Minerva

A lightweight personal planner. Goals, tasks, projects, notes, habits — backed by a Google Sheet **you** own. The app is a static site; there are no servers, no databases, no accounts. Public sharing with QR codes, a calendar feed, and a Telegram bot are built in.

**Live (hosted instance):** <https://minerva.thefarshad.com>

**Self-host your own copy:** Minerva is published under the GNU GPL v3, has no backend, and runs on plain GitHub Pages — fork it, push it to your own repo, enable Pages, point a domain at it, and you've got an independent Minerva at *your* URL. Full walkthrough in [Run your own copy](#run-your-own-copy) below. Either way, your data always lives in your own Google account; the hosted instance and a self-hosted copy are functionally identical.

---

## What works today

### Data
- **Connect Google** — sign in with your own OAuth client; Minerva auto-creates (or finds) a `Minerva` spreadsheet in your Drive and seeds it with the meta tabs (`_config`, `_prefs`, `_log`) and the section tabs (`goals`, `tasks`, `projects`, `notes`, `habits`, `habit_log`), each with a header row + a type-hint row that defines how the app renders it.
- **Local IndexedDB mirror** — every connect pulls the spreadsheet into a private store in your browser. Settings shows per-tab row counts and last-sync time; **Sync now** does a manual push-then-pull.
- **Optional Postgres mirror** — when `minerva-services` is reachable (Docker compose ships PG + the helper container together), every successful Sheets push is also written to a local Postgres database. Sheets stays the source of truth; PG is the read-fast cache and the source for a Drive-backed `pg_dump` you can roll on demand. Settings → *Postgres mirror* shows the live status pill and a **Backup to Drive now** button.
- **Click-to-edit anywhere** — every cell becomes an inline editor on click. Type-aware editors for text, number, date, datetime, check, dropdown (`select`), URL, color, multi-select chips (`multiselect`), star rating (`rating`), progress slider (`progress`), and ref/ref-multi pickers populated from the referenced tab. Long-form fields get a textarea; markdown columns render as actual markdown.
- **Add / delete rows** — `+ Add row` button per section, `×` per row. Edits write to local first (instant UI), then a coalescing dirty-queue pushes them back to your spreadsheet. Pulling preserves any pending local edits.

### Views
- **Schema-driven nav** — sections come from the `_config` tab; adding a section is a row in the spreadsheet plus a tab, no code change. The home page shows aggregate stats (tasks done, due today, overdue, average goal progress, active projects, notes) above per-section cards.
- **Per-section calendar** — sections with a date or datetime column get a List / Calendar toggle and a month grid view that highlights today and renders done items struck-through.
- **Habit heatmap** — the habits section shows each habit as a card with current streak, a Done-today button, and a 12-week contribution-graph heatmap.
- **Per-section live filter** — typed search box in the section header filters rows live in either list or calendar mode.
- **Global search** — `⌘/Ctrl+K` opens a fuzzy search across every row in every section.
- **Quick capture** — `/` opens a modal that captures a title + body to your inbox/notes section, mapped onto the most natural columns even on user-defined sections. Optional 🎤 voice capture via Web Speech API.
- **Bookmarklet** — drag *Capture to Minerva* from Settings to your browser's bookmarks bar; clicking it on any web page opens quick-capture pre-filled with the page's title, URL, and any selected text.
- **Tree view** for sections with a self-referential `ref` column (e.g. `goals.parent`) — collapsible nested layout with `+` to add subtasks in place.
- **Graph view** at `#/graph` (and a `List | Tree | Graph` toggle on any section with a `ref` column). Cross-tab edges from every `ref` column; cycle-tolerant; chip filter by tab; **Layered | Force** layout toggle (force layout lazy-loads `d3-force` from a CDN). The row-detail modal includes a *Show in graph* link for any row whose section participates in graph edges.
- **Charts on home** — donut for goal progress, sparkline for tasks-done, status mini-bar, 7-day habit heatmap strip. Per-section: tasks sparkline (last 14 days), goals histogram, projects Gantt. All hand-rolled SVG, theme-safe.
- **Touch-canvas sketch editor** — new **Sketches** preset adds a `drawing` type-hint column. Editor opens at `#/draw/<tab>/<rowId>?col=<col>`; Pointer Events with Apple-Pencil / S-Pen pressure where supported. Drawings save as SVG to a per-row blob in your Drive; export per-row to **PDF**, **Markdown** (self-contained, base64 PNG), or **LaTeX** (`.tex` + `.png`).
- **Today** view at `#/today`: due/overdue tasks with one-click ✓, habits not done today, recent notes — your daily landing page.
- **Saved views** per section: capture sort + filter combos as named pills; click to recall.
- **Bulk operations** — checkbox column + select-all; *Mark done* / *Delete* / *Copy BibTeX* / *Clear* in the bulk action bar.
- **Click-to-sort** column headers, **j/k row navigation**, **double-click row** for full-detail modal, **`d`** opens detail of selected row.

### Research workflow
- **Smart URL import** — *+ Import → From URL* per section auto-fetches metadata from arXiv (paste an id or URL), DOI (paste a DOI or doi.org URL → CrossRef metadata), and YouTube (oEmbed). Generic URLs added URL-only.
- **CSV/TSV paste import** — *+ Import → Paste CSV/TSV* with auto-detected delimiter and live preview.
- **Library** preset — unified papers · articles · books · videos · podcasts with `kind`, `title`, `authors`, `year`, `venue`, `url`, `pdf`, `abstract`, `tags`, `read`, `rating`, `notes` columns.
- **Proposals** preset — `funder`, `deadline`, `status`, plus the structured markdown sections (abstract, aims, methods, broader_impacts, timeline, budget, notes) reviewers expect.
- **Funder-by-funder rules**: [`docs/proposal-guide.md`](docs/proposal-guide.md) covers NSF, NIH, ERC, DOE — page limits, what each section must contain, common reasons proposals get returned without review, and a 48-hour pre-submission checklist.
- **AI assistant prompts** for proposal work — *NSF / NIH / ERC structure*, *critique my abstract*, *broader impacts brainstorm*.
- **Inline PDF and YouTube preview** — link cells get a 👁 button when the URL is a PDF or YouTube video; click opens an embedded viewer modal. Papers mirrored to Drive open the original PDF (browser-native viewer, page-resume via `#page=N`); a side **Notes** pane binds to the row's `notes` column with a "+ p.{N}" stamp helper, and an **Extract** button shells out to `opendataloader-pdf` (via `minerva-services`) so you can append the parsed text into the same notes column.
- **BibTeX export** per row (in the row-detail modal) and bulk-from-selection (in the bulk action bar).
- **KaTeX** rendering for `latex` columns.

### Sharing & integrations
- **Public share + QR** — build a note / question / poll; get a stable URL and a crisp SVG QR code (downloadable as a 16× PNG). No login required; the data lives in the URL hash.
- **Calendar feed (iCal)** — publishes your tasks as a public `.ics` file in your own Drive, subscribable from Apple Calendar, Google Calendar, Outlook — anywhere. Click *Update feed* in Settings to refresh.
- **RSS feed** of completed-this-week tasks — separate page at [`/rss.html`](rss.html) generates the feed in Drive.
- **OpenSearch** — register Minerva search in your browser's address bar (`m <query>`).
- **Telegram bot** — paste a bot token (BotFather, ~3 min) and a chat ID. Minerva pings your chat once per due/overdue task per day. Setup: [`docs/setup-telegram.md`](docs/setup-telegram.md). For an optional **always-on** bridge (reminders fire even with no Minerva tab open; inbound bot messages become note rows automatically), there's a [drop-in Apps Script template](docs/setup-telegram-always-on.md).
- **Browser desktop notifications** — alongside (or instead of) Telegram, the same reminder ticker fires native desktop notifications.
- **AI assistant** (`⌘/Ctrl+J`) — BYO Anthropic / OpenAI / Ollama / BYO endpoint. Built-in prompts: summarize my week, suggest a next action, decompose a goal, find duplicates, cluster my notes, and the four proposal prompts.

### Look & feel
- **5 themes** — `auto · light · dark · sepia · vt323-yellow` (homage to [thefarshad.com](https://thefarshad.com)).
- **7 fonts** — `system · Inter · Roboto · Ubuntu · Vazirmatn · Atkinson Hyperlegible · VT323`. Picker buttons render `Aa` in their own face for quick scan.
- **Custom theme** — Settings → Custom theme: paste raw CSS variable overrides; live-applied and persisted.
- **Per-section accent color** — set `_config.color` to a hex/rgb/hsl value; the section view tints accordingly.
- **Resume state** — last view, scroll position, view modes (list/calendar/tree) per section all persist in `localStorage` so reload picks up exactly where you left off.
- **Push indicator** — subtle bottom-right pill while a sync is in flight, flips red on error with a *Retry* button. Bottom-left red pill when offline.
- **Pomodoro timer** — floating bottom-left widget (`⌘/Ctrl+⇧+P` to toggle). 25-min focus / 5-min break, optional logging to a `pomodoros` tab.
- **Keyboard shortcuts** — `g` / `t` / `q` / `s` for nav, `1`–`9` for sections, `n` focuses the home quick-add (jumping home if needed), `/` quick capture, `⌘/Ctrl+K` global search, `⌘/Ctrl+J` AI assistant, `⌘/Ctrl+Z` undo, `⌘/Ctrl+⇧+P` pomodoro, `j/k/e/c/x/d` for row navigation, `?` cheatsheet.

### Offline / install
- **PWA** — installable from your browser's *Install* / *Add to Home Screen*, with a service worker that caches the static shell. Read your data offline; edits queue and flush automatically when you reconnect.
- **Undo** — `⌘/Ctrl+Z` reverses the last edit / add / delete (50-deep stack in `localStorage`).
- **Per-row offline video** — a Download button on every YouTube row. Wire it to a tiny local **helper service** (see [`docs/setup-local-services.md`](docs/setup-local-services.md)) — one Python script (or one Docker container) that runs yt-dlp downloads + a CORS proxy from the same process — for one-click downloads with a progress bar, or to a [Cobalt](https://github.com/imputnet/cobalt) instance, or upload a file you already have. Saved videos live in IndexedDB; the row gets a **Watch offline** button that plays the local copy with resume-where-you-left-off.
   - Prebuilt image on Docker Hub: `docker run -d --name minerva-services --restart unless-stopped -p 8765:8765 thefarshad/minerva-services:latest`. The image now bundles the SPA itself, so `http://localhost:8765/` is the whole app — no GitHub Pages or local http.server needed. The helper status page moved to `http://localhost:8765/helper`.
   - Full stack (helper + Postgres) with no checkout: `curl -O https://raw.githubusercontent.com/the-farshad/Minerva/main/docs/docker-compose.yml && docker compose up -d`.
   - **One-script setup** (no checkout needed): `curl -O https://raw.githubusercontent.com/the-farshad/Minerva/main/docs/minerva-services.py && python3 minerva-services.py up`. The script writes `docker-compose.yml` next to itself if missing, refreshes cookies from your live browser, drops a `docker-compose.override.yml` for the cookies bind mount, installs a systemd-user timer for hourly refresh, runs `docker compose pull`, reaps any orphan containers, and `docker compose up -d`. Subcommands: `up · down · logs · status · refresh-cookies · install-timer`. `python3 minerva-services.py up chrome` picks a different browser. After the first run, plain `docker compose up -d` keeps working.

### YouTube tracker
- **Tiles view** — visual card grid grouped by playlist or category, with thumbnails. Toggle from the section header.
- **Categories** — multi-value `category` column (multi-select). The chip-bar above the table filters by one click; you can add new categories on the fly from the URL Import modal.
- **Channel + playlist URL import** — paste a `?list=…` URL or a `youtube.com/@handle` URL → Minerva enumerates every video (capped at 200/import) with the YouTube Data API key. Re-imports skip videos already in the section.
- **Resume + fullscreen** — preview modal has a fullscreen toggle (`F`); YouTube videos remember `currentTime` per URL and resume on reopen. Same for offline blob playback.

### Reading workflow
- **Notes reader (iPad-style)** — Notes opens in a sidebar + reading-pane layout by default: list of notes on the left, big editing pane on the right with the markdown body, an inline sketch placeholder (tap to draw), and tag chips. Auto-saves on blur. Toggle to **List** or **Tiles** mode any time.
- **Sketches inline in Notes** — the Notes preset gained a `sketch` (drawing) column. Click it from the table or tap the sketch placeholder in reader mode to open the canvas editor.
- **PDF preview with resume** — paper rows get a 👁 preview that uses the browser's native PDF viewer with `#page=N` resume. The page jumper in the preview head saves your last-read page per URL.
- **PDF metadata extraction** — drag a downloaded PDF onto the URL Import modal in Papers / Library. Minerva regex-scans the first 256 KB for an arXiv id or DOI, then auto-fetches title, authors, abstract, venue, volume, pages, publisher (rich CrossRef metadata for DOIs).
- **Papers preset, expanded** — schema now carries `title, authors, year, venue, volume, pages, doi, url, pdf, abstract, category, tags, read, notes`. Existing Papers sections auto-migrate.

### Misc
- **Build version pill** — bottom-right of home + top-right of Settings. Click to copy (handy for bug reports).
- **Downloads tray** — multiple concurrent downloads stack bottom-right with their own progress bars and a **Watch offline** CTA on success.
- **When-to-meet, chained** — group-availability poll where each shared link carries every prior response. Each person clicks **Add my availability**, marks their slots, and forwards the new link onward; no manual token-passing on the organizer's side.

---

## Use it

1. Visit <https://minerva.thefarshad.com>.
2. Click **Quick share** in the nav (or hit `q`).
3. Type a title and body, optionally add choices to make it a poll.
4. Copy the link, or download the QR as a 16× PNG (poster-quality).
5. Anyone with the link sees the rendered card.

**Keyboard shortcuts:** `g` home · `q` quick share · `s` settings · `1`–`9` open Nth section · `/` quick capture · `⌘/Ctrl+K` global search · `?` help cheatsheet · `Esc` close overlay / cancel edit · `Enter` save current edit.

---

## Phase 1 — bring your own Google OAuth client

You need an OAuth Client ID — there are no shared secrets in this repo on purpose. It takes ~5 minutes.

**👉 Detailed step-by-step walkthrough (with troubleshooting):** [`docs/setup-google-oauth.md`](docs/setup-google-oauth.md)

In short:

1. [Google Cloud Console](https://console.cloud.google.com/) → create a project (e.g. "Minerva").
2. **APIs & Services → Library** — enable **Google Sheets API** and **Google Drive API**.
3. **APIs & Services → OAuth consent screen** — User type: External; add the three non-sensitive scopes (`drive.file`, `userinfo.email`, `openid`); add your email as a Test user.
4. **APIs & Services → Credentials → Create OAuth client ID** — type: Web application; Authorized JavaScript origins: `https://minerva.thefarshad.com` (and `http://localhost:8000` for local dev).
5. Copy the Client ID (looks like `123…-abc.apps.googleusercontent.com`).
6. Open Minerva → **Settings** → paste → **Save** → **Connect Google**.

Your Client ID is stored only in your browser via `localStorage`. It's not a secret per se, but it's still yours — Minerva never asks for or transmits it anywhere except to Google's auth endpoints.

---

## Architecture in two paragraphs

Minerva is a **schema-driven planner over Google Sheets**. The app is a static site. Per user, there is one Google spreadsheet with one tab per section (`tasks`, `goals`, `notes`, `habits`, …). A reserved `_config` tab declares which sections exist, in what order, with which icons and default sort/filter — so adding a "Papers" or "Reading list" section is a row in `_config` plus a tab, not a code change. The column schema for each section is **inferred from the tab's header row + a type-hint row**, supporting types like `text`, `longtext`, `markdown`, `date`, `select(a,b,c)`, `check`, `link`, `ref(tab)`, `progress(0..100)`, `rating(0..5)`, `color`, `drawing`, and `multiselect(...)`.

The browser keeps a **local IndexedDB mirror** of the spreadsheet for instant rendering and offline reads. Edits write to the local store first (UI updates with no round trip), get marked `_dirty=1`, and a single-flight, coalescing push queue flushes them back to Sheets via the regular `values.update` / `values.append` / `batchUpdate.deleteDimension` endpoints. Pulling preserves any pending local edits — sync mid-typing never destroys work in progress. The whole thing runs under the minimal `drive.file` scope (Sheets API works for app-created files), which is non-sensitive and skips the unverified-app warning.

---

## Run your own copy

Minerva is fully open source and works equally well on your own infrastructure. There are no servers to provision, no databases to migrate, no API keys to rotate — it's just static files + your own Google account.

### Self-host on GitHub Pages (5 minutes)

1. **Fork** this repo to your GitHub account.
2. **Edit `CNAME`** to your domain (e.g. `planner.example.com`) — or delete the file to use the default `<you>.github.io/Minerva` URL.
3. **Enable Pages**: your fork → Settings → Pages → Source: Deploy from branch → Branch: `main` / `(root)` → Save.
4. **Point DNS** (only if using a custom domain): add a `CNAME` record from your subdomain to `<your-github-username>.github.io.`
5. **Create a Google OAuth client** for your domain — see [Phase 1 — bring your own Google OAuth client](#phase-1--bring-your-own-google-oauth-client) below. Authorize *your* origin (e.g. `https://planner.example.com`).
6. Visit your URL → Settings → paste your Client ID → Connect Google. Done.

You now run an independent Minerva. Pull from upstream when new features land, or don't — it's your fork.

### Self-host anywhere else

Any static-file host works: Netlify, Cloudflare Pages, Vercel, S3 + CloudFront, your own nginx. The whole app is the contents of this repo; serve it as-is. The only runtime dependency is the user's browser reaching `accounts.google.com`, `sheets.googleapis.com`, `www.googleapis.com`, and the QR-code CDN (`cdn.jsdelivr.net`) — same as on the hosted instance.

### Local development

```sh
git clone git@github.com:the-farshad/Minerva.git
cd Minerva
python3 -m http.server 8000
```

Open <http://localhost:8000>. Editing `index.html` or anything in `assets/` and refreshing is the entire dev loop — no build step. Add `http://localhost:8000` as an authorized JavaScript origin on your OAuth client to test the Connect flow locally.

### Layout

```
index.html             single-page shell
privacy.html           privacy policy (also linked from OAuth consent)
terms.html             terms of service (also linked from OAuth consent)
manifest.webmanifest   PWA manifest (installable, theme color, shortcuts)
sw.js                  service worker (stale-while-revalidate cache of shell)

assets/styles.css      themes + fonts + layout
assets/qr.js           SVG QR generator (wraps qrcode-generator from CDN)
assets/share.js        encode/decode public-share payloads + PNG export
assets/auth.js         Google Identity Services token-flow client
assets/sheets.js       thin Sheets API v4 + Drive API v3 wrapper
assets/db.js           local IndexedDB store + ULID generator
assets/bootstrap.js    find-or-create the user's Minerva spreadsheet
assets/sync.js         pull/push between local store and Sheets, dirty-queue
assets/render.js       schema parser + type-aware cell renderers
assets/charts.js       hand-rolled SVG chart primitives (donut, sparkline, gantt, ...)
assets/graph.js        cross-tab graph view (#/graph) — layered DAG + force layout
assets/draw.js         touch-canvas sketch editor + PDF / Markdown / LaTeX exports
assets/editors.js      type-aware inline editors (CRUD)
assets/telegram.js     Telegram Bot API wrapper (sendMessage, getUpdates, ...)
assets/ical.js         RFC-5545 .ics generator + Drive upsert + permission flip
assets/app.js          hash router, all views (home, section, share, settings, ...)

docs/setup-google-oauth.md   detailed OAuth client walkthrough + troubleshooting
docs/setup-telegram.md       Telegram bot setup + always-on bridge sketch
docs/setup-local-services.md combined setup guide for the local helper services
docs/minerva-services.py     self-bootstrapping Flask server: yt-dlp + CORS proxy on one port
docs/Dockerfile              container image for the helper services
docs/docker-compose.yml      docker compose wrapper for the same image
docs/assets/minerva-logo.png 512x512 PNG logo for the OAuth consent screen
docs/assets/minerva-logo.svg source SVG of the logo

CNAME                  custom domain for GitHub Pages
.nojekyll              tells Pages not to run Jekyll
```

---

## Privacy

- **No telemetry.** No analytics, no error reporters, no cookies set by Minerva.
- **No secrets in repo.** Ever. The OAuth client ID is BYO, kept in `localStorage` only.
- **No proxy.** API calls go directly from your browser to Google / Telegram.
- **OAuth scopes** are the minimal non-sensitive set: `drive.file` (only files this app created — *not* full-Drive read) + `userinfo.email` + `openid`. The Sheets API works for app-created files under `drive.file`, so the broader `spreadsheets` scope is unnecessary. As a bonus, all three scopes are non-sensitive, so the consent flow skips the "Google hasn't verified this app" yellow warning.
- **Public sharing is opt-in.** Quick-share embeds the data into the URL hash itself; nothing is uploaded. The iCal feed only contains task summaries; you control whether to share its URL.

Full policy: [`privacy.html`](privacy.html).

---

## License

GNU General Public License v3.0 — see [`LICENSE`](LICENSE). Copyleft: forks and derivative works (whether self-hosted or redistributed) must remain GPL-3 and source-available.
