/**
 * GET /api/papers/refs?rowId=<id>[&direction=references|citations]
 * GET /api/papers/refs?ref=ARXIV:<id>[&direction=…]
 * GET /api/papers/refs?ref=DOI:<id>[&direction=…]
 *
 * Returns one side of the paper's citation graph from Semantic
 * Scholar:
 *   direction=references  — papers the seed cites (default)
 *   direction=citations   — papers that cite the seed
 *
 * Auth-gated; rowId lookups are scoped to the signed-in user.
 * Returns the same `RelatedPaper` shape as /api/related-papers so
 * the frontend reuses one card layout.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, schema } from '@/db';
import { eq, and } from 'drizzle-orm';
import { resolvePaperRef } from '@/lib/paper-ref';
import { parseRef } from '@/lib/related-papers/types';
import { fetchPaperEdgesFromSS } from '@/lib/related-papers/semanticscholar';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = (session.user as { id: string }).id;

  const rowId = req.nextUrl.searchParams.get('rowId');
  const refParam = req.nextUrl.searchParams.get('ref');
  const direction =
    req.nextUrl.searchParams.get('direction') === 'citations' ? 'citations' : 'references';
  const limit = Math.min(
    1000,
    Math.max(1, Number(req.nextUrl.searchParams.get('limit')) || 100),
  );

  let ref = parseRef(refParam);

  // Row lookup path: resolve the paper ref from the row's `data`
  // (the same resolver the related-papers page uses). Scoped to
  // the signed-in user — no peeking at other users' rows.
  let rowLookedUp = false;
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
    rowLookedUp = true;
    const data = row.data as Record<string, unknown>;
    const seedRefStr = resolvePaperRef(data);
    ref = parseRef(seedRefStr);
  }

  if (!ref) {
    return NextResponse.json(
      {
        error: rowLookedUp
          ? 'This paper row has no arXiv id or DOI — add one in the Info pane and click Refresh, then try again.'
          : 'Pass `rowId` of a paper row, or `ref=ARXIV:<id>` / `ref=DOI:<id>`.',
      },
      { status: 400 },
    );
  }
  if (ref.kind === 'TITLE_ONLY') {
    return NextResponse.json(
      { error: 'A title alone is not enough — an arXiv id or DOI is required to look up references.' },
      { status: 400 },
    );
  }

  const result = await fetchPaperEdgesFromSS(ref, { direction, limit });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, rateLimited: result.rateLimited ?? false },
      { status: result.status },
    );
  }
  return NextResponse.json({
    papers: result.papers,
    ref: `${ref.kind}:${ref.id}`,
    direction,
  });
}
