/**
 * Upload a local MP4 file as a video row's offline copy. Covers two
 * flows in one route:
 *
 *   - Create a new row from an uploaded file. Filename → title;
 *     optional `playlist` form field → row's playlist column. Useful
 *     when yt-dlp can't reach a video (bot wall, age gate, region
 *     lock) and the user downloaded it on their own machine.
 *
 *   - Attach to an EXISTING row whose Save-offline never worked.
 *     Pass `rowId`; we upload bytes to Drive and PATCH the row's
 *     `offline` marker.
 *
 *   POST /api/sections/<slug>/upload-video
 *     multipart/form-data:
 *       file:     the .mp4 blob (required)
 *       rowId:    existing row id to attach to (optional)
 *       playlist: playlist name to set on the new row (optional)
 *       title:    override the title derived from filename (optional)
 *
 * The route is YouTube-section-only — papers have their own
 * upload-paper flow with PDF metadata extraction.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, schema } from '@/db';
import { eq, and } from 'drizzle-orm';
import { uploadToMinervaDrive, DRIVE_SUBFOLDERS } from '@/lib/drive';

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = (session.user as { id: string }).id;
    const { slug } = await ctx.params;

    const sec = await db.query.sections.findFirst({
      where: and(eq(schema.sections.userId, userId), eq(schema.sections.slug, slug)),
    });
    if (!sec) return NextResponse.json({ error: 'Section not found' }, { status: 404 });
    if (sec.preset !== 'youtube') {
      return NextResponse.json({ error: 'upload-video only works in YouTube-preset sections.' }, { status: 400 });
    }

    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: 'Missing file part.' }, { status: 400 });
    }
    const filename = (file as File).name || 'video.mp4';
    const rowId = String(form.get('rowId') || '').trim();
    const playlist = String(form.get('playlist') || '').trim();
    const title = String(form.get('title') || '').trim();

    const mime = file.type || 'video/mp4';
    const ab = await file.arrayBuffer();
    // Sanity-check: real MP4s start with `....ftyp` at offset 4. We
    // don't want to upload an HTML "video unavailable" page that the
    // user accidentally saved with a .mp4 extension.
    const head = new Uint8Array(ab.slice(0, 12));
    const headMagic = String.fromCharCode(...head.slice(4, 8));
    if (headMagic !== 'ftyp' && ab.byteLength < 64 * 1024) {
      return NextResponse.json({ error: 'File does not look like a valid MP4 (no `ftyp` box).' }, { status: 400 });
    }

    // Attach-to-existing-row pathway: load the row first so we can
    // mirror its `title` + `playlist` into the Drive filename /
    // folder. New-row pathway uses the form fields directly.
    let existingRow: typeof schema.rows.$inferSelect | undefined;
    if (rowId) {
      existingRow = await db.query.rows.findFirst({
        where: and(
          eq(schema.rows.userId, userId),
          eq(schema.rows.sectionId, sec.id),
          eq(schema.rows.id, rowId),
        ),
      });
      if (!existingRow) return NextResponse.json({ error: 'Row not found.' }, { status: 404 });
    }
    const existingData = (existingRow?.data as Record<string, unknown>) || {};
    const titleFromName = filename.replace(/\.(mp4|mov|mkv|webm|avi)$/i, '').replace(/[_\-]+/g, ' ').trim();
    const ext = (filename.match(/\.([a-z0-9]{2,4})$/i)?.[1] || 'mp4').toLowerCase();
    const effectiveTitle = (title || String(existingData.title || '') || titleFromName || 'video').toString();
    const cleanLeaf = `${effectiveTitle.replace(/[^\w.\- ]+/g, '_').slice(0, 100)}.${ext}`;
    const effectivePlaylist = (playlist || String(existingData.playlist || '') || '').trim().replace(/[/\\]+/g, '_').slice(0, 80);
    const folderPath: string[] = [DRIVE_SUBFOLDERS.video];
    if (effectivePlaylist) folderPath.push(effectivePlaylist);
    const up = await uploadToMinervaDrive(userId, ab, cleanLeaf, mime, folderPath);

    if (rowId && existingRow) {
      const row = existingRow;
      const data = row.data as Record<string, unknown>;
      const prevOffline = String(data.offline || '').trim();
      const parts = prevOffline ? prevOffline.split(' · ').filter(Boolean) : [];
      const without = parts.filter((p) => !p.startsWith('drive:'));
      without.push(`drive:${up.id}`);
      const nextData: Record<string, unknown> = { ...data, offline: without.join(' · ') };
      const [updated] = await db.update(schema.rows)
        .set({ data: nextData, updatedAt: new Date() })
        .where(eq(schema.rows.id, rowId))
        .returning();
      return NextResponse.json({
        attached: true,
        fileId: up.id,
        id: updated.id,
        data: updated.data,
        updatedAt: updated.updatedAt.toISOString(),
      });
    }

    // Otherwise: create a new row. `effectiveTitle` was already
    // computed above for the Drive filename; reuse it so the row's
    // title matches the file's name on Drive.
    const allowed = new Set(((sec.schema as { headers?: string[] }).headers) || []);
    const data: Record<string, unknown> = {};
    if (allowed.has('title')) data.title = effectiveTitle;
    if (allowed.has('offline')) data.offline = `drive:${up.id}`;
    if (allowed.has('playlist') && playlist) data.playlist = playlist;
    const [row] = await db.insert(schema.rows).values({
      userId, sectionId: sec.id, data,
    }).returning();
    return NextResponse.json({
      attached: false,
      fileId: up.id,
      id: row.id,
      data: row.data,
      updatedAt: row.updatedAt.toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
