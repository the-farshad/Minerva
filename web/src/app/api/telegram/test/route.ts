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
  // Send the test in the same parse_mode notifyTelegram uses
  // (HTML) so a successful test guarantees the live notification
  // path works too. Previously the test used no parse_mode and
  // therefore couldn't catch Markdown / HTML parse failures.
  const r = await fetch(`https://api.telegram.org/bot${prefs.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: prefs.chatId,
      text: '<b>Minerva test</b> ✓\nIf you got this, the live <i>row → offline / inbox</i> notifications will arrive too.',
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    return NextResponse.json({ error: `Telegram ${r.status}: ${text.slice(0, 300)}` }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
