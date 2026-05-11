/**
 * RSS 2.0 feed of recent rows across the user's enabled sections.
 *
 *   GET /api/rss/<token>.xml
 */
import { NextRequest } from 'next/server';
import { eq, and, desc } from 'drizzle-orm';
import { db, schema } from '@/db';
import { userIdFromFeedToken } from '@/lib/feed-token';

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;
  const raw = token.replace(/\.xml$/, '');
  const userId = await userIdFromFeedToken(raw);
  if (!userId) return new Response('Forbidden', { status: 403 });

  const sections = await db.query.sections.findMany({
    where: and(eq(schema.sections.userId, userId), eq(schema.sections.enabled, true)),
  });
  const rows = await db.query.rows.findMany({
    where: and(eq(schema.rows.userId, userId), eq(schema.rows.deleted, false)),
    orderBy: [desc(schema.rows.updatedAt)],
    limit: 60,
  });
  const sectionById = new Map(sections.map((s) => [s.id, s]));

  const env = process.env.NEXTAUTH_URL?.replace(/\/+$/, '');
  const proto = req.headers.get('x-forwarded-proto') || 'https';
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
  const origin = env || (host ? `${proto}://${host}` : req.nextUrl.origin);
  const items = rows
    .map((r) => {
      const s = sectionById.get(r.sectionId);
      if (!s) return '';
      const data = r.data as Record<string, unknown>;
      const title = String(data.title || data.name || `${s.title} item`);
      const url = typeof data.url === 'string' && data.url
        ? data.url
        : `${origin}/s/${encodeURIComponent(s.slug)}`;
      const body = String(data.notes || data.body || data.summary || '');
      const pub = new Date(r.updatedAt).toUTCString();
      return `<item>
  <guid isPermaLink="false">${esc(r.id)}</guid>
  <title>${esc(`[${s.title}] ${title}`)}</title>
  <link>${esc(url)}</link>
  <pubDate>${pub}</pubDate>
  <description>${esc(body)}</description>
</item>`;
    })
    .filter(Boolean)
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>Minerva</title>
  <link>${origin}</link>
  <description>Recent activity</description>
  ${items}
</channel>
</rss>`;
  return new Response(xml, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'private, max-age=120',
    },
  });
}
