/**
 * Bookmarklet drop-target. Accepts `?token=<feedToken>` plus a
 * `{ url, title }` JSON body, creates a row in the user's
 * "Inbox" section (auto-creating the section on first use).
 *
 *   POST /api/inbox?token=<feedToken>
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db, schema } from '@/db';
import { userIdFromFeedToken } from '@/lib/feed-token';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
} as const;

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token') || '';
  const userId = await userIdFromFeedToken(token);
  if (!userId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: CORS });
  }
  const body = (await req.json().catch(() => ({}))) as { url?: string; title?: string };
  const url = (body.url || '').trim();
  if (!url) return NextResponse.json({ error: 'Missing url' }, { status: 400, headers: CORS });

  let inbox = await db.query.sections.findFirst({
    where: and(eq(schema.sections.userId, userId), eq(schema.sections.slug, 'inbox')),
  });
  if (!inbox) {
    const [created] = await db.insert(schema.sections).values({
      userId,
      slug: 'inbox',
      title: 'Inbox',
      icon: 'inbox',
      schema: { headers: ['title', 'url', 'notes'], types: ['text', 'link', 'markdown'] },
      preset: 'inbox',
    }).returning();
    inbox = created;
  }

  const [created] = await db.insert(schema.rows).values({
    userId,
    sectionId: inbox.id,
    data: {
      title: (body.title || '').trim() || url,
      url,
      notes: '',
    },
  }).returning();
  return NextResponse.json({ ok: true, id: created.id }, { headers: CORS });
}
