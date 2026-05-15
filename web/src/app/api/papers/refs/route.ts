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
import { fetchPaperEdgesFromOpenCitations } from '@/lib/related-papers/opencitations';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const rowId = req.nextUrl.searchParams.get('rowId');
  // Auth is required only for the rowId path (it reads a user-
  // scoped row from the DB). The ref-only path is fully public —
  // SS / OC citation data is freely available from upstream, and
  // lit.thefarshad.com's stateless explorer needs it without
  // signing the visitor in.
  let userId = '';
  if (rowId) {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    userId = (session.user as { id: string }).id;
  }

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

  // OpenCitations fallback. Two real cases drop here:
  //   1. Semantic Scholar returned 200-ok but zero papers — common
  //      for older papers Crossref-indexed but absent from SS's
  //      similarity graph.
  //   2. SS errored on a transient (rate-limit, network).
  // OpenCitations is DOI-only, so arXiv-id-only lookups can't
  // fall back; in that case we surface the SS result as-is.
  const tryOpenCitations = ref.kind === 'DOI'
    && ((result.ok && result.papers.length === 0) || (!result.ok && result.status !== 404));
  if (tryOpenCitations) {
    const oc = await fetchPaperEdgesFromOpenCitations(ref, { direction, limit });
    if (oc.ok && oc.papers.length > 0) {
      return NextResponse.json({
        papers: oc.papers,
        ref: `${ref.kind}:${ref.id}`,
        direction,
        provider: 'opencitations',
      });
    }
  }

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
    provider: 'semanticscholar',
  });
}
