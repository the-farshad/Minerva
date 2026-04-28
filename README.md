# Minerva

A lightweight personal planner. Goals, tasks, projects, notes — backed by a Google Sheet **you** own. The app is a static site; there are no servers, no databases, no accounts. Public sharing with QR codes is built in.

> **Status — Phase 0.** Static shell, theme + font picker, public share with QR codes are live. Google Sign-In, automatic spreadsheet bootstrap, and dynamic sections land in upcoming phases. The full plan: [`ROADMAP.md`](ROADMAP.md).

**Live:** <https://minerva.thefarshad.com>

---

## What works today (Phase 0)

- **Quick share** — build a note, question, or poll; get a stable URL and a crisp QR code. No login required. The data lives in the URL itself, so nothing is uploaded.
- **Public viewer** — anyone with the link sees the same card you do, scannable from a phone via QR.
- **Theme picker** — five themes: `auto · light · dark · sepia · vt323-yellow` (homage to [thefarshad.com](https://thefarshad.com)).
- **Font picker** — seven fonts: `system · Inter · Roboto · Ubuntu · Vazirmatn · Atkinson Hyperlegible · VT323`.
- **Local settings** — paste your own Google OAuth client ID; it never leaves your browser.

Auth, spreadsheet bootstrap, and the dynamic schema engine ship next. See [`ROADMAP.md`](ROADMAP.md) for the full 21-phase plan.

---

## Use it

1. Visit <https://minerva.thefarshad.com>.
2. Click **Quick share** in the nav (or hit `q`).
3. Type a title and body, optionally add choices to make it a poll.
4. Copy the link, or download the QR as a 16× PNG (poster-quality).
5. Anyone with the link sees the rendered card.

**Keyboard shortcuts:** `g` home · `q` quick share · `s` settings.

---

## Phase 1+ (later) — bring your own Google OAuth client

When auth lands you'll need an OAuth client ID — there are no shared secrets in this repo on purpose. It takes ~5 minutes:

1. Open [Google Cloud Console](https://console.cloud.google.com/) → create or pick a project.
2. Go to **APIs & Services → Library** and enable both **Google Sheets API** and **Google Drive API**.
3. **APIs & Services → OAuth consent screen** — set User type to *External*, fill in the basic fields (app name, support email), and add yourself as a Test user.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Authorized JavaScript origins: `https://minerva.thefarshad.com` (and `http://localhost:8000` if you preview locally).
   - Skip the redirect URIs — Minerva uses the implicit token flow, not redirect.
5. Copy the resulting client ID (looks like `123…-abc.apps.googleusercontent.com`).
6. Open Minerva → **Settings** → paste it → Save.

Your client ID is stored only in your browser via `localStorage`. It's not a secret per se, but it's still yours — Minerva never asks for or transmits it anywhere except to Google's auth endpoints.

---

## Architecture in two paragraphs

Minerva is a **schema-driven planner over Google Sheets**. The app is a static site. Per user, there is one Google spreadsheet with one tab per section (`tasks`, `goals`, `notes`, …). A reserved `_config` tab declares which sections exist, in what order, with which icons and default sort/filter — so adding a "Habits" or "Papers" section is a row in `_config` plus a tab, not a code change. The column schema for each section is **inferred from the tab's header row + a type-hint row**, supporting types like `text`, `longtext`, `markdown`, `date`, `select(a,b,c)`, `check`, `link`, `ref(tab)`, `drive`, `progress`, `rating`, and a `public` toggle.

Public sharing has three layers: (1) URL-hash payload — works today, free + offline; (2) per-row publish via published Sheet CSV — Phase 7; (3) per-dashboard publish — Phase 7. QR codes are generated client-side as crisp SVG and downloaded as 16× PNG.

For the long-form vision: [`ROADMAP.md`](ROADMAP.md).

---

## Develop / fork

```sh
git clone git@github.com:the-farshad/Minerva.git
cd Minerva
python3 -m http.server 8000
```

Open <http://localhost:8000>. Editing `index.html` or anything in `assets/` and refreshing is the entire dev loop — no build step.

### Layout

```
index.html             single-page shell
assets/styles.css      themes + fonts + layout
assets/qr.js           SVG QR generator (wraps qrcode-generator from CDN)
assets/share.js        encode/decode payloads + PNG export
assets/app.js          hash router + views
ROADMAP.md             the long roadmap
CNAME                  custom domain for GitHub Pages
.nojekyll              tells Pages not to run Jekyll
```

### Deploy

GitHub Pages → **Settings → Pages → Source = Deploy from branch → Branch = `main` / `(root)`**. The `CNAME` file pins the custom domain; the `.nojekyll` file disables Jekyll processing.

---

## Privacy

- **No telemetry.** No analytics, no error reporters.
- **No secrets in repo.** Ever. The OAuth client ID is BYO, kept in `localStorage` only.
- **No proxy.** API calls go directly from your browser to Google.
- **OAuth scopes** (Phase 1+) will be the minimal set: `spreadsheets` + `drive.file` (i.e. files this app created — *not* full-Drive read).
- **Public sharing is opt-in row-by-row.** Therapy/journal-style presets ship without a `public` column, so they cannot be accidentally exposed.

---

## License

MIT — see [`LICENSE`](LICENSE).
