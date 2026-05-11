/**
 * Telegram outbound notifications — BYO bot token. The user owns the
 * bot; Minerva just relays. Credentials live in `userPrefs.data.telegram`.
 *
 * Notifications fire from server-side hooks (e.g. save-offline) so the
 * bot token never leaves the server.
 */
import { eq } from 'drizzle-orm';
import { db, schema } from '@/db';

type TgPrefs = { botToken?: string; chatId?: string; enabled?: boolean };

export async function readTelegramPrefs(userId: string): Promise<TgPrefs> {
  const row = await db.query.userPrefs.findFirst({
    where: eq(schema.userPrefs.userId, userId),
  });
  return ((row?.data as Record<string, unknown>)?.telegram as TgPrefs) || {};
}

export async function writeTelegramPrefs(userId: string, patch: TgPrefs): Promise<TgPrefs> {
  const row = await db.query.userPrefs.findFirst({
    where: eq(schema.userPrefs.userId, userId),
  });
  const data = (row?.data as Record<string, unknown>) || {};
  const cur = (data.telegram as TgPrefs) || {};
  const next: TgPrefs = { ...cur, ...patch };
  if (row) {
    await db.update(schema.userPrefs)
      .set({ data: { ...data, telegram: next }, updatedAt: new Date() })
      .where(eq(schema.userPrefs.userId, userId));
  } else {
    await db.insert(schema.userPrefs).values({ userId, data: { telegram: next } });
  }
  return next;
}

export async function notifyTelegram(userId: string, text: string): Promise<void> {
  const prefs = await readTelegramPrefs(userId);
  if (!prefs.enabled || !prefs.botToken || !prefs.chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${prefs.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: prefs.chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
  } catch { /* tolerate — notifications must never break the call site */ }
}
