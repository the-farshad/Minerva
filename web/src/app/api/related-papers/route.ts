/**
 * Connected-papers proxy. Wraps Semantic Scholar's
 * recommendations endpoint so the client never has to know the
 * upstream shape and rate-limits aren't exposed to anonymous
 * traffic.
 *
 *   GET /api/related-papers?ref=arXiv:2401.12345&limit=30
 *   GET /api/related-papers?ref=DOI:10.1109/X.2024&limit=30
 *
 * `ref` accepts any identifier Semantic Scholar's
 * /paper/{paper_id} endpoint accepts (ARXIV:, DOI:, CorpusId:,
 * URL:, …). Returns:
 *
 *   { papers: [
 *       { paperId, externalIds:{DOI?,ArXiv?},
 *         title, authors:[{name}], year, abstract,
 *         openAccessPdf:{url}, venue }
 *     ] }
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';

export const dynamic = 'force-dynamic';

const FIELDS = [
  'externalIds',
  'title',
  'authors',
  'year',
  'abstract',
  'openAccessPdf',
  'venue',
].join(',');

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const ref = req.nextUrl.searchParams.get('ref');
  if (!ref) return NextResponse.json({ error: '`ref` is required (arXiv:<id> or DOI:<id>).' }, { status: 400 });
  const limit = Math.min(50, Math.max(1, Number(req.nextUrl.searchParams.get('limit')) || 30));

  const url = `https://api.semanticscholar.org/recommendations/v1/papers/forpaper/${encodeURIComponent(ref)}?limit=${limit}&fields=${encodeURIComponent(FIELDS)}`;
  try {
    const r = await fetch(url, {
      headers: { Accept: 'application/json' },
      // SS is well-behaved on cache; allow Next to memoize within
      // a request window so adjacent renders don't double-fetch.
      next: { revalidate: 300 },
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return NextResponse.json(
        { error: `Semantic Scholar returned ${r.status}${text ? `: ${text.slice(0, 200)}` : ''}` },
        { status: r.status },
      );
    }
    const j = (await r.json()) as { recommendedPapers?: unknown[] };
    return NextResponse.json({ papers: j.recommendedPapers ?? [] });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
