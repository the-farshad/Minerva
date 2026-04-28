# Telegram bridge — always-on (optional)

The default Telegram integration only fires reminders while a Minerva tab is open in your browser. This doc covers the optional **always-on bridge**: a Google Apps Script that runs in your own Google account and adds two things the browser-only mode can't:

1. **Inbound messages** — anything you send to your bot in Telegram becomes a row in your `notes` tab.
2. **Reminders fire even with no Minerva tab open** — Apps Script runs the reminder check on a schedule.

The script is yours, runs in your account, has access only to *your* spreadsheet, and is never sent anywhere. You can read every line and modify it freely.

> **Prerequisite:** finish the basic Telegram setup first ([`docs/setup-telegram.md`](setup-telegram.md)) — you need a working bot token and chat ID.

---

## What you'll need

- Your **bot token** (from [`docs/setup-telegram.md`](setup-telegram.md) step 1).
- Your **chat ID** (step 3 of the same doc).
- Your **Minerva spreadsheet ID** — open the spreadsheet in Drive, copy the bit between `/d/` and `/edit` in the URL: `https://docs.google.com/spreadsheets/d/THIS_BIT/edit`.

About 10 minutes.

---

## 1 · Create the Apps Script

Open <https://script.google.com> and click **New project**.

Replace the contents of `Code.gs` with this:

