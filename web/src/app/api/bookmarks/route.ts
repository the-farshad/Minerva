/**
 * Per-URL bookmarks. The preview modal reads them when opening a
 * video / PDF and lets the user add new ones at the current
 * timestamp (or page) plus a markdown note.
 *
 *   GET  /api/bookmarks?url=<url>
 *   POST /api/bookmarks                { url, kind, ref, label?, note? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, schema } from '@/db';
import { eq, and, asc } from 'drizzle-orm';

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const url = req.nextUrl.searchParams.get('url');
  if (!url) return NextResponse.json({ error: 'Missing url' }, { status: 400 });

  const rows = await db.query.bookmarks.findMany({
    where: and(eq(schema.bookmarks.userId, userId), eq(schema.bookmarks.url, url)),
    orderBy: [asc(schema.bookmarks.ref)],
  });
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;

  const body = (await req.json().catch(() => ({}))) as {
    url?: string; kind?: 'video' | 'pdf'; ref?: number; label?: string; note?: string;
  };
  if (!body.url || (body.kind !== 'video' && body.kind !== 'pdf') || typeof body.ref !== 'number') {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }
  const [created] = await db.insert(schema.bookmarks).values({
    userId,
    url: body.url,
    kind: body.kind,
    ref: Math.max(0, Math.floor(body.ref)),
    label: (body.label || '').slice(0, 200),
    note: (body.note || '').slice(0, 5000),
  }).returning();
  return NextResponse.json(created);
}
