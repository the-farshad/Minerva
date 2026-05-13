/**
 * Resolve the configured bot's username via Telegram's getMe.
 * Used by the settings card to render a one-click
 * https://t.me/<username> link so users don't have to find the
 * bot in Telegram search manually.
 *
 *   GET /api/telegram/me
 */
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { readTelegramPrefs } from '@/lib/telegram';

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const prefs = await readTelegramPrefs(userId);
  if (!prefs.botToken) {
    return NextResponse.json({ error: 'Save the bot token first.' }, { status: 400 });
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${prefs.botToken}/getMe`);
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return NextResponse.json(
        { error: `Telegram ${r.status}: ${text.slice(0, 200)}` },
        { status: r.status === 401 ? 401 : 502 },
      );
    }
    const j = (await r.json()) as {
      ok?: boolean;
      result?: { id?: number; username?: string; first_name?: string };
    };
    if (!j.ok || !j.result?.username) {
      return NextResponse.json({ error: 'getMe returned no username — token might be wrong.' }, { status: 502 });
    }
    return NextResponse.json({
      username: j.result.username,
      firstName: j.result.first_name || '',
      id: j.result.id,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
