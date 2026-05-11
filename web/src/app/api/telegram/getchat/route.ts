/**
 * Resolve the user's Telegram chat id by calling `getUpdates` on
 * the configured bot. The user just needs to DM the bot once with
 * any message; this returns the chat.id from the most recent
 * update.
 *
 *   POST /api/telegram/getchat
 */
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { readTelegramPrefs, writeTelegramPrefs } from '@/lib/telegram';

interface Update { message?: { chat?: { id?: number; type?: string; title?: string } } }

export async function POST() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const prefs = await readTelegramPrefs(userId);
  if (!prefs.botToken) {
    return NextResponse.json({ error: 'Save the bot token first.' }, { status: 400 });
  }
  const r = await fetch(`https://api.telegram.org/bot${prefs.botToken}/getUpdates`);
  if (!r.ok) {
    return NextResponse.json({ error: `Telegram ${r.status}: ${(await r.text()).slice(0, 200)}` }, { status: 502 });
  }
  const data = (await r.json()) as { ok?: boolean; result?: Update[] };
  if (!data.ok || !Array.isArray(data.result) || data.result.length === 0) {
    return NextResponse.json({
      error: 'No messages yet — open Telegram, find your bot, send it any message (e.g. /start), then click this again.',
    }, { status: 404 });
  }
  // Last message wins. A user can have multiple chats; we pick the
  // most recent so re-clicking after a fresh DM updates the id.
  const latest = data.result[data.result.length - 1];
  const id = latest?.message?.chat?.id;
  if (typeof id !== 'number') {
    return NextResponse.json({ error: 'Most recent update has no chat id.' }, { status: 502 });
  }
  await writeTelegramPrefs(userId, { chatId: String(id) });
  return NextResponse.json({ chatId: String(id) });
}
