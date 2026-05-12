/**
 * Server-only user prefs. The browser can POST keys here to set a
 * value, and GET only returns whether each key is set — never the
 * value itself. Used for secrets like YouTube Data API keys: the
 * server reads them when needed (e.g. to enrich metadata) but the
 * client never sees them again after the initial POST.
 *
 *   POST  /api/userprefs/server     { key: 'youtube_api_key', value: '…' }
 *                                   value: null   → unset
 *   GET   /api/userprefs/server     → { youtube_api_key: true | false, … }
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getServerPref, setServerPref, listServerPrefKeys } from '@/lib/server-prefs';

const ALLOWED_KEYS = new Set([
  'youtube_api_key',
]);

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const body = (await req.json().catch(() => ({}))) as { key?: string; value?: unknown };
  const key = String(body.key || '');
  if (!ALLOWED_KEYS.has(key)) {
    return NextResponse.json({ error: `Unknown key: ${key}` }, { status: 400 });
  }
  const value = body.value;
  if (value !== null && typeof value !== 'string') {
    return NextResponse.json({ error: 'Value must be a string or null' }, { status: 400 });
  }
  await setServerPref(userId, key, value);
  return NextResponse.json({ ok: true, key, set: value !== null && value !== '' });
}

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const present = new Set(await listServerPrefKeys(userId));
  const status: Record<string, boolean> = {};
  for (const key of ALLOWED_KEYS) status[key] = present.has(key);
  // Defence-in-depth: never return values, only booleans.
  void getServerPref; // imported but read-only here
  return NextResponse.json(status);
}
