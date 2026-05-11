/**
 * Save an annotated PDF back to the row's existing Drive file in
 * place, preserving the offline marker / fileId so the SPA never
 * accumulates orphan "v1, v2, …" copies.
 *
 *   POST /api/sections/<slug>/rows/<id>/save-annotations
 *   multipart/form-data: file (annotated PDF blob)
 *
 * First annotation save: copy the current Drive file to
 * `<title>.original.pdf` (stored at `row.data.originalFileId`) so a
 * future "Reset to original" can restore the pristine PDF.
 * Subsequent saves just overwrite the working file's bytes.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, schema } from '@/db';
import { eq, and } from 'drizzle-orm';
import {
  updateDriveFileMedia,
  copyDriveFile,
  ensureMinervaFolder,
  ensureFolder,
  DRIVE_SUBFOLDERS,
} from '@/lib/drive';

export async function POST(
  req: NextRequest,
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

    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: 'Missing file' }, { status: 400 });
    }
    const bytes = await file.arrayBuffer();

    const data = { ...(row.data as Record<string, unknown>) } as Record<string, unknown>;
    const offline = String(data.offline || '');
    const driveMatch = offline.match(/drive:([\w-]{20,})/);
    if (!driveMatch) {
      return NextResponse.json(
        { error: 'No Drive copy on this row yet — Save offline first.' },
        { status: 409 },
      );
    }
    const workingId = driveMatch[1];

    // First-time annotation: snapshot the original before we
    // overwrite anything. Quietly tolerate failure here — losing the
    // backup is annoying but should not block the save itself.
    if (!data.originalFileId) {
      try {
        const title = String(data.title || data.name || 'paper')
          .replace(/[^\w.\- ]+/g, '_')
          .slice(0, 100);
        const root = await ensureMinervaFolder(userId);
        const parent = await ensureFolder(userId, DRIVE_SUBFOLDERS.paper, root);
        const copy = await copyDriveFile(
          userId,
          workingId,
          `${title}.original.pdf`,
          parent,
        );
        data.originalFileId = copy.id;
      } catch (e) {
        console.warn('[save-annotations] backup copy failed:', (e as Error).message);
      }
    }

    await updateDriveFileMedia(userId, workingId, bytes, 'application/pdf');

    await db.update(schema.rows)
      .set({ data, updatedAt: new Date() })
      .where(eq(schema.rows.id, id));

    return NextResponse.json({
      fileId: workingId,
      originalFileId: data.originalFileId ?? null,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
