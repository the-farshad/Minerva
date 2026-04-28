# Minerva — the long roadmap

> A perfectionist's plan for a planner. Everything below is the *aspirational* shape of Minerva. Not every slice ships; nothing here is a promise. Phases are ordered by dependency, not priority.

## 0. Vision in one breath

Minerva is a **schema-driven personal-planning surface over Google Sheets**. The user owns the data, the schema, and the routes. The app is a static site; there are no servers, no databases, no accounts. A row in your sheet can become a public card with a stable URL and a QR code in two clicks. A new section — "Habits", "Papers", "Books", "Therapy notes" — is one row in `_config` plus a tab. Every "fancy feature" Minerva ever ships is, underneath, just *another type column or another section preset*.

---

## 1. The architectural pillar — *everything is a sheet*

| Surface              | Where it lives                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| Data                 | One Google Sheet per user, one **tab per section** (`tasks`, `goals`, `notes`, `habits`, …)          |
| Routes / nav         | `_config` tab: rows declare `slug`, `title`, `icon`, `tab`, `defaultSort`, `defaultFilter`, `order`, `enabled` |
| Column schema        | Header row (row 1) + **type-hint row** (row 2) of each section tab                                   |
| Dashboards           | `_dashboards` tab: rows declare a widget (`type`, `source`, `params`)                                |
| Public-share index   | Anything with `public:true` is exposed at `#/p/<token>`                                              |
| AI prompts           | `_assistant` tab: rows are reusable prompt templates with placeholders `{section}`, `{row.field}`    |
| App preferences      | `_prefs` tab: theme, locale, week-start-day, default editors                                         |
| Activity log         | `_log` tab: append-only row history (CRUD events) for trend analytics                                |
| Plugin contracts     | `_plugins` tab: registered plugin URLs + the column types they own                                   |

**Consequence:** Minerva's entire UI surface is a function of the sheet's contents. A user who reorders rows in `_config` reorders their nav. A user who adds a `priority` column with `select(low,med,high)` in row 2 gets a dropdown editor and a "group by priority" view, with no app change. Forking Minerva to make "Minerva for Therapists" or "Minerva for PhD Students" is a templated `_config` + a few seed tabs.

### 1a. The schema language (cheat sheet)

Type hints written in row 2 of any data tab:

| Type                | Editor                              | Use                                               |
| ------------------- | ----------------------------------- | ------------------------------------------------- |
| `text`              | single-line input                   | titles, names                                     |
| `longtext`          | textarea, optional markdown render  | notes, descriptions                               |
| `number`            | numeric input                       | counts, scores                                    |
| `date`              | date picker                         | due dates, deadlines                              |
| `datetime`          | date + time picker                  | meetings, timestamps                              |
| `duration`          | smart input ("90m", "1h 30m")       | time tracking, pomodoro                           |
| `check`             | checkbox                            | done/not-done                                     |
| `select(a,b,c)`     | dropdown                            | priority, kind                                    |
| `multiselect(a,b)`  | tag picker                          | tags, contexts                                    |
| `link`              | URL input + favicon preview         | references, source links                          |
| `email` / `tel`     | typed input                         | contacts                                          |
| `ref(tab)`          | row picker into another tab         | parent-child, project assignment, backlinks       |
| `ref(tab, multi)`   | multi-row picker                    | reading-list members, backlinks                   |
| `drive`             | Google Drive picker                 | papers, slide decks, photos                       |
| `image`             | URL or Drive thumbnail              | covers, mood boards                               |
| `progress(0..100)`  | slider + bar render                 | goal progress                                     |
| `rating(0..5)`      | star input                          | book/paper/idea quality                           |
| `color`             | color swatch                        | row tinting                                       |
| `markdown`          | live-preview textarea               | rich notes, research logs                         |
| `latex`             | KaTeX-rendered                      | equations in research notes                       |
| `code(lang)`        | mono editor + syntax highlight      | snippets                                          |
| `geo`               | lat/long + tiny map                 | travel, fieldwork                                 |
| `json`              | raw JSON editor                     | escape hatch                                      |
| `formula`           | derived from other columns          | computed fields (read-only)                       |
| `public`            | boolean + auto-generated share URL  | the *publish* toggle                              |

