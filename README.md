# Minerva

A lightweight personal planner. Goals, tasks, projects, notes, habits — backed by a Google Sheet **you** own. The app is a static site; there are no servers, no databases, no accounts. Public sharing with QR codes, a calendar feed, and a Telegram bot are built in.

**Live (hosted instance):** <https://minerva.thefarshad.com>

**Self-host your own copy:** Minerva is published under the GNU GPL v3, has no backend, and runs on plain GitHub Pages — fork it, push it to your own repo, enable Pages, point a domain at it, and you've got an independent Minerva at *your* URL. Full walkthrough in [Run your own copy](#run-your-own-copy) below. Either way, your data always lives in your own Google account; the hosted instance and a self-hosted copy are functionally identical.

---

## What works today

### Data
- **Connect Google** — sign in with your own OAuth client; Minerva auto-creates (or finds) a `Minerva` spreadsheet in your Drive and seeds it with the meta tabs (`_config`, `_prefs`, `_log`) and the section tabs (`goals`, `tasks`, `projects`, `notes`, `habits`, `habit_log`), each with a header row + a type-hint row that defines how the app renders it.
- **Local IndexedDB mirror** — every connect pulls the spreadsheet into a private store in your browser. Settings shows per-tab row counts and last-sync time; **Sync now** does a manual push-then-pull.
- **Click-to-edit anywhere** — every cell becomes an inline editor on click. Type-aware editors for text, number, date, datetime, check, dropdown (`select`), URL, color, multi-select chips (`multiselect`), star rating (`rating`), progress slider (`progress`), and ref/ref-multi pickers populated from the referenced tab. Long-form fields get a textarea; markdown columns render as actual markdown.
- **Add / delete rows** — `+ Add row` button per section, `×` per row. Edits write to local first (instant UI), then a coalescing dirty-queue pushes them back to your spreadsheet. Pulling preserves any pending local edits.

### Views
- **Schema-driven nav** — sections come from the `_config` tab; adding a section is a row in the spreadsheet plus a tab, no code change. The home page shows aggregate stats (tasks done, due today, overdue, average goal progress, active projects, notes) above per-section cards.
- **Per-section calendar** — sections with a date or datetime column get a List / Calendar toggle and a month grid view that highlights today and renders done items struck-through.
- **Habit heatmap** — the habits section shows each habit as a card with current streak, a Done-today button, and a 12-week contribution-graph heatmap.
- **Per-section live filter** — typed search box in the section header filters rows live in either list or calendar mode.
- **Global search** — `⌘/Ctrl+K` opens a fuzzy search across every row in every section.
- **Quick capture** — `/` opens a modal that captures a title + body to your inbox/notes section, mapped onto the most natural columns even on user-defined sections.

### Sharing & integrations
- **Public share + QR** — build a note / question / poll; get a stable URL and a crisp SVG QR code (downloadable as a 16× PNG). No login required; the data lives in the URL hash.
- **Calendar feed (iCal)** — publishes your tasks as a public `.ics` file in your own Drive, subscribable from Apple Calendar, Google Calendar, Outlook — anywhere. Click *Update feed* in Settings to refresh.
- **Telegram bot** — paste a bot token (BotFather, ~3 min) and a chat ID. Minerva pings your chat once per due/overdue task per day. Setup: [`docs/setup-telegram.md`](docs/setup-telegram.md).
- **Browser desktop notifications** — alongside (or instead of) Telegram, the same reminder ticker fires native desktop notifications.

### Look & feel
- **5 themes** — `auto · light · dark · sepia · vt323-yellow` (homage to [thefarshad.com](https://thefarshad.com)).
- **7 fonts** — `system · Inter · Roboto · Ubuntu · Vazirmatn · Atkinson Hyperlegible · VT323`. Picker buttons render `Aa` in their own face for quick scan.
- **Resume state** — last view, scroll position, view modes (list/calendar) per section all persist in `localStorage` so reload picks up exactly where you left off.
- **Push indicator** — subtle bottom-right pill while a sync is in flight; bottom-left red pill when offline.
- **Keyboard shortcuts** — `g` / `q` / `s` for nav, `1`–`9` for sections, `/` for quick capture, `⌘/Ctrl+K` for search, `?` for the help cheatsheet.

### Offline / install
- **PWA** — installable from your browser's *Install* / *Add to Home Screen*, with a service worker that caches the static shell. Read your data offline; edits queue and flush automatically when you reconnect.

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

Minerva is a **schema-driven planner over Google Sheets**. The app is a static site. Per user, there is one Google spreadsheet with one tab per section (`tasks`, `goals`, `notes`, `habits`, …). A reserved `_config` tab declares which sections exist, in what order, with which icons and default sort/filter — so adding a "Papers" or "Reading list" section is a row in `_config` plus a tab, not a code change. The column schema for each section is **inferred from the tab's header row + a type-hint row**, supporting types like `text`, `longtext`, `markdown`, `date`, `select(a,b,c)`, `check`, `link`, `ref(tab)`, `progress(0..100)`, `rating(0..5)`, `color`, and `multiselect(...)`.

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
assets/editors.js      type-aware inline editors (CRUD)
assets/telegram.js     Telegram Bot API wrapper (sendMessage, getUpdates, ...)
assets/ical.js         RFC-5545 .ics generator + Drive upsert + permission flip
assets/app.js          hash router, all views (home, section, share, settings, ...)

docs/setup-google-oauth.md   detailed OAuth client walkthrough + troubleshooting
docs/setup-telegram.md       Telegram bot setup + always-on bridge sketch
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
