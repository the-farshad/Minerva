/**
 * Connected-papers proxy over Semantic Scholar. Two-step
 * resolve so we tolerate rows that don't carry an arXiv ID /
 * DOI in their URL:
 *
 *   1. If `ref` (e.g. ARXIV:2401.12345 or DOI:10.x/y) is given
 *      AND it resolves on /paper/{id}, use it directly.
 *   2. Otherwise, if `title` is given, search SS for it and use
 *      the top match's `paperId` to call recommendations.
 *
 *   GET /api/related-papers?ref=ARXIV:2401.12345
 *   GET /api/related-papers?title=Attention+Is+All+You+Need
 *   GET /api/related-papers?ref=DOI:10.x/y&title=fallback
 *
 * Returns: { papers: [...], resolvedVia: 'ref' | 'title' }
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

async function getRecommendations(paperRef: string, limit: number) {
  const url = `https://api.semanticscholar.org/recommendations/v1/papers/forpaper/${encodeURIComponent(paperRef)}?limit=${limit}&fields=${encodeURIComponent(FIELDS)}`;
  const r = await fetch(url, {
    headers: { Accept: 'application/json' },
    next: { revalidate: 300 },
  });
  if (!r.ok) return { ok: false as const, status: r.status, text: await r.text().catch(() => '') };
  const j = (await r.json()) as { recommendedPapers?: unknown[] };
  return { ok: true as const, papers: j.recommendedPapers ?? [] };
}

async function searchByTitle(title: string): Promise<string | null> {
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(title)}&limit=1&fields=paperId,title`;
  try {
    const r = await fetch(url, {
      headers: { Accept: 'application/json' },
      next: { revalidate: 300 },
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { data?: { paperId?: string }[] };
    return j.data?.[0]?.paperId ?? null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const ref = req.nextUrl.searchParams.get('ref');
  const title = req.nextUrl.searchParams.get('title');
  if (!ref && !title) {
    return NextResponse.json({ error: '`ref` or `title` is required.' }, { status: 400 });
  }
  const limit = Math.min(50, Math.max(1, Number(req.nextUrl.searchParams.get('limit')) || 30));

  try {
    // Path 1: ref-first. If SS resolves it, we're done.
    if (ref) {
      const res = await getRecommendations(ref, limit);
      if (res.ok) return NextResponse.json({ papers: res.papers, resolvedVia: 'ref' });
      // 404 on a ref usually means "the paper isn't indexed under
      // this ID shape" — fall through to title search if we have
      // one. Other errors bubble up directly.
      if (res.status !== 404 && !title) {
        return NextResponse.json(
          { error: `Semantic Scholar returned ${res.status}${res.text ? `: ${res.text.slice(0, 200)}` : ''}` },
          { status: res.status },
        );
      }
    }
    // Path 2: title-search fallback. Look the paper up by title,
    // grab its canonical paperId, then ask for recommendations.
    if (title) {
      const paperId = await searchByTitle(title);
      if (!paperId) {
        return NextResponse.json(
          { error: `Couldn't find this paper in Semantic Scholar by title — try opening it via Add by URL with an arXiv / DOI link so we have a stable ID to recommend against.` },
          { status: 404 },
        );
      }
      const res = await getRecommendations(paperId, limit);
      if (res.ok) return NextResponse.json({ papers: res.papers, resolvedVia: 'title' });
      return NextResponse.json(
        { error: `Semantic Scholar returned ${res.status}${res.text ? `: ${res.text.slice(0, 200)}` : ''}` },
        { status: res.status },
      );
    }
    // ref-only path with non-404 already returned above; the
    // only remaining gap is ref=null which we caught earlier.
    return NextResponse.json({ error: 'Unable to resolve a paper reference.' }, { status: 404 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