Two reserved meta-columns:
- `id` — stable row id; auto-filled with a ULID on create.
- `_updated` — RFC3339 timestamp; auto-bumped on every write.

---

## 2. The phase ladder

> Each phase is a deployable slice. The user can stop at any phase and still have a working app.

### **Phase 0** — Static skeleton + public share + QR + theme/font picker ✦ *no auth required*

- Hash router (`#/`, `#/settings`, `#/share`, `#/p/<token>`).
- Settings stored in `localStorage` (BYO OAuth client ID + spreadsheet ID).
- Quick-share form: build a `note` / `question` / `poll` card, get URL + QR.
- Public viewer at `#/p/<token>` decodes the URL hash and renders the card. No backend.
- Download QR as crisp PNG (16× scaled SVG).
- **Segmented theme picker** (5 themes — see §7). Persists in `localStorage`; applied via `<html data-theme>`. Inline pre-paint script avoids the dark-flash on light theme (and vice versa).
- **Segmented font picker** (7 fonts — see §7). Persists in `localStorage`; applied via `<html data-font>`. Each picker button shows `Aa` rendered in its own font, like `blog`/`tools`.
- Mobile-friendly. Keyboard shortcuts (`g` home, `s` settings, `q` quick-share, `?` cheatsheet).
- README + CNAME + `.nojekyll`.

### **Phase 1** — Google Sign-In + auto-bootstrap the spreadsheet

- Google Identity Services token client; scopes: `spreadsheets`, `drive.file`.
- On first connect: create the user's `Minerva` spreadsheet, seed `_config`, `_prefs`, `_log`, and the four core tabs (`goals`, `tasks`, `projects`, `notes`) with headers + type-hint rows.
- Reconnect flow when token expires (silent re-auth).
- Add `Connected as <email>` to header. Disconnect button.

### **Phase 2** — Schema engine + dynamic routes

- Read `_config` → build the nav and the per-section routes.
- For each section tab, read row 1 + row 2 → build a typed column schema.
- Generic list view: renders any section's rows with the right cell renderers.
- Empty-state per section ("No tasks yet — add one").

### **Phase 3** — CRUD with typed editors

- Inline create / edit / delete with optimistic UI.
- Editors per type (Section 1a above).
- Default `id` + `_updated` handling.
- Undo (in-memory, last action).
- Bulk select + bulk action (mark done, delete, change select).

### **Phase 4** — Resume state + UX polish

- Last open view, scroll position, filter & sort, in `localStorage`.
- Onboarding flow (animated tour the first time).
- Keyboard shortcuts (`?` opens cheat-sheet).
- Mobile bottom-nav.
- Accessibility audit pass (focus rings, labels, ARIA).

### **Phase 5** — Drive linking

- `drive` and `image` column types use the Google Picker API.
- Thumbnails in list view, full-size lightbox on click.
- "Backup my spreadsheet now" button → exports as `.xlsx` to Drive.

### **Phase 6** — Basic dashboards

- `_dashboards` tab format: each row is a widget (`stat`, `progress`, `bar`, `list`, `streak`).
- Dashboard route `#/d/<slug>` renders the widgets.
- Default "Home" dashboard shipped on bootstrap.

### **Phase 7** — Public sharing, second wave

- Per-row publish toggle backed by a `public` column (boolean) + a `slug` column (text).
- Permanent public URLs that *don't* encode data in the hash but read it from the user's published-public sheet (CSV export of a sheet flagged "publish-to-web").
- Public dashboards: pin a dashboard to a public URL; e.g. `minerva.thefarshad.com/p/<user>/<slug>`.
- Open Graph + Twitter card auto-generation for shared cards.
- QR with branded center logo for posters.

### **Phase 8** — Polls & questions, real polling

