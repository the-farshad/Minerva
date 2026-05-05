# Setting up your Google OAuth Client

Minerva uses Google's OAuth 2.0 to read and write *your* spreadsheet. Following the project's "no shared secrets" policy, you create your own OAuth Client ID — it lives only in your browser, never in this repo and never on a server.

**You'll need:** a Google account (the one whose Drive will hold your Minerva spreadsheet) and ~5 minutes.

> **Note on Workspace accounts.** If your Google account is part of a Workspace where admins restrict third-party apps, you may not be able to authorize Minerva. Use a personal Google account instead, or ask your admin to allow the app.

---

## 1 · Open Google Cloud Console

Go to <https://console.cloud.google.com> and sign in.

If this is your first project, accept the Terms of Service when prompted.

## 2 · Create (or pick) a project

At the top of the page, click the **project picker** (next to the "Google Cloud" logo).

- Click **New Project**.
- **Name:** `Minerva` (anything you like — the user never sees it).
- **Location:** "No organization" if you don't have one.
- Click **Create**.

After ~10 seconds, the picker should show your project as active. If not, click the picker and select it.

## 3 · Enable the two APIs

Open the left menu (☰) → **APIs & Services → Library**.

- In the search bar, type **Google Sheets API**.
- Click the result → click **Enable**.

Then go back to **Library** and repeat for **Google Drive API**.

You need both: Sheets to read/write your data, Drive to find your existing Minerva spreadsheet across reconnects (under the minimal `drive.file` scope).

## 4 · Configure the OAuth consent screen

Left menu → **APIs & Services → OAuth consent screen**.

- **User Type:** **External** → click **Create**.

Fill in the **App information**:

| Field | Value |
|---|---|
| App name | `Minerva` (or any) |
| User support email | your email |
| App logo | optional — `docs/assets/minerva-logo.png` in this repo (512×512 PNG) |
| App domain | leave empty |
| Authorized domains | leave empty |
| Developer contact information | your email |

Click **Save and Continue**.

### Scopes (the *minimum* set)

Click **Add or Remove Scopes**.

In the modal, search and tick exactly these three:

- `.../auth/drive.file` — *See, edit, create, and delete only the specific Google Drive files you use with this app*
- `.../auth/userinfo.email` — *See your primary Google Account email address*
- `openid` — *Associate you with your personal info on Google*

Click **Update**, then **Save and Continue**.

> The `drive.file` scope (not full-Drive, not the broader `spreadsheets` scope) is intentional. Minerva only ever sees files *it itself created* or that you explicitly opened with it. Sheets API calls work on those files under this scope. As a side benefit, all three of these scopes are **non-sensitive**, so Google does *not* show the "Google hasn't verified this app" yellow warning during consent. (The `access_denied` test-users-list check still applies.)

### Test users

This step is required while the app is in **Testing** mode (which is fine for personal use; you don't need to publish).

- Click **Add users**.
- Add the email of every Google account that will use *this* OAuth client (typically just yours).
- Click **Save and Continue**.

You'll land on a summary page. Click **Back to Dashboard**.

## 5 · Create the OAuth Client ID

Left menu → **APIs & Services → Credentials**.

Click **+ Create Credentials → OAuth client ID**.

- **Application type:** **Web application**
- **Name:** `Minerva web` (or any)

### Authorized JavaScript origins

Click **+ Add URI** for each origin you'll be running Minerva from. Use the *exact* URL — including `https://` (or `http://` for localhost), no trailing slash, no path.

For the hosted instance:
- `https://minerva.thefarshad.com`

For local development:
- `http://localhost:8000`

For your own self-hosted copy, add your domain (e.g. `https://planner.example.com`).

### Authorized redirect URIs

Add the **same URLs** you put under JavaScript origins. Minerva uses an OAuth 2.0 PKCE redirect flow — the user's browser is redirected to `accounts.google.com`, signs in, and is redirected back. Without these entries Google rejects the redirect with `redirect_uri_mismatch`.

For the hosted instance:
- `https://minerva.thefarshad.com`

For local development:
- `http://localhost:8000`

(Same exact strings as in JavaScript origins — no trailing slash, no path.)

Click **Create**.

A modal will pop up showing your **Client ID**. It looks like:

```
123456789012-abcdef0123456789abcdef0123456789.apps.googleusercontent.com
```

Copy it — that's the value you'll paste into Minerva. (You can find it again any time at **APIs & Services → Credentials**.)

## 6 · Paste it into Minerva and connect

- Visit your Minerva URL (e.g. <https://minerva.thefarshad.com>).
- Go to **Settings** (or press `s`).
- Paste the Client ID into the **Google OAuth Client ID** field.
- Click **Save**.
- Click **Connect Google**.

A Google sign-in popup appears.

> Because Minerva uses only non-sensitive scopes, you should *not* see the "Google hasn't verified this app" yellow warning. If you ever do — typically because you're testing a fork that added the broader `spreadsheets` scope back — click **Advanced → Go to Minerva (unsafe)**. It's not actually unsafe; it's your app calling Google with your credentials.

Grant the requested permissions. Minerva creates a `Minerva` spreadsheet in your Drive (if it doesn't already exist), seeds it, and pulls everything into the local store.

You're connected.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Error 400: redirect_uri_mismatch` | The origin you're visiting Minerva from isn't on the OAuth client's *Authorized JavaScript origins* list. | Edit the OAuth client → add the exact URL (with protocol, no path, no slash). |
| `Error 403: access_denied` (or "Minerva has not completed the Google verification process") | Your email isn't on the **Test users** list. | OAuth consent screen → Test users → Add users → your email. |
| Popup closes immediately, no token | Browser blocked the popup. | Allow popups for the Minerva domain, then click Connect again. |
| `This app is blocked` | Your Google account is in a Workspace whose admin has restricted third-party apps. | Use a personal Google account, or ask your admin to allow `Minerva`. |
| Connect succeeds but Sheets calls return `403` | One or both APIs not enabled in this project. | APIs & Services → Library → search "Sheets" / "Drive" → Enable. |
| Token works locally but not on production (or vice-versa) | Each origin must be listed separately on the OAuth client. | Add both `http://localhost:8000` and `https://your-domain` to *Authorized JavaScript origins*. |

---

## Why a Client ID at all?

Google's APIs require OAuth 2.0 to access user data, and the Client ID is what identifies the *app* requesting access. Three options exist:

1. **BYO Client ID** *(what Minerva does)*. Each user creates their own. Repo stays public, no central app to verify, no shared quota.
2. **Shared Client ID** baked into the app. Requires Google's verification process (multi-week review for sensitive scopes), shared quota, central trust.
3. **No Google APIs**. Drop the Sheets backend entirely.

Option 1 is the only one consistent with "your data lives in your account, nothing on our servers" — at the cost of this 5-minute setup.

---

## What permissions does Minerva actually use?

| Scope | What it lets Minerva do |
|---|---|
| `drive.file` | Read and write *only* the `Minerva` spreadsheet (it's the file Minerva created). The Sheets API works under this scope for app-created files. Critically: this scope does *not* give Minerva visibility into the rest of your Drive. |
| `userinfo.email` | Show "Connected as `<your-email>`" in the app. |
| `openid` | Standard OpenID identity claim. |

Notably absent: full Drive read, Calendar, Contacts, Gmail. Minerva can't see anything in your Google account it didn't put there itself.
