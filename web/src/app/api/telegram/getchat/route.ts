/**
 * Resolve the user's Telegram chat id by calling `getUpdates` on
 * the configured bot. Common failure modes the route surfaces
 * specifically:
 *
 *   • No token saved yet                 → 400
 *   • Bot has a webhook set               → 409 with explanation
 *                                           (getUpdates returns []
 *                                           when a webhook routes
 *                                           updates elsewhere)
 *   • Webhook clear but no DMs yet        → 404 "DM the bot first"
 *
 *   POST /api/telegram/getchat
 */
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { readTelegramPrefs, writeTelegramPrefs } from '@/lib/telegram';

interface ChatInfo {
  id?: number;
  type?: string;
  title?: string;
  username?: string;
  first_name?: string;
}
interface Update { message?: { chat?: ChatInfo } }

export async function POST() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const prefs = await readTelegramPrefs(userId);
  if (!prefs.botToken) {
    return NextResponse.json({ error: 'Save the bot token first.' }, { status: 400 });
  }

  // Detect a webhook up front — getUpdates returns an empty array
  // when one is set, which previously surfaced as "no DMs yet"
  // and sent users on a wild goose chase.
  try {
    const wh = await fetch(`https://api.telegram.org/bot${prefs.botToken}/getWebhookInfo`);
    if (wh.ok) {
      const wj = (await wh.json()) as { result?: { url?: string } };
      if (wj.result?.url) {
        return NextResponse.json({
          error: `Your bot has a webhook configured (${wj.result.url}). Telegram won't return updates via getUpdates while a webhook is active — delete the webhook (https://api.telegram.org/bot<token>/deleteWebhook), DM the bot, then try again. Or paste the chat id manually if you already know it.`,
        }, { status: 409 });
      }
    }
  } catch { /* network blip — fall through to the regular path */ }

  const r = await fetch(`https://api.telegram.org/bot${prefs.botToken}/getUpdates`);
  if (!r.ok) {
    return NextResponse.json({ error: `Telegram ${r.status}: ${(await r.text()).slice(0, 200)}` }, { status: 502 });
  }
  const data = (await r.json()) as { ok?: boolean; result?: Update[] };
  if (!data.ok || !Array.isArray(data.result) || data.result.length === 0) {
    return NextResponse.json({
      error: "No messages yet. Open Telegram, find your bot, send it /start (or any message), then click Get again. If you've sent messages already, try clearing the bot's update queue at https://api.telegram.org/bot<token>/getUpdates first.",
    }, { status: 404 });
  }
  // Last message wins. A user can have multiple chats; we pick
  // the most recent so re-clicking after a fresh DM updates the
  // id.
  const latest = data.result[data.result.length - 1];
  const chat = latest?.message?.chat;
  const id = chat?.id;
  if (typeof id !== 'number') {
    return NextResponse.json({ error: 'Most recent update has no chat id.' }, { status: 502 });
  }
  await writeTelegramPrefs(userId, { chatId: String(id) });
  const label = chat?.title || chat?.username || chat?.first_name || '';
  return NextResponse.json({
    chatId: String(id),
    chatType: chat?.type || 'private',
    chatLabel: label,
  });
}