- New section presets: `polls` and `questions`.
- Hash-encoded polls (Phase 0 style) for ephemeral one-offs.
- Sheets-backed polls: each public poll has a sibling `<slug>_responses` tab; responses are submitted via a tiny Google Form (auto-created), and Minerva reads the responses tab to render live tallies.
- Result charts: bar, donut, ranked-choice, time-series.

### **Phase 9** — Calendar + timeline

- Calendar view (month/week) for any tab with a `date` or `datetime` column.
- Drag-to-reschedule (writes back to the sheet).
- Timeline / Gantt view for tabs with `start` + `end` (+ optional `depends:ref(tab)`).

### **Phase 10** — Habit tracking & streaks

- New section preset: `habits` with type-hint columns `name:text, cadence:select(daily,weekly), days:multiselect(...), streak:formula`.
- Heatmap view (GitHub-style) for any boolean column over time.
- Streak widget for the dashboard.

### **Phase 11** — Research & academic preset

- `papers` (with `link`, `pdf:drive`, `bibtex:longtext`, `read:check`, `notes:markdown`).
- `references` graph view: `ref(papers, multi)` columns become arrows in a force-directed graph.
- Reading-list import via DOI/arXiv (fetches OpenGraph + arXiv API).
- LaTeX rendering for `latex` / `markdown` columns (KaTeX).
- Writing-progress section: word-count over time per project.
- Thesis/grant export to LaTeX or pandoc-friendly markdown.

### **Phase 12** — AI assistant layer

- `_assistant` tab declares prompts.
- Provider config in `_prefs`: `none` / `ollama` (local URL) / `anthropic` (BYO key in localStorage) / `byo` (raw URL + headers).
- Hot-keys: `⌘K` opens the assistant on the current row.
- Built-in prompts: *summarize this week*, *break this goal into steps*, *suggest a next action*, *find duplicates*, *cluster these notes*, *generate a weekly review*.
- Response streaming if provider supports SSE.
- All assistant interactions logged to `_log` for audit.

### **Phase 13** — Notifications, reminders, recurring

- `notify_at:datetime` column triggers a client-side notification on visit (and via `Notification.requestPermission()` if granted).
- Recurring tasks via a `recurrence:text` column using RFC 5545 RRULE.
- iCal feed at `/cal/<token>.ics` (token = a per-user feed key) — generated client-side and published to Drive as a public link, or served from a Google Apps Script the user installs from the README.

### **Phase 14** — Offline-first

- Service worker caches the static site shell.
- Local read cache of recent rows; writes queued and replayed on reconnect.
- "Last synced" indicator. Conflict resolution: last-write-wins on `_updated`, with a toast that lets the user see the overwritten value.

### **Phase 15** — Advanced theming

- Built-in five themes already shipped in Phase 0 (see §7). This phase adds the *advanced* layer:
- Per-section accent — `_config.color` tints the section's nav pill, headings, and progress bars.
- Custom themes via `_prefs.theme_css` — a raw CSS-variables block the user can edit; live-applied.
- Plugin themes — themes published as URLs in `_plugins`, one click to install.
- Print stylesheet refined per view kind (list, card, calendar, dashboard) so any section prints cleanly.

### **Phase 16** — Plugin & extension architecture

- A plugin is a single ES module URL listed in the `_plugins` tab.
- Plugins register: new column types, new view kinds, new dashboard widgets, new assistant prompts.
- Sandbox: plugins run in a same-origin frame with a postMessage RPC to a tightly scoped Minerva API.
- Curated registry seeded with: `pomodoro`, `voice-capture`, `arxiv-importer`, `goodreads-importer`, `last-fm-listens`, `weather-context`.

### **Phase 17** — Adjacent surfaces

