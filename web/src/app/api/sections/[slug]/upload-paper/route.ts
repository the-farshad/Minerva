/**
 * Upload a PDF and create a Papers row in one round-trip.
 *
 *   POST /api/sections/<slug>/upload-paper   (multipart: file)
 *
 * Flow:
 *   1. Stream the PDF bytes to the user's Drive in `papers/`.
 *   2. Pull whatever metadata is embedded in the PDF header
 *      (Title / Author / CreationDate). PDF metadata is plain ASCII
 *      in the first few KB so a tiny regex is enough — no extra
 *      dependency.
 *   3. Insert a row with the extracted title (falling back to the
 *      filename), authors, year, and offline=drive:<fileId>.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, schema } from '@/db';
import { eq, and } from 'drizzle-orm';
import { uploadToMinervaDrive, paperFolderSegments, syncPaperShortcuts } from '@/lib/drive';
import { extractPdfMeta } from '@/lib/pdf-meta';
import { bus } from '@/lib/event-bus';

// extractPdfMeta lives in src/lib/pdf-meta.ts so the
// refresh-metadata route can reuse the same parser when
// backfilling DOI on existing papers.

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

    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof Blob)) return NextResponse.json({ error: 'Missing file' }, { status: 400 });
    const name = (file as File).name?.replace(/\.pdf$/i, '').replace(/[_\-]+/g, ' ').trim() || 'paper';

    // Optional category passed alongside the file — lets a
    // future Add-with-category dialog (or AddByUrl) seed the
    // Drive folder at create time. When absent, paperFolderSegments
    // falls back to flat `papers/`.
    const categoryHint = String(form.get('category') || '').trim();
    const ab = await file.arrayBuffer();
    const meta = extractPdfMeta(new Uint8Array(ab));

    const driveFilename = (meta.title || name).replace(/[^\w.\- ]+/g, '_').slice(0, 100) + '.pdf';
    const up = await uploadToMinervaDrive(
      userId, ab,
      driveFilename,
      'application/pdf',
      paperFolderSegments({ category: categoryHint }),
    );

    const allowed = new Set(((sec.schema as { headers?: string[] }).headers) || []);
    const data: Record<string, unknown> = {};
    const set = (k: string, v: string | undefined) => {
      if (v && allowed.has(k)) data[k] = v;
    };
    set('title', meta.title || name);
    set('authors', meta.authors);
    set('year', meta.year);
    set('doi', meta.doi);
    // PDF page count → used by the reading-time badge + the per-
    // group and per-section reading-time totals. Stored even when
    // the schema doesn't list a 'pages' column (it's read straight
    // off row.data by readingMinutes()), so this never hits the
    // schema-allowed-headers filter.
    if (meta.pages && meta.pages > 0) data.pages = meta.pages;
    if (categoryHint) set('category', categoryHint);
    if (allowed.has('offline')) data.offline = `drive:${up.id}`;
    if (allowed.has('url')) data.url = `https://drive.google.com/file/d/${up.id}/view`;

    // Multi-category papers: the real PDF lives in the primary
    // category folder; every other category gets a Drive shortcut
    // pointing at the same file. Shortcut IDs are recorded on
    // row.data._shortcuts so a later delete / rewrite-tag can keep
    // them in step with the row's current category list.
    const cats = categoryHint.split(',').map((c) => c.trim()).filter(Boolean);
    if (cats.length > 1) {
      try {
        const shortcuts = await syncPaperShortcuts(userId, up.id, driveFilename, cats[0], cats, {});
        if (Object.keys(shortcuts).length > 0) data._shortcuts = shortcuts;
      } catch (e) {
        console.warn('[upload-paper] shortcuts:', (e as Error).message);
      }
    }

    const [row] = await db.insert(schema.rows).values({
      userId, sectionId: sec.id, data,
    }).returning();
    bus.emit(userId, { kind: 'row.created', sectionSlug: sec.slug, rowId: row.id, data: row.data as Record<string, unknown> });

    return NextResponse.json({
      id: row.id,
      data: row.data,
      updatedAt: row.updatedAt.toISOString(),
      fileId: up.id,
      extracted: meta,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
