import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { rotateFeedToken } from '@/lib/feed-token';

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const token = await rotateFeedToken(userId);
  const origin = req.nextUrl.origin;
  return NextResponse.json({
    token,
    ical: `${origin}/api/ical/${token}.ics`,
    rss:  `${origin}/api/rss/${token}.xml`,
    inbox: `${origin}/api/inbox?token=${token}`,
  });
}