- iCal feed (Phase 13).
- RSS feed of completed-this-week (à la `blog.thefarshad.com/feed.xml`).
- OpenSearch descriptor so the address bar accepts `m <query>`.
- Bookmarklet for "quick-capture from any page" (pre-fills `notes` with title + URL).
- Email-in: optional Apps Script the user installs that appends forwarded emails to the `inbox` tab.
- Daily public snapshot (à la `game_of_life`): an opt-in cron via Apps Script writes a "today" snapshot to a public Drive HTML, suitable for `https://minerva.thefarshad.com/today/<user>`.

### **Phase 18** — Long-tail polish

- Search across all sheets (client-side index, Lunr.js).
- Saved views as permalinks (`#/v/<slug>` reads filter/sort from `_views` tab).
- Backlink generation: any `ref(tab)` column auto-creates a "Linked from" panel on the target row.
- Tag pages: `#/t/<tag>` lists every row across all sections that has that tag.
- Quick-capture overlay (`/` to open from anywhere).
- Voice capture (Web Speech API) → transcribed into the `inbox` tab.
- Image OCR (Tesseract.js) for whiteboard photos → captured as `notes`.
- Goal trees rendered as a collapsible tree from `parent:ref(goals)`.
- Mood / energy tracker with weekly trend.
- Books, films, music with embed previews.
- Spaced repetition flashcards (`flashcards` tab, SM-2 algorithm).

### **Phase 19** — Federation & sharing between people

- "Share this section read-only with a teammate" → publishes a CSV view + a Minerva-rendered URL.
- "Public roadmap" preset: a goals tab with a permanent public URL.
- "Comments" via a sibling tab; teammates with the link can append rows via a Google Form.

### **Phase 20** — Native wrappers (optional)

- Capacitor or Tauri shell for iOS/Android/desktop. Identical web app inside, but with notifications, share-target intents, and shortcuts.

---

## 3. Section presets gallery

These ship as one-click "Add preset" buttons in Phase 2+. Each is a row in `_config` + a tab with header + type-hint rows.

| Preset            | What it gives you                                                            |
| ----------------- | ---------------------------------------------------------------------------- |
| Goals             | `name`, `progress(0..100)`, `due:date`, `parent:ref(goals)`, `notes:markdown`|
| Tasks             | `title`, `status:select(todo,doing,done)`, `priority:select(low,med,high)`, `due:date`, `project:ref(projects)`, `tags:multiselect(...)` |
| Projects          | `name`, `status`, `start:date`, `end:date`, `goal:ref(goals)`, `description:markdown` |
| Notes / inbox     | `title`, `body:markdown`, `tags`, `created:datetime`                          |
| Habits            | `name`, `cadence:select(daily,weekly)`, `days:multiselect(M,T,W,...)`, `streak:formula` |
| Polls             | `question`, `choices:longtext`, `public:check`, `closes:datetime`             |
| Questions         | `question`, `answer:markdown`, `asked:datetime`, `kind:select(open,answered)` |
| Reading list      | `title`, `url:link`, `kind:select(article,paper,book)`, `read:check`, `rating:rating(0..5)` |
| Papers            | `title`, `authors`, `year:number`, `pdf:drive`, `bibtex:longtext`, `notes:markdown`, `tags` |
| Decisions log     | `decision`, `context:markdown`, `made:date`, `revisit:date`, `outcome:longtext` |
| Daily journal     | `date`, `entry:markdown`, `mood:rating(0..5)`, `energy:rating(0..5)`         |
| Weekly review     | `week`, `wins:longtext`, `friction:longtext`, `next:longtext`                |
| Books             | `title`, `author`, `started:date`, `finished:date`, `rating`, `notes:markdown`|
| Films             | `title`, `watched:date`, `rating`, `notes`                                   |
| Workouts          | `date`, `kind:select(strength,cardio,...)`, `duration`, `notes`              |
| Travel            | `where`, `start:date`, `end:date`, `geo`, `photos:drive`                     |
| Therapy notes     | `date`, `mood`, `topic`, `notes:markdown` (private; never publishable)       |
| Job applications  | `company`, `role`, `applied:date`, `status:select(...)`, `link`, `contacts:ref(contacts,multi)` |
| Contacts          | `name`, `email`, `notes:markdown`, `tags`                                    |
| Recipes           | `title`, `tags`, `ingredients:longtext`, `steps:markdown`                    |