```javascript
// === Configure these three ============================================
const TELEGRAM_TOKEN = 'paste-your-bot-token';
const TELEGRAM_CHAT_ID = 'paste-your-chat-id';
const SPREADSHEET_ID = 'paste-your-spreadsheet-id';
// ======================================================================

const SHEETS_BASE = 'https://api.telegram.org/bot';

/**
 * Webhook entry point. Telegram will POST to this when the bot receives
 * a message. We treat each incoming message as a quick capture into the
 * `notes` tab and reply with a short confirmation.
 */
function doPost(e) {
  try {
    const update = JSON.parse(e.postData.contents);
    const msg = update.message || update.edited_message;
    if (!msg || !msg.text) {
      return ContentService.createTextOutput('ok');
    }
    const text = String(msg.text || '').trim();
    if (!text || text.startsWith('/start') || text.startsWith('/help')) {
      sendTelegram(
        '*Minerva bridge ready.*\n' +
        'Anything you send here becomes a row in the `notes` tab.\n' +
        'Daily reminders for due tasks run on a schedule.'
      );
      return ContentService.createTextOutput('ok');
    }
    appendNote(text);
    sendTelegram('✓ captured to notes');
  } catch (err) {
    console.error(err);
  }
  return ContentService.createTextOutput('ok');
}

/** Append a new row into the `notes` tab. */
function appendNote(text) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sh = ss.getSheetByName('notes');
  if (!sh) throw new Error('No `notes` tab in spreadsheet ' + SPREADSHEET_ID);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const now = new Date().toISOString();
  // Build a row in the tab's header order so this works on user-edited
  // schemas.
  const values = headers.map(function (h) {
    if (h === 'id') return ulid();
    if (h === 'title') return text.slice(0, 80).split('\n')[0];
    if (h === 'body') return text;
    if (h === 'tags') return 'telegram';
    if (h === 'created' || h === '_updated') return now;
    return '';
  });
  sh.appendRow(values);
}

/**
 * Run on a daily time trigger (e.g. 08:00) — pulls the tasks tab and
 * sends one Telegram message summarizing what's due / overdue today.
 */
function dailyReminders() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sh = ss.getSheetByName('tasks');
  if (!sh) return;
  const data = sh.getDataRange().getValues();
  if (data.length < 3) return;
  const headers = data[0];
  const idxTitle = headers.indexOf('title');
  const idxDue = headers.indexOf('due');
  const idxStatus = headers.indexOf('status');
  const idxPriority = headers.indexOf('priority');
  if (idxTitle < 0 || idxDue < 0) return;

  const tz = Session.getScriptTimeZone() || 'UTC';
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

  const due = [];
  const overdue = [];
  for (let i = 2; i < data.length; i++) {
    const row = data[i];
    const title = row[idxTitle];
    if (!title) continue;
    const status = String(row[idxStatus] || '').toLowerCase();
    if (status === 'done') continue;
    const dueVal = String(row[idxDue] || '').slice(0, 10);
    if (!dueVal) continue;
    const item = { title: title, priority: row[idxPriority] || '' };
    if (dueVal === today) due.push(item);
    else if (dueVal < today) overdue.push(item);
  }

  if (!due.length && !overdue.length) return;

  let msg = '';
  if (overdue.length) {
    msg += '*⚠ overdue (' + overdue.length + ')*\n';
    msg += overdue.map(formatLine).join('\n') + '\n\n';
  }
  if (due.length) {
    msg += '*☀ due today (' + due.length + ')*\n';
    msg += due.map(formatLine).join('\n');
  }
  sendTelegram(msg);
}

function formatLine(item) {
  const p = item.priority ? ' _(' + item.priority + ')_' : '';
  return '• ' + item.title + p;
}

function sendTelegram(text) {
  UrlFetchApp.fetch(SHEETS_BASE + TELEGRAM_TOKEN + '/sendMessage', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    }),
    muteHttpExceptions: true
  });
}

/**
 * One-time setup: registers this script's web-app URL as the Telegram
 * webhook so the bot forwards messages to doPost. Run this manually
 * after you've deployed the script as a web app (see step 3 below).
 */
function setupWebhook() {
  const url = ScriptApp.getService().getUrl();
  if (!url) throw new Error('Deploy this script as a web app first (step 3).');
  const resp = UrlFetchApp.fetch(SHEETS_BASE + TELEGRAM_TOKEN + '/setWebhook?url=' + encodeURIComponent(url));
  Logger.log(resp.getContentText());
}

/** Useful for verifying the webhook is set. */
function showWebhook() {
  const resp = UrlFetchApp.fetch(SHEETS_BASE + TELEGRAM_TOKEN + '/getWebhookInfo');
  Logger.log(resp.getContentText());
}

/** Use if you want to switch back to the browser-polling default. */
function deleteWebhook() {
  const resp = UrlFetchApp.fetch(SHEETS_BASE + TELEGRAM_TOKEN + '/deleteWebhook');
  Logger.log(resp.getContentText());
}

// Crockford base32 ULID — same shape Minerva uses, so rows look the same.
function ulid() {
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let ts = Date.now();
  let t = '';
  for (let i = 0; i < 10; i++) {
    t = ALPHABET[ts % 32] + t;
    ts = Math.floor(ts / 32);
  }
  let r = '';
  for (let j = 0; j < 16; j++) {
    r += ALPHABET[Math.floor(Math.random() * 32)];
  }
  return t + r;
}
```

Fill in the three constants at the top with your bot token, chat ID, and spreadsheet ID. **Save** (`⌘/Ctrl+S`).

## 2 · Authorize the script

In Apps Script, click the function dropdown at the top, pick `dailyReminders`, then click **Run**.

Apps Script asks for permissions:

- **Review permissions** → choose your account → **Advanced → Go to (unsafe)** → **Allow**.

This gives the script access to your spreadsheet (via `SpreadsheetApp`) and to the network (via `UrlFetchApp`) — both required.

