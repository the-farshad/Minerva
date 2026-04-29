# Changelog

Notable changes to Minerva, grouped by phase. Most recent first.

---

## v0.8 — Recurring tasks, click-to-sort, preset gallery

- **Recurring tasks**: a task with a populated `recurrence` column auto-spawns the next instance when its status is set to `done`. Recurrence vocab: `daily`, `weekly`, `biweekly`, `monthly`, `quarterly`, `yearly`, `every N days/weeks/months/years`, `every monday/tuesday/...`. The new row carries forward all user-facing fields, with status reset to `todo` and `due` advanced. Adding a `recurrence:text` column to your `tasks` tab in Sheets is enough to opt in.
- **Click-to-sort** on column headers in section list views — cycles asc → desc → off (back to `defaultSort`). Persists per section in `localStorage`.
- **Section preset gallery** — Settings → *Add a section* offers 12 one-click presets (Reading list, Journal, Decisions, Books, Films, Workouts, Papers, Contacts, Travel, Recipes, Inbox, Job applications). Each creates the tab in your spreadsheet, seeds the schema, and writes a row to `_config`. Already-installed presets render greyed out.

## v0.7 — Always-on Telegram bridge & Today view

- **Today view** at `#/today` — a single page showing tasks due/overdue (with one-click ✓), habits not done today, and recent notes. Press `t` from anywhere.
- **Apps Script template** for an always-on Telegram bridge: reminders fire on a daily cron from your own Google account (no need to keep a Minerva tab open), and any text you send to your bot is captured into your `notes` tab automatically. Walkthrough: [`docs/setup-telegram-always-on.md`](docs/setup-telegram-always-on.md).

## v0.6 — Habits, iCal, markdown, PWA

- **Habit tracking (Phase 10)**: `habits` and `habit_log` seed tabs; per-habit streak counter; 12-week contribution-graph heatmap; `+ Done today` button.
- **iCal feed**: tasks publish as a public `.ics` file in your own Drive, subscribable from Apple/Google/Outlook calendars. Settings → Calendar feed → Publish.
- **Markdown rendering** for `markdown` columns and public-share card bodies (loaded via marked.js from CDN).
- **PWA**: installable, with a service worker that stale-while-revalidates the static shell. Read your data offline; edits queue and flush automatically when online.
- **Browser desktop notifications** alongside Telegram for due-task reminders.
- **Per-section live filter** (search box in section header, debounced).

## v0.5 — Polish, dashboards, calendar

- **Phase 4 polish**: resume state (last hash + scroll restored on reload, debounced), push-status indicator, help overlay (`?`), mobile-friendly tweaks.
- **Phase 6 dashboard**: aggregate stats on the home page when connected — tasks done, due today, overdue, average goal progress, active projects, notes count. Each card links to the relevant section.
- **Phase 9 calendar**: per-section List / Calendar toggle for any section with a date or datetime column. Month grid with prev/next/today navigation; today highlighted; done items strike-through. Mode persists per slug in localStorage.
- **Quick capture (`/`)** and **global search (`⌘/Ctrl+K`)** modal overlays. Quick capture maps title/body onto whatever columns a section has. Search builds an in-memory corpus across every section, debounced filter, ↑/↓/Enter navigation.

## v0.4 — CRUD with dirty-queue push (Phase 3 & 3b)

- **Click-to-edit cells** in every section list view. Type-aware editors for `text`, `longtext`, `number`, `date`, `datetime`, `check`, `select(...)`, `link`, `color`, plus the richer Phase 3b editors: `multiselect(...)` (chip toggles + Done button), `rating(0..N)` (clickable stars), `progress(0..N)` (range slider with live percent), `ref(tab)` and `ref(tab, multi)` (dropdown / chip-toggle pickers populated from the referenced tab in the local store).
- **+ Add row** and **× Delete row** per section. ULIDs for new rows.
- **Coalescing dirty-queue push**: edits write to IndexedDB first (instant UI), get marked dirty, then a single-flight push flushes them to Sheets via `values.update` / `values.append` / `batchUpdate.deleteDimension`.
- **Pull preserves dirty rows** so a mid-edit sync never destroys work-in-progress.

## v0.3 — Schema engine + dynamic routes (Phase 2)

- `_config` drives the nav and per-section routes. Adding a section is a row in `_config` plus a tab — no code change.
- `#/s/<slug>` section list view, with default sort and filter from `_config`.
- Type-aware cell renderers: progress bars, star ratings, status/priority chips with color variants, multi-chip lists, check icons, link cells with favicon-host labels, internal-ref links, color swatches, lazy images, formatted dates.

## v0.2 — Local IndexedDB mirror + sync (Phase 1.5)

- Per-tab object store in IndexedDB; sync metadata cached for last-pulled time.
- Pull pulls `_config` first, then every tab listed there, plus a fixed seed list. Cached schema (header + type-hint row) per tab.
- Settings panel for the local store: row counts, last-sync time, **Sync now** and **Clear local mirror** buttons.

## v0.1 — Auth + spreadsheet bootstrap (Phase 1)

- Google Sign-In via Google Identity Services token-flow client.
- BYO OAuth Client ID — stored only in the user's browser. The repo carries no shared secrets.
- Auto-creates a `Minerva` spreadsheet in the user's Drive on first connect, seeded with `_config`, `_prefs`, `_log`, and `goals` / `tasks` / `projects` / `notes` (each with header + type-hint rows).
- **Minimal scope set**: only `drive.file` + `userinfo.email` + `openid`. The Sheets API works for app-created files under `drive.file`. All three scopes are non-sensitive, so the consent flow skips the "Google hasn't verified this app" yellow warning.
- Detailed setup walkthrough at [`docs/setup-google-oauth.md`](docs/setup-google-oauth.md).

## v0.0 — Static shell, themes, fonts, public share with QR (Phase 0)

- Hash-routed single-page app, no build step.
- 5 themes (`auto`, `light`, `dark`, `sepia`, `vt323-yellow`) and 7 fonts (`system`, `Inter`, `Roboto`, `Ubuntu`, `Vazirmatn`, `Atkinson Hyperlegible`, `VT323`), persisted via `localStorage`.
- Quick-share view: build a `note` / `question` / `poll` card; the data is encoded into the URL hash, no server involved.
- Public viewer at `#/p/<token>` decodes the hash and renders the same card. Includes a crisp SVG QR code, downloadable as a 16× PNG.
- Privacy and Terms pages.
- GPL v3.

---

Future-tense items still on the roadmap: Drive picker (Phase 5), per-row published Sheets sharing (Phase 7), real Google-Form-backed polls (Phase 8), research/academic preset (Phase 11), AI assistant (Phase 12), recurring tasks via RRULE (Phase 13), advanced theming (Phase 15), plugin architecture (Phase 16), federation (Phase 19), native wrappers (Phase 20).