---

## 4. Public sharing & social surfaces

Three layers of "public," each progressively more powerful:

| Layer | Mechanism                                                | Trade-off                                           |
| ----- | -------------------------------------------------------- | --------------------------------------------------- |
| 1     | **URL-hash payload** (Phase 0)                           | Free, offline, anyone can edit by re-encoding. Caps at ~2KB. Ephemeral. |
| 2     | **Per-row publish via published Sheet CSV** (Phase 7)    | Stable URL like `/u/<slug>/<row-id>`. Lives until user retracts.        |
| 3     | **Per-dashboard publish** (Phase 7)                      | Whole dashboard at `/u/<slug>/<dash>`. Updates in near-real-time.       |

QR codes are generated client-side as crisp SVG, downloadable as 16× PNG (poster-quality). Optionally branded with a center logo. Three sizes preset: thumbnail (132px), card (220px), poster (full-width vector).

**Where QR codes show up:**
- Quick-share view (Phase 0).
- Per-row "Share" button (Phase 7).
- Per-dashboard "Share" button (Phase 7).
- Polls and questions sections (Phase 8) — QR embedded in the live tally view so audiences can scan to vote.
- Print stylesheet — every printable section adds a QR to its own URL in the corner.

---

## 5. AI assistant layer (Phase 12)

One panel, one keystroke (`⌘K`), three providers, *user-supplied keys/endpoints only* (no Minerva-hosted AI, ever). Built-in prompts:

- **Decompose** — break a goal/task into sub-tasks; ref-children created on accept.
- **Summarize week** — read `_log` + completed tasks; emit a markdown digest.
- **Cluster inbox** — read recent `notes`; suggest groupings.
- **Find duplicates** — semantic dedupe across a tab.
- **Suggest next** — given current state + free time, pick a next action.
- **Polish prose** — improve grammar/clarity on a `longtext` field.
- **Tag automatically** — propose tags for an untagged row.
- **Generate weekly review** — fill out the `weekly_review` row from raw data.

Custom prompts are user rows in `_assistant`, with placeholders like `{section}`, `{row.title}`, `{row.notes}`, `{recent}`. Saved prompts appear as one-click buttons in the assistant panel.

---

## 6. Adjacent surfaces

- **iCal feed** (Phase 13) — token-gated `.ics` of due `task`/`goal`/`event` rows; subscribable in Apple/Google Calendar.
- **RSS feed** — completed-this-week, journal entries marked public, blog-style auto-generated digests.
- **OpenSearch** — `<link rel="search">` so browsers register `m <query>` to search across Minerva.
- **Bookmarklet** — `javascript:` snippet that opens Minerva pre-filled with the current page's title + URL.
- **Email-in** — Apps Script the user installs in their account that appends starred / forwarded emails to `inbox`.
- **Daily snapshot** — opt-in Apps Script cron (à la `game_of_life`) that publishes a public "today" page with the day's progress, accessible at `minerva.thefarshad.com/today/<user>`.
- **PWA** — installable, offline-capable (Phase 14).

---

## 7. Visual identity — *decided: hybrid, picker shipped in Phase 0*

Default is independent and clean; a `vt323-yellow` theme is one click away so Minerva blends with the personal-site family (`blog`, `tools`, `arcade`) when accessed from there. The picker UI is segmented and lives in the page header, in the spirit of `blog/` and `tools/`.

### Theme picker — 5 themes

