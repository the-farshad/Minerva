/**
 *   GET  /api/feeds          — returns current iCal + RSS URLs.
 *   POST /api/feeds/rotate   — issues a fresh token (invalidates old URLs).
 *
 * Session-auth gated. The token itself is the bearer for the feed
 * endpoints (subscribed by URL) — keep it private; treat the URL
 * like a password.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getOrCreateFeedToken } from '@/lib/feed-token';

function urls(req: NextRequest, token: string) {
  const origin = req.nextUrl.origin;
  return {
    ical: `${origin}/api/ical/${token}.ics`,
    rss:  `${origin}/api/rss/${token}.xml`,
    inbox: `${origin}/api/inbox?token=${token}`,
  };
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const token = await getOrCreateFeedToken(userId);
  return NextResponse.json({ token, ...urls(req, token) });
}
