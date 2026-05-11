import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { readTelegramPrefs } from '@/lib/telegram';

export async function POST() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const prefs = await readTelegramPrefs(userId);
  if (!prefs.botToken || !prefs.chatId) {
    return NextResponse.json({ error: 'Bot token and chat id required.' }, { status: 400 });
  }
  const r = await fetch(`https://api.telegram.org/bot${prefs.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: prefs.chatId, text: 'Minerva test ✓' }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    return NextResponse.json({ error: `Telegram ${r.status}: ${text.slice(0, 300)}` }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
