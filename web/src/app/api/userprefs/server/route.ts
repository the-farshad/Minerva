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
import { bus } from '@/lib/event-bus';

const ALLOWED_KEYS = new Set([
  'youtube_api_key',
  /** Default video quality for save-offline. One of:
   *   'best' | '1080' | '720' | '480' | '360' | 'audio'
   * Translates to a yt-dlp format string in the helper. */
  'yt_quality',
  /** Connected-papers backend. One of:
   *   'openalex'        — default, no API key needed
   *   'semanticscholar' — uses SEMANTIC_SCHOLAR_API_KEY env var
   * Translates to a dispatch in /api/related-papers. */
  'related_papers_provider',
]);

/** Keys whose actual value is safe to return to the browser. The
 * API-key shaped keys stay opaque (just a boolean "is set"); config
 * shaped ones like yt_quality need to round-trip their value so the
 * Settings UI can show the current selection. */
const VALUE_VISIBLE_KEYS = new Set([
  'yt_quality',
  'related_papers_provider',
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
  bus.emit(userId, { kind: 'userprefs.changed' });
  return NextResponse.json({ ok: true, key, set: value !== null && value !== '' });
}

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const present = new Set(await listServerPrefKeys(userId));
  const status: Record<string, boolean> = {};
  const values: Record<string, string> = {};
  for (const key of ALLOWED_KEYS) {
    status[key] = present.has(key);
    if (VALUE_VISIBLE_KEYS.has(key) && present.has(key)) {
      const v = await getServerPref<string>(userId, key);
      if (v) values[key] = v;
    }
  }
  return NextResponse.json({ ...status, _values: values });
}