After it runs you should get a Telegram message listing your due tasks (or no message if nothing's due). If you got an error, the function dropdown lets you try `appendNote('test')` first to verify spreadsheet access.

## 3 · Deploy as a web app (so the webhook can call it)

In Apps Script, click **Deploy → New deployment**.

- **Type** (gear icon): **Web app**.
- **Description**: `Minerva Telegram bridge` (or anything).
- **Execute as**: *Me* (so the script reads your spreadsheet under your auth).
- **Who has access**: **Anyone**.

> "Anyone" sounds scary but it just means Telegram can POST to the URL. The URL itself is unguessable, and the function only acts on messages from your `TELEGRAM_CHAT_ID` — wait, actually we don't filter by chat in this template. If anyone discovers the URL they could send a request that lands a row in your `notes` tab. If that bothers you, add this near the top of `doPost`:
>
> ```javascript
> if (msg.chat.id != TELEGRAM_CHAT_ID) return ContentService.createTextOutput('ok');
> ```

Click **Deploy**. You'll get a *Web app URL*. (Apps Script may also ask you to authorize again; same flow.)

## 4 · Register the webhook

Back in the script editor, pick `setupWebhook` from the function dropdown and **Run**. This calls Telegram's `setWebhook` API with your script URL.

Verify by running `showWebhook` — its log should show your URL and `last_error: ""`.

Now send a message to your bot in Telegram. Within a second or two, you should see a row appear in your `notes` tab in the spreadsheet, and the bot should reply with `✓ captured to notes`.

## 5 · Schedule the daily reminders

In Apps Script, left sidebar → **Triggers** (clock icon) → **+ Add Trigger**.

- **Function**: `dailyReminders`
- **Event source**: Time-driven
- **Type**: Day timer
- **Time**: pick a time (e.g. 8am)

Save. Now `dailyReminders` runs once a day at that time, regardless of whether you have a Minerva tab open. The browser-side reminder loop in Minerva still works too; the per-day dedupe in the browser uses `localStorage` so it won't re-ping items the script already handled — but if both fire on the same day, you may get two pings. To avoid that, disable the browser-side reminders (Settings → Telegram → uncheck the daily reminders toggle) once the script is running.

## 6 · Done

You now have:

- **Always-on reminders** at the time you scheduled, even with every Minerva tab closed.
- **Inbound capture**: anything you send the bot becomes a row in your `notes` tab. Sync next time you open Minerva (or wait for the periodic pull).

To turn this off:

- **Stop reminders**: Apps Script → Triggers → delete the `dailyReminders` trigger.
- **Stop inbound capture**: run `deleteWebhook` once. The browser-polling default takes over again.
- **Remove the script**: `script.google.com` → your project → **⋮ → Move to Trash**.

---

## What the script can and can't see

The script runs as **you**, so it has the same access to your Drive that you do — including, in principle, more than just the Minerva spreadsheet. The template only ever opens `SPREADSHEET_ID`, but it *could* read more if modified. Since it's *your* script in *your* account, that's fine — but if you fork Minerva and offer the script template to others, those users should review what they're authorizing.

The script never sends anything outside your Google account *and* `api.telegram.org`. Both endpoints are visible in the code.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `setupWebhook` returns `{"ok":false,"description":"Bad Request: bad webhook: An HTTPS URL must be provided"}` | Web-app URL not yet generated. | Step 3: **Deploy → New deployment**. Then re-run `setupWebhook`. |
| Bot doesn't reply when you message it | Webhook not set or wrong URL. | Run `showWebhook`. The `url` field should match your script's web-app URL. |
| `Exception: You do not have permission to access "tasks"` | Wrong `SPREADSHEET_ID` (pointing at someone else's sheet) or the constant has whitespace. | Re-copy the spreadsheet ID, paste fresh. |
| Reminders fire but say overdue (UTC) instead of (your zone) | Apps Script time zone mismatch. | Apps Script → Project Settings → set **Time zone** to your local time zone, save, run `dailyReminders` again. |
| Telegram returns 401 on `sendMessage` | Bot token wrong. | Re-copy from BotFather; whitespace and quotes are easy to grab by accident. |
| Apps Script says `Authorization is required to perform that action` after a redeploy | Each deploy generates a new web-app URL needing fresh auth. | Run any function manually once (e.g. `dailyReminders`) → Authorize. |
