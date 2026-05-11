/**
 *   GET  /api/telegram         — read current prefs (token hidden).
 *   POST /api/telegram         — save prefs.
 *   POST /api/telegram/test    — send a test message.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { readTelegramPrefs, writeTelegramPrefs, notifyTelegram } from '@/lib/telegram';

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const prefs = await readTelegramPrefs(userId);
  // Don't ship the bot token back to the client; just the suffix.
  const masked = prefs.botToken ? `…${prefs.botToken.slice(-6)}` : '';
  return NextResponse.json({
    chatId: prefs.chatId || '',
    enabled: !!prefs.enabled,
    hasToken: !!prefs.botToken,
    tokenSuffix: masked,
  });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const body = (await req.json()) as { botToken?: string; chatId?: string; enabled?: boolean };
  const patch: Record<string, unknown> = {};
  if (typeof body.chatId === 'string') patch.chatId = body.chatId.trim();
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
  if (typeof body.botToken === 'string' && body.botToken.trim()) patch.botToken = body.botToken.trim();
  await writeTelegramPrefs(userId, patch);
  return NextResponse.json({ ok: true });
}
