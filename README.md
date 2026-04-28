# Minerva

A lightweight personal planner. Goals, tasks, projects, notes — backed by a Google Sheet **you** own. The app is a static site; there are no servers, no databases, no accounts. Public sharing with QR codes is built in.

> **Status — Phase 1.** Google Sign-In + automatic spreadsheet bootstrap are live, on top of Phase 0's static shell, theme + font picker, and public share with QR codes. Dynamic sections (read straight from your `_config` tab) land next.

**Live (hosted instance):** <https://minerva.thefarshad.com>

**Self-host your own copy:** Minerva is MIT-licensed, has no backend, and runs on plain GitHub Pages — fork it, push it to your own repo, enable Pages, point a domain at it, and you've got an independent Minerva at *your* URL. Full walkthrough in [Run your own copy](#run-your-own-copy) below. Either way, your data always lives in your own Google account; the hosted instance and a self-hosted copy are functionally identical.

---

## What works today

- **Connect Google** — sign in with the BYO OAuth client; Minerva auto-creates (or finds) a `Minerva` spreadsheet in your Drive and seeds it with the meta tabs (`_config`, `_prefs`, `_log`) and four section tabs (`goals`, `tasks`, `projects`, `notes`), each with a header row + a type-hint row that defines how Phase 2 will render it.
- **Local store + sync** — every connect pulls the spreadsheet into a private IndexedDB mirror in your browser. Settings shows the per-tab row counts and last-sync time; a **Sync now** button does a manual pull. Phase 3 will add push-back so local edits flush to Sheets in the background.
- **Quick share** — build a note, question, or poll; get a stable URL and a crisp QR code. No login required. The data lives in the URL itself, so nothing is uploaded.
- **Public viewer** — anyone with the link sees the same card you do, scannable from a phone via QR.
- **Theme picker** — five themes: `auto · light · dark · sepia · vt323-yellow` (homage to [thefarshad.com](https://thefarshad.com)).
- **Font picker** — seven fonts: `system · Inter · Roboto · Ubuntu · Vazirmatn · Atkinson Hyperlegible · VT323`.

The dynamic schema engine reads `_config` and the type-hint rows to build nav, routes, and per-section editors — that's Phase 2 next.

---

## Use it

1. Visit <https://minerva.thefarshad.com>.
2. Click **Quick share** in the nav (or hit `q`).
3. Type a title and body, optionally add choices to make it a poll.
4. Copy the link, or download the QR as a 16× PNG (poster-quality).
5. Anyone with the link sees the rendered card.

**Keyboard shortcuts:** `g` home · `q` quick share · `s` settings.

---

## Phase 1 — bring your own Google OAuth client

You need an OAuth Client ID — there are no shared secrets in this repo on purpose. It takes ~5 minutes.

**👉 Detailed step-by-step walkthrough (with troubleshooting):** [`docs/setup-google-oauth.md`](docs/setup-google-oauth.md)

In short:

1. [Google Cloud Console](https://console.cloud.google.com/) → create a project (e.g. "Minerva").
2. **APIs & Services → Library** — enable **Google Sheets API** and **Google Drive API**.
3. **APIs & Services → OAuth consent screen** — User type: External; add the four scopes (`spreadsheets`, `drive.file`, `userinfo.email`, `openid`); add your email as a Test user.
4. **APIs & Services → Credentials → Create OAuth client ID** — type: Web application; Authorized JavaScript origins: `https://minerva.thefarshad.com` (and `http://localhost:8000` for local dev).
5. Copy the Client ID (looks like `123…-abc.apps.googleusercontent.com`).
6. Open Minerva → **Settings** → paste → **Save** → **Connect Google**.

Your Client ID is stored only in your browser via `localStorage`. It's not a secret per se, but it's still yours — Minerva never asks for or transmits it anywhere except to Google's auth endpoints.

---

## Architecture in two paragraphs

Minerva is a **schema-driven planner over Google Sheets**. The app is a static site. Per user, there is one Google spreadsheet with one tab per section (`tasks`, `goals`, `notes`, …). A reserved `_config` tab declares which sections exist, in what order, with which icons and default sort/filter — so adding a "Habits" or "Papers" section is a row in `_config` plus a tab, not a code change. The column schema for each section is **inferred from the tab's header row + a type-hint row**, supporting types like `text`, `longtext`, `markdown`, `date`, `select(a,b,c)`, `check`, `link`, `ref(tab)`, `drive`, `progress`, `rating`, and a `public` toggle.

Public sharing has three layers: (1) URL-hash payload — works today, free + offline; (2) per-row publish via published Sheet CSV; (3) per-dashboard publish. QR codes are generated client-side as crisp SVG and downloaded as 16× PNG.

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
assets/styles.css      themes + fonts + layout
assets/qr.js           SVG QR generator (wraps qrcode-generator from CDN)
assets/share.js        encode/decode payloads + PNG export
assets/auth.js         Google Identity Services token-flow client
assets/sheets.js       thin Sheets API v4 + Drive API v3 wrapper
assets/db.js           local IndexedDB store (your data, mirrored in-browser)
assets/bootstrap.js    find-or-create the user's Minerva spreadsheet
assets/sync.js         pull spreadsheet → local store; phase 3 will add push
assets/app.js          hash router + views
CNAME                  custom domain for GitHub Pages
.nojekyll              tells Pages not to run Jekyll
```

---

## Privacy

- **No telemetry.** No analytics, no error reporters.
- **No secrets in repo.** Ever. The OAuth client ID is BYO, kept in `localStorage` only.
- **No proxy.** API calls go directly from your browser to Google.
- **OAuth scopes** are the minimal set: `spreadsheets` + `drive.file` (only files this app created — *not* full-Drive read) + `userinfo.email` + `openid`.
- **Public sharing is opt-in row-by-row.** Therapy/journal-style presets ship without a `public` column, so they cannot be accidentally exposed.

---

## License

MIT — see [`LICENSE`](LICENSE).
