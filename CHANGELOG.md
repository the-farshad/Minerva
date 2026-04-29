# Changelog

Notable changes to Minerva, grouped by phase. Most recent first.

---

## v0.16 — Light-theme fix · research workflow

- **Light theme bug fixed**: pinning *Light* on a dark-mode OS now actually goes light. The dark `@media` block was overriding `:root` after the light rule defined the same variables; `[data-theme="light"]` now lives below the `@media` so explicit choices always win.
- **Smart URL import** at `+ from URL` per section: paste an arXiv id/URL or YouTube URL — Minerva auto-fetches title, authors, abstract/thumbnail, year, and the canonical pdf URL (arXiv) via CORS-allowed APIs. Generic URLs are added as URL-only.
- **Library** preset (papers · articles · videos · podcasts · books) and **Proposals** preset (with funder, deadline, status, the structured sections reviewers expect).
- **Proposal helper**: AI prompts for *NSF / NIH / ERC structure*, *critique my abstract*, and *broader impacts brainstorm*. Companion doc at [`docs/proposal-guide.md`](docs/proposal-guide.md) — funder-by-funder rules, page limits, common pitfalls, pre-submission checklist.
- **Capture-from-URL bookmarklet**, **OpenSearch** browser-bar registration, **RSS feed** of completed-this-week tasks, **per-section accent color** via `_config.color`, **KaTeX** rendering for `latex` columns, **voice capture** in the quick-capture modal, **custom theme** via raw CSS variables in Settings, **Pomodoro timer** floating widget that logs to a `pomodoros` tab.

## v0.15 — Row detail + CSV import

- **Row detail modal** — double-click a row (or press `d` while it's selected) to open a full-field view: every visible column shown, full markdown rendered, every field click-to-editable through the same path as inline cell edits. Undo still works after closing the modal. Footer has Close / Delete / Open in Sheets actions.
- **CSV/TSV paste import** — `Import` button in every section header opens a modal with a paste textarea, auto-detects tab/comma/semicolon delimiter, and shows a live preview that strikes through unmatched columns. On confirm, each row goes through the same `addRow` path as inline, so the dirty queue lifts them to Sheets and undo can reverse one at a time.

## v0.14 — Quick-add, nav badges, bulk operations

- **Quick-add task** in the Today view: a single text input at the top creates a task with `due=today` and `status=todo` on Enter.
- **Nav count badges** on the Today and Tasks links: due-or-overdue tasks + habits-not-done-today on Today, all non-done tasks on Tasks. Updates on every renderNav and after every push.
- **Bulk operations** in section list views: per-row checkbox + select-all in the header. When selection is non-empty, a sticky pill bar appears with **Mark done**, **Delete**, **Clear**. All bulk mutations go through the existing single-row paths so undo works one row at a time, and the recurrence-spawn hook fires per-row on bulk Mark done.

## v0.13 — Undo (Cmd/Ctrl+Z)

- Mutating operations (cell edits, adds, deletes, status toggles) push to a `localStorage` undo stack capped at 50 entries. **`⌘/Ctrl + Z`** pops the last and applies its inverse: edits restore the previous value, adds become deletes, deletes restore from a snapshot of the row taken at delete time. Re-renders the current view and queues the inverse for push back to Sheets.
- Cmd/Ctrl+Z is intercepted only outside text editors so the browser's native text undo still works while typing in a cell.

## v0.12 — Onboarding, Settings TOC, j/k navigation

- **First-run onboarding card** on the home view: a 4-step checklist (open the app · create OAuth client · paste it in Settings · Connect Google) with progress bar, completed checkmarks, and a CTA button that jumps to the next undone step. Replaces the generic callouts when the user isn't connected yet; the callouts still render below in a compact form.
- **Settings TOC sidebar** — sticky left-rail navigation jumps you to any of the seven panels (Connection, Local store, Add a section, Notifications, Calendar feed, Telegram, AI). Mobile flips it to a horizontal chip strip.
- **j/k row navigation** in section list views: `j`/`k` move selection, `e` edits, `c` toggles status, `x` deletes — with the recurrence-spawn hook firing on `c` when applicable. Help cheatsheet updated.

## v0.11 — Saved views, push error state, backlinks

- **Saved views** per section: capture the current sort + live filter as a named view; recall with one click. Stored in `localStorage` per slug. Pill bar above the section's lead also shows a `Clear` button when the active view diverges from `_config` defaults.
- **Push indicator error state**: when a sync fails, the bottom-right pill flips red with `⚠ Sync failed`, an inline **Retry** button, and a × to dismiss. Hover Retry for the underlying error message. Tab-level errors that `pushAll` previously swallowed now surface here too.
- **Backlinks**: every section computes incoming references from every other tab's `ref(thisTab)` columns. Each row gets a small `↺ N` badge in list and tree views; the bottom of the section shows a *Linked from* panel with the top-8 most-referenced rows and a per-source-tab breakdown.

## v0.10 — AI assistant

- **AI assistant** at ⌘/Ctrl+J. Provider-agnostic wrapper supports four modes: Anthropic (Claude — uses the `anthropic-dangerous-direct-browser-access: true` browser-direct header), OpenAI / OpenAI-compatible, Ollama (local), or BYO endpoint. API keys live only in `localStorage`; nothing is proxied through Minerva's static-site origin.
- Five built-in quick prompts that ground the model in your own data (tasks/goals/projects, optionally notes): *Summarize my week*, *Suggest a next action*, *Decompose a goal*, *Find duplicates*, *Cluster my notes*.
- Free-form prompt area with a `system` message that frames Minerva as a planning assistant. ⌘/Ctrl+Enter sends. Response renders as markdown.
- Settings panel for provider/key/endpoint/model with a *Test* button that opens the assistant pre-filled.

## v0.9 — Tree view for hierarchies

- **Tree mode** is now an option in the section-mode toggle for any section whose schema includes a self-referential ref column (e.g. `goals.parent:ref(goals)` in the seed schema). Renders rows as a collapsible nested list with current status, progress bar, due date, and child count per node. Click ▸/▾ to fold a branch; the title links straight to the row in your spreadsheet.

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
