/**
 * Strip the Drive-mirrored offline copy from a video / paper row.
 * Deletes every `drive:<fileId>` referenced by the row's offline
 * marker from the user's Drive, then clears the offline field
 * (host:<path> tokens are preserved — those are still on the
 * helper's disk).
 *
 *   POST /api/sections/<slug>/rows/<id>/remove-offline
 *   → { deleted: N, offline: '<remaining markers, if any>' }
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, schema } from '@/db';
import { eq, and } from 'drizzle-orm';
import { deleteDriveFile } from '@/lib/drive';

export async function POST(
  _req: NextRequest,
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

  const data = row.data as Record<string, unknown>;
  const offline = String(data.offline || '').trim();
  if (!offline) {
    return NextResponse.json({ deleted: 0, offline: '' });
  }
  // Pull every drive:<id> and delete from Drive in parallel. Quiet
  // on failure (file already gone, scope mismatch) — the row's
  // offline field still gets cleared regardless.
  const driveIds = Array.from(offline.matchAll(/drive:([\w-]{20,})/g)).map((m) => m[1]);
  let deleted = 0;
  await Promise.all(driveIds.map(async (fid) => {
    if (await deleteDriveFile(userId, fid)) deleted += 1;
  }));
  // Keep any host:<path> tokens — those live on the helper's disk
  // and are managed separately.
  const remaining = offline
    .split(' · ')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('drive:'))
    .join(' · ');
  // Also drop the snapshot / extracted markers that only made sense
  // alongside a Drive copy — keeps the row's data tidy.
  const nextData = { ...data, offline: remaining };
  if ('originalFileId' in nextData) delete nextData.originalFileId;
  const [updated] = await db.update(schema.rows)
    .set({ data: nextData, updatedAt: new Date() })
    .where(eq(schema.rows.id, id))
    .returning();
  return NextResponse.json({
    deleted,
    offline: remaining,
    id: updated.id,
    data: updated.data,
    updatedAt: updated.updatedAt.toISOString(),
  });
}
