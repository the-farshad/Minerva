/**
 * Append an offline-location marker to a row without round-tripping
 * the whole `data` blob. Markers are space-dot-space joined inside
 * `data.offline`, e.g. `drive:<fileId> · local:videos/foo.mp4`.
 * A marker with the same prefix (`drive:`, `local:`, `host:`)
 * replaces any prior entry of that prefix.
 *
 *   POST /api/sections/<slug>/rows/<id>/mark-offline
 *     { marker: "local:videos/foo.mp4" }
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, schema } from '@/db';
import { eq, and } from 'drizzle-orm';

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string; id: string }> },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const { slug, id } = await ctx.params;

  const sec = await db.query.sections.findFirst({
    where: and(eq(schema.sections.userId, userId), eq(schema.sections.slug, slug)),
  });
  if (!sec) return NextResponse.json({ error: 'Section not found' }, { status: 404 });
  const row = await db.query.rows.findFirst({
    where: and(
      eq(schema.rows.userId, userId),
      eq(schema.rows.sectionId, sec.id),
      eq(schema.rows.id, id),
    ),
  });
  if (!row) return NextResponse.json({ error: 'Row not found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { marker?: string };
  const marker = (body.marker || '').trim();
  const m = marker.match(/^([a-z]+):/);
  if (!m) return NextResponse.json({ error: 'Bad marker' }, { status: 400 });
  const prefix = `${m[1]}:`;

  const data = row.data as Record<string, unknown>;
  const prev = String(data.offline || '').trim();
  const kept = (prev ? prev.split(' · ') : []).filter((p) => p && !p.startsWith(prefix));
  kept.push(marker);
  const nextData = { ...data, offline: kept.join(' · ') };
  await db.update(schema.rows)
    .set({ data: nextData, updatedAt: new Date() })
    .where(eq(schema.rows.id, row.id));
  return NextResponse.json({ ok: true, offline: nextData.offline });
}
