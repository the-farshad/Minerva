/**
 * Reset a paper's working PDF back to the pristine original that
 * `save-annotations` snapshotted on the first edit.
 *
 *   POST /api/sections/<slug>/rows/<id>/reset-pdf
 *
 * Reads `row.data.originalFileId`, downloads its bytes, then PATCHes
 * the working Drive file (the one the offline marker points at) in
 * place. The user keeps the same fileId / offline marker; only the
 * bytes change. The backup file stays on Drive so a future re-reset
 * is still possible.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, schema } from '@/db';
import { eq, and } from 'drizzle-orm';
import { fetchDriveFileBytes, updateDriveFileMedia } from '@/lib/drive';

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ slug: string; id: string }> },
) {
  try {
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
    const originalFileId = data.originalFileId ? String(data.originalFileId) : '';
    if (!originalFileId) {
      return NextResponse.json(
        { error: 'No original snapshot for this paper — nothing to reset to.' },
        { status: 409 },
      );
    }
    const offline = String(data.offline || '');
    const drive = offline.match(/drive:([\w-]{20,})/);
    if (!drive) {
      return NextResponse.json({ error: 'Row has no working Drive copy.' }, { status: 409 });
    }
    const workingId = drive[1];

    const orig = await fetchDriveFileBytes(userId, originalFileId);
    await updateDriveFileMedia(userId, workingId, orig.bytes, orig.mime || 'application/pdf');

    return NextResponse.json({ fileId: workingId });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
