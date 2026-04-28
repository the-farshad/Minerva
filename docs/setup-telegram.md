# Setting up the Telegram bot

Minerva can ping a Telegram chat with reminders for tasks due today, send manual messages, and (with optional Apps Script bridge) accept inbound writes — *"@MinervaBot remember: pick up bread"* lands as a row in your `notes` tab.

This doc covers the always-works **client-side** mode. For the optional **always-on** mode (reminders fire even when your Minerva tab is closed; bot can write to your Sheet from anywhere), see the *Always-on bridge* section at the end.

**You'll need:** a Telegram account and ~3 minutes.

---

## 1 · Create a bot with @BotFather

In Telegram, search for **@BotFather** (the official one with a blue checkmark) and start a chat.

Send these commands:

| You send | BotFather replies |
|---|---|
| `/newbot` | "Alright, a new bot. How are we going to call it?" |
| `Minerva` (or any display name) | "Good. Now let's choose a username for your bot." |
| `your_minerva_bot` (must end in `bot`) | "Done! Congratulations on your new bot. ... Use this token to access the HTTP API: `123456789:ABCDEF…`" |

**Copy the token.** It looks like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`. Keep it private — anyone with this token can act as your bot.

(Optional but nice: send `/setdescription` and `/setuserpic` to BotFather to round out your bot's profile.)

## 2 · Wake the bot up

Open a chat with your new bot and send any message — `/start` is conventional. This is so Telegram has at least one message addressed to it; otherwise the chat-ID detection step will return nothing.

## 3 · Plug it into Minerva

Open Minerva → **Settings** → scroll to the **Telegram** panel.

1. Paste the token into **Bot token**. Click **Save**.
2. Click **Test connection**. You should see the bot's username (e.g. `@your_minerva_bot`). If you see an error, double-check the token.
3. Click **Detect chat ID**. Minerva calls Telegram's `getUpdates` and reads the chat ID of your most-recent message to the bot. The chat ID input fills in.
4. Click **Send test message**. Your Telegram should buzz with *"Minerva connected ✅"*.

That's it. Minerva will now check for tasks due today on every page load (and every 30 minutes while a tab is open), and send a reminder once per task per day. Reminders are tracked in `localStorage` so the same task isn't pinged twice.

> **Tab-open caveat.** Because Minerva is a static site with no backend, the reminder check runs in your browser only. If no Minerva tab is open, no reminder fires. Most users keep one tab pinned and that's enough; if you need always-on, see below.

## 4 · Disable / re-enable

Settings → Telegram → **Disable**. Saves a flag in `localStorage`; reminders stop firing. Re-enable any time.

To remove Telegram entirely, click **Clear Telegram config** — wipes the token and chat ID from your browser. Your bot in Telegram is unaffected (and can be deleted via @BotFather → `/deletebot` if you want).

---

## Always-on bridge (optional)

This mode adds:

- Reminders that fire from your Google account on a cron, even if no Minerva tab is open.
- *Inbound* messages from the bot — text you send the bot becomes rows in your `notes` tab automatically.

It works by installing a Google Apps Script you own, in your own Google Drive. Setup is more involved (~10 minutes) but pure copy-paste.

**👉 Always-on bridge walkthrough:** [`docs/setup-telegram-always-on.md`](setup-telegram-always-on.md)

The browser-only mode above is the recommended starting point — try it first.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Telegram error 401: Unauthorized` | Bot token is wrong or has whitespace. | Copy token again from BotFather; no leading/trailing spaces. |
| `Detect chat ID` returns nothing | You haven't messaged the bot yet, or the bot has a webhook configured. | Send `/start` to your bot. If a webhook is configured, Telegram won't return updates via `getUpdates` — see *Bot has webhook* below. |
| `Telegram error 400: chat not found` | Wrong chat ID, or you've never messaged the bot from that chat. | Run **Detect chat ID** again after sending a message. |
| `Telegram error 403: Forbidden: bot was blocked by the user` | You blocked the bot. | Unblock in Telegram, or `/start` it again. |
| Test message worked, but reminders never fire | Tab was closed when the check would have run. | Keep a Minerva tab open, or set up the always-on bridge. |
| `Bot has webhook` (409 from getUpdates) | A previous integration registered a webhook for this bot. | Remove it via `https://api.telegram.org/bot<TOKEN>/deleteWebhook` (open in browser; should return `{"ok":true,"result":true}`). |

---

## Privacy

The bot token and chat ID live only in your browser's `localStorage`, alongside your Minerva config. They're never sent anywhere except `api.telegram.org`. If you self-host Minerva on your own domain, this stays true — there's no Minerva server to receive them.

The list of which task IDs have been pinged today (so the same task isn't reminded twice) also lives in `localStorage`, keyed by date. It's wiped when you clear site data, when you click *Clear Telegram config*, or naturally as old date keys roll out.
