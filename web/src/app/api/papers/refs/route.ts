/**
 * GET /api/papers/refs?rowId=<id>
 * GET /api/papers/refs?ref=ARXIV:<id>
 * GET /api/papers/refs?ref=DOI:<id>
 *
 * Returns the list of papers the given paper *cites* (its
 * reference list), pulled from Semantic Scholar. Auth-gated and
 * scoped to the signed-in user when looking up by rowId.
 *
 * Companion to /api/related-papers (which returns *related*
 * recommendations, not actual references) — both return the same
 * `RelatedPaper` shape so the UI reuses one card layout.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, schema } from '@/db';
import { eq, and } from 'drizzle-orm';
import { resolvePaperRef } from '@/lib/paper-ref';
import { parseRef } from '@/lib/related-papers/types';
import { fetchReferencesFromSS } from '@/lib/related-papers/semanticscholar';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = (session.user as { id: string }).id;

  const rowId = req.nextUrl.searchParams.get('rowId');
  const refParam = req.nextUrl.searchParams.get('ref');
  const limit = Math.min(
    1000,
    Math.max(1, Number(req.nextUrl.searchParams.get('limit')) || 100),
  );

  let ref = parseRef(refParam);

  // Row lookup path: resolve the paper ref from the row's `data`
  // (the same resolver the related-papers page uses). Scoped to
  // the signed-in user — no peeking at other users' rows.
  if (!ref && rowId) {
    const row = await db.query.rows.findFirst({
      where: and(
        eq(schema.rows.userId, userId),
        eq(schema.rows.id, rowId),
        eq(schema.rows.deleted, false),
      ),
    });
    if (!row) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const data = row.data as Record<string, unknown>;
    const seedRefStr = resolvePaperRef(data);
    ref = parseRef(seedRefStr);
  }

  if (!ref) {
    return NextResponse.json(
      { error: 'Pass `rowId` of a paper row, or `ref=ARXIV:<id>` / `ref=DOI:<id>`.' },
      { status: 400 },
    );
  }
  if (ref.kind === 'TITLE_ONLY') {
    return NextResponse.json(
      { error: 'A title alone is not enough — an arXiv id or DOI is required to look up references.' },
      { status: 400 },
    );
  }

  const result = await fetchReferencesFromSS(ref, limit);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, rateLimited: result.rateLimited ?? false },
      { status: result.status },
    );
  }
  return NextResponse.json({ papers: result.papers, ref: `${ref.kind}:${ref.id}` });
}