| `data-theme=` | Name           | Bg            | Surface       | Fg / muted     | Accent           | Notes                                         |
| ------------- | -------------- | ------------- | ------------- | -------------- | ---------------- | --------------------------------------------- |
| `auto`        | Auto           | follows system `prefers-color-scheme` (light or dark below) | — | — | — | Default. Inline pre-paint script prevents a flash of wrong theme. |
| `light`       | Light          | `#fbfbfa`     | `#f2f2ef`     | `#1a1a1a` / `#6b6f76` | `#2e5aac`  | Calm paperless light.                         |
| `dark`        | Dark           | `#0b0d10`     | `#14171c`     | `#e7ebf0` / `#8a93a0` | `#7aa7ff`  | Calm near-black dark.                         |
| `sepia`       | Sepia          | `#f4ecd8`     | `#ece2c6`     | `#3a322a` / `#7a6f5d` | `#a35a2a`  | Warm reading-paper, à la `blog`'s sepia.      |
| `vt323`       | VT323-yellow   | `#fdc114`     | `#f4b800`     | `#ffffff` / `#fff9d8` | `#1f1a00`  | Homage to `the-farshad`'s home page. Pairs naturally with the `vt323` font choice but works with any font. |

### Font picker — 7 fonts

| `data-font=` | Name                  | Stack                                                            | Why                                                  |
| ------------ | --------------------- | ---------------------------------------------------------------- | ---------------------------------------------------- |
| `system`     | System (default)      | `ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`| Fastest, no network. Default.                        |
| `inter`      | Inter                 | `'Inter', system-ui, sans-serif`                                 | Clean, neutral, great UI font.                        |
| `roboto`     | Roboto                | `'Roboto', system-ui, sans-serif`                                | Familiar Google sans. *(User-requested.)*            |
| `ubuntu`     | Ubuntu                | `'Ubuntu', system-ui, sans-serif`                                | Warm, friendly. *(User-requested.)*                  |
| `vazir`      | Vazirmatn             | `'Vazirmatn', 'Tahoma', sans-serif`                              | Excellent multilingual support — Persian, Kurdish, Arabic, Latin. *(User-requested.)* |
| `atkinson`   | Atkinson Hyperlegible | `'Atkinson Hyperlegible', system-ui, sans-serif`                 | Designed for low-vision readers; high-contrast forms. |
| `vt323`      | VT323                 | `'VT323', ui-monospace, monospace`                               | Retro CRT mono. The family-bond font; pairs with the VT323 theme. |

### Implementation notes (Phase 0)

- Web fonts loaded once from Google Fonts via a single `<link>` tag listing all six external families. `display=swap` so system text appears immediately and the chosen face fades in.
- Pre-paint script (in `<head>`, before stylesheet) reads `localStorage` and sets `data-theme`/`data-font` on `<html>` so there's no flash of wrong theme.
- Picker is a small segmented control sitting in the header (right-aligned on desktop, collapsing under the title on narrow screens).
- Choices persist across visits and across browsers via `localStorage` only — no backend, no telemetry.

---

## 8. Teminder bridge

