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

/** Escape user-content for Telegram's HTML parse_mode. Only `&`,
 *  `<`, and `>` need escaping; everything else (including
 *  underscores, brackets, parens that would break legacy
 *  Markdown) is safe. Switching from Markdown→HTML was the actual
 *  fix for "Telegram doesn't work": dynamic section titles / URLs
 *  routinely contain Markdown-fragile characters, and the
 *  resulting 400 was swallowed by our catch — leaving the user
 *  with a working test-button and silently broken notifications. */
export function escapeTelegramHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function notifyTelegram(
  userId: string,
  htmlText: string,
  opts: { parseMode?: 'HTML' | 'Markdown' | 'none' } = {},
): Promise<void> {
  const prefs = await readTelegramPrefs(userId);
  if (!prefs.enabled || !prefs.botToken || !prefs.chatId) return;
  const parseMode = opts.parseMode ?? 'HTML';
  try {
    await fetch(`https://api.telegram.org/bot${prefs.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: prefs.chatId,
        text: htmlText,
        ...(parseMode !== 'none' ? { parse_mode: parseMode } : {}),
        disable_web_page_preview: true,
      }),
    });
  } catch { /* tolerate — notifications must never break the call site */ }
}

/** Telegram Bot API caps document uploads at 50 MB; we keep a 1 MB
 *  safety margin so a multipart boundary + caption can't push us
 *  over and reject the whole upload at the server boundary. */
const TG_DOC_LIMIT_BYTES = 49 * 1024 * 1024;

/** Send a binary blob as a Telegram document (with optional caption).
 *
 *  Returns true if the upload succeeded — caller can use the boolean
 *  to decide whether to fall back to a text-only notice (e.g. when
 *  the file is too big or the user hasn't configured Telegram).
 *
 *  Used by save-offline so the user receives the just-mirrored PDF /
 *  audio file in chat alongside (actually: inside) the notification —
 *  one message per save rather than text-then-fetch-from-Drive.
 *  Videos larger than ~50 MB fail the size guard and the caller
 *  falls back to a plain notification. */
export async function sendTelegramDocument(
  userId: string,
  bytes: ArrayBuffer,
  filename: string,
  caption?: string,
): Promise<boolean> {
  const prefs = await readTelegramPrefs(userId);
  if (!prefs.enabled || !prefs.botToken || !prefs.chatId) return false;
  if (bytes.byteLength > TG_DOC_LIMIT_BYTES) return false;
  try {
    const fd = new FormData();
    fd.append('chat_id', prefs.chatId);
    fd.append('document', new Blob([bytes]), filename);
    if (caption) {
      fd.append('caption', caption);
      fd.append('parse_mode', 'HTML');
    }
    fd.append('disable_notification', 'false');
    const r = await fetch(`https://api.telegram.org/bot${prefs.botToken}/sendDocument`, {
      method: 'POST',
      body: fd,
    });
    return r.ok;
  } catch {
    return false;
  }
}
