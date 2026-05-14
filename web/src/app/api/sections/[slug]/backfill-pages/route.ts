/**
 * One-shot backfill of PDF page counts for a Papers section.
 *
 *   POST /api/sections/<slug>/backfill-pages
 *
 * Page-count extraction only happens going forward (on upload-paper
 * / save-offline). Papers mirrored to Drive *before* that landed
 * have no `data.pages`, so their reading-time estimate is blank.
 * This route walks every paper row in the section that:
 *   - has no `data.pages` yet, AND
 *   - carries a `drive:<fileId>` offline marker
 * fetches the PDF bytes from Drive, extracts the page count, and
 * patches the row. Capped + sequential so a large library doesn't
 * hammer Drive or blow the request timeout — the response reports
 * how many were processed so the client can call again to
 * continue.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, schema } from '@/db';
import { eq, and } from 'drizzle-orm';
import { fetchDriveFileBytes } from '@/lib/drive';
import { extractPdfMeta } from '@/lib/pdf-meta';
import { bus } from '@/lib/event-bus';

export const dynamic = 'force-dynamic';

// Cap per call so a 500-paper library doesn't exceed the route
// timeout. The client re-invokes until `remaining` hits 0.
const BATCH_CAP = 25;

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const { slug } = await ctx.params;

  const sec = await db.query.sections.findFirst({
    where: and(eq(schema.sections.userId, userId), eq(schema.sections.slug, slug)),
  });
  if (!sec) return NextResponse.json({ error: 'Section not found' }, { status: 404 });

  const rows = await db.query.rows.findMany({
    where: and(
      eq(schema.rows.userId, userId),
      eq(schema.rows.sectionId, sec.id),
      eq(schema.rows.deleted, false),
    ),
  });

  // Candidate = paper row, no page count yet, has a Drive copy.
  const candidates = rows.filter((r) => {
    const d = r.data as Record<string, unknown>;
    if (d.pages) return false;
    return /drive:[\w-]{20,}/.test(String(d.offline || ''));
  });
  const batch = candidates.slice(0, BATCH_CAP);

  let updated = 0;
  let failed = 0;
  for (const row of batch) {
    const d = row.data as Record<string, unknown>;
    const m = String(d.offline || '').match(/drive:([\w-]{20,})/);
    if (!m) { failed += 1; continue; }
    try {
      const { bytes } = await fetchDriveFileBytes(userId, m[1]);
      const meta = extractPdfMeta(new Uint8Array(bytes));
      if (meta.pages && meta.pages > 0) {
        const nextData = { ...d, pages: meta.pages };
        await db.update(schema.rows)
          .set({ data: nextData, updatedAt: new Date() })
          .where(eq(schema.rows.id, row.id));
        bus.emit(userId, {
          kind: 'row.updated',
          sectionSlug: slug,
          rowId: row.id,
          data: nextData,
        });
        updated += 1;
      } else {
        failed += 1;
      }
    } catch {
      // Drive 404 / network blip / un-parseable PDF — skip, the
      // row simply stays without a page count.
      failed += 1;
    }
  }

  return NextResponse.json({
    updated,
    failed,
    processed: batch.length,
    remaining: Math.max(0, candidates.length - batch.length),
  });
}