Teminder (the user's C++ TUI task manager) already syncs with Google Sheets. Three options:

| Option | What it means                                                                                  | Pros                          | Cons                            |
| ------ | ---------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------- |
| A      | **Independent** — Minerva and Teminder use different sheets.                                   | Clean separation              | Two task lists                  |
| B      | **Shared schema** — Minerva's `tasks` tab matches Teminder's expected columns; both write to it. *Recommended.* | One source of truth | Schema constrained on both ends |
| C      | **Bridge tab** — Minerva has a `_teminder_inbox` tab; Teminder reads/writes it; Minerva reconciles into `tasks`. | Loose coupling | More moving parts |

Decision needed before Phase 1, since spreadsheet bootstrap depends on it.

---

## 9. Plugin & extension model (Phase 16)

A Minerva plugin is a single ES module exporting a default object:

```js
export default {
  name: "Pomodoro",
  version: "0.1.0",
  columnTypes: { pomo: { editor: ..., renderer: ... } },
  views:       { pomodoro: { match: ..., render: ... } },
  widgets:     { pomoStats: ... },
  prompts:     { ... }
};
```

Plugins are listed by URL in the `_plugins` tab. They run in a same-origin iframe; Minerva exposes a postMessage RPC so plugins can read/write rows under the user's existing OAuth grant — no extra permissions. The user's `_log` tab records which plugin made each write.

A curated registry (just a JSON file in this repo) seeds: `pomodoro`, `voice-capture`, `arxiv-importer`, `goodreads-importer`, `weather-context`, `bookmarklet-bridge`.

---

## 10. Privacy, security & data model

- **No secrets in repo.** Ever. The OAuth client ID is BYO and lives only in the user's `localStorage`.
- **No telemetry.** No analytics, no error reporters, no fonts that phone home (Inter / system stack).
- **All API calls go directly to Google from the user's browser.** Minerva has no proxy.
- **Public anything is opt-in row-by-row.** A `public:check` column must be true *and* the user must have published their sheet, otherwise the public route 404s.
- **Therapy / journal presets ship with `public` removed entirely** so they cannot be accidentally exposed.
- **OAuth scopes** are minimal: `spreadsheets` + `drive.file` only (drive.file = "files this app created"). No full-Drive read.
- **Versioning is free** — Sheets has its own version history; Minerva surfaces it as a "history" panel per row.

---

## 11. Quality bar — "perfectionist" checklist

Every shipped phase clears all of these before merging:

- ◇ **Cold-load TTI < 800ms** on a slow 3G profile.
- ◇ **No layout shift** between empty state and loaded state.
- ◇ **Lighthouse**: ≥95 in Performance, Accessibility, Best Practices, SEO.
- ◇ **Keyboard-only walkthrough** of every flow possible end-to-end.
- ◇ **Reduced-motion** respected (`prefers-reduced-motion`).
- ◇ **Screen reader** smoke test (NVDA / VoiceOver) for new interactive elements.
- ◇ **Mobile** layouts manually tested at 320px and 768px.
- ◇ **Print stylesheet** updated when new view kinds ship.
- ◇ **No console errors** in any flow.
- ◇ **Source size budget**: total JS < 60KB compressed, CSS < 20KB compressed.
- ◇ **Optimistic writes** with explicit rollback toasts on failure.
- ◇ **Empty / loading / error** states designed for every view, not afterthoughts.
- ◇ **README** updated when a phase ships.
- ◇ **`LOG.md` decision** recorded for any tradeoff worth re-litigating.

---

## 12. Cadence & decision-making

- Phases ship one at a time; user reviews and signs off before the next starts.
- Each phase opens a `phase-N` branch and ends in a single squashed commit on `main`.
- **All commits use the user's name and email** — `Farshad Ghorbanishovaneh <farshad.1991@gmail.com>`. Co-authored-by trailers are off by default for this project (per user instruction).
- A short `CHANGELOG.md` is kept once we hit Phase 1.
- Decisions worth re-litigating are recorded as a single line in `DECISIONS.md` (committed) once we exit Phase 0.
- The local `LOG.md` (gitignored) keeps the per-prompt journal indefinitely, with status markers and a rolled-up pulls backlog.

---

## 13. Open questions (snapshot of the pulls backlog at time of writing)

1. GitHub repo owner/name — confirmed as `the-farshad/Minerva`.
2. CNAME / Google Cloud OAuth client setup — done already, or have README walk through it?
3. **Teminder relationship**: A / B / C from §8?
4. ~~**Visual identity**~~ — *resolved: hybrid; picker with 5 themes + 7 fonts shipped in Phase 0 (see §7).*
5. **AI provider scope**: Ollama only / Anthropic only / BYO endpoint / all three?
6. **Adjacent surfaces** appetite: which of {iCal, RSS, OpenSearch, bookmarklet, email-in, daily snapshot} are wanted in v1?
7. **`_config` editing**: in-app with write-back, or Sheets-only?
8. **`LOG.md` scope**: append-forever (current) or rotate per session?
9. **Companion `DECISIONS.md`** committed once Phase 0 ships — yes?
10. **Pulls section label** — keep "Pulls / open questions" or rename?

---

*This roadmap is the "everything we could do." Phase ordering is the contract. Phase scope is negotiable.*
