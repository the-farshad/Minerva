/**
 * GET /api/papers/prior?ref=ARXIV:<id>|DOI:<id>&title=<seed_title>&limit=<n>
 *
 * Foundational papers behind a seed's related-papers set — the
 * Connected Papers "Prior Works" panel concept. For each paper in
 * the seed's Related set we tally how many of them cite a given
 * upstream work; the top-N most-cited upstream works (excluding
 * papers already in the set, and excluding the seed itself) are
 * the foundations the cohort draws from.
 *
 * Response:
 *   { papers: RelatedPaper[], provider: 'openalex' }
 *
 * Pure-OA path because the bibliographic-coupling math needs
 * referenced_works, which only OpenAlex returns per-paper for
 * free.
 */
import { NextRequest, NextResponse } from 'next/server';
import { parseRef } from '@/lib/related-papers/types';
import type { RelatedPaper } from '@/lib/related-papers/types';
import { fetchRelatedFromOpenAlex } from '@/lib/related-papers/openalex';
import { getCachedLookup, setCachedLookup } from '@/lib/paper-cache';

const TTL_SEC = 6 * 3600;
const MAILTO = 'minerva@thefarshad.com';

export const dynamic = 'force-dynamic';

type OAAuthorship = { author?: { display_name?: string } };
type OAWork = {
  id?: string;
  doi?: string | null;
  title?: string | null;
  authorships?: OAAuthorship[];
  publication_year?: number | null;
  open_access?: { oa_url?: string | null } | null;
  primary_location?: { source?: { display_name?: string | null } | null } | null;
  cited_by_count?: number | null;
};

function workToPaper(w: OAWork): RelatedPaper {
  const rawDoi = w.doi || '';
  const doi = rawDoi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '') || undefined;
  const arxivMatch = doi?.match(/^10\.48550\/arXiv\.(.+)$/i);
  return {
    paperId: (w.id || '').replace(/^https:\/\/openalex\.org\//, ''),
    externalIds: { DOI: doi, ArXiv: arxivMatch?.[1] },
    title: w.title || undefined,
    authors: (w.authorships || [])
      .map((a) => ({ name: a.author?.display_name || '' }))
      .filter((a) => a.name),
    year: w.publication_year ?? undefined,
    venue: w.primary_location?.source?.display_name || undefined,
    openAccessPdf: w.open_access?.oa_url ? { url: w.open_access.oa_url } : undefined,
    citationCount: typeof w.cited_by_count === 'number' ? w.cited_by_count : undefined,
  };
}

export async function GET(req: NextRequest) {
  const refParam = req.nextUrl.searchParams.get('ref');
  const title = req.nextUrl.searchParams.get('title');
  const limit = Math.min(20, Math.max(1, Number(req.nextUrl.searchParams.get('limit')) || 8));
  const ref = parseRef(refParam);
  if (!ref && !title) {
    return NextResponse.json({ error: '`ref` or `title` is required.' }, { status: 400 });
  }
  if (ref?.kind === 'TITLE_ONLY') {
    return NextResponse.json({ papers: [], provider: 'openalex' });
  }

  const cacheKey = `prior:${ref ? `${ref.kind}:${ref.id}` : `t:${(title || '').slice(0, 200)}`}:${limit}`;
  const cached = await getCachedLookup<{ papers: RelatedPaper[]; provider: string }>(cacheKey, TTL_SEC);
  if (cached) return NextResponse.json({ ...cached, cached: true });

  // Pull a wider related set than the user-facing list so the
  // foundation tally has more signal. The Related view itself
  // shows ~50; here we use 50 too and rely on OA's curated
  // related_works + cited-by union.
  const related = await fetchRelatedFromOpenAlex({
    ref: ref ?? null,
    title: title ?? null,
    limit: 50,
  });
  if (!related.ok) {
    return NextResponse.json(
      { error: related.error, papers: [], provider: 'openalex' },
      { status: related.status },
    );
  }
  // Tally cited works across the related set.
  const counts = new Map<string, number>();
  const inSet = new Set<string>();
  for (const p of related.papers) {
    if (p.paperId) inSet.add(p.paperId);
    for (const r of (p.referencedWorks || [])) counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  // Top-N most-referenced upstream works, excluding any paper
  // that's already in the related set itself.
  const topIds = [...counts.entries()]
    .filter(([id, c]) => c >= 2 && !inSet.has(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
  if (topIds.length === 0) {
    const body = { papers: [], provider: 'openalex' };
    await setCachedLookup(cacheKey, body);
    return NextResponse.json(body);
  }

  // Batch-fetch metadata for the top IDs. OpenAlex's pipe-OR
  // filter caps at 50; we're under that.
  const filterIds = topIds.map(([id]) => id).join('|');
  const fields = 'id,doi,title,authorships,publication_year,open_access,primary_location,cited_by_count';
  const url = `https://api.openalex.org/works?filter=ids.openalex:${encodeURIComponent(filterIds)}&per_page=${topIds.length}&select=${fields}&mailto=${encodeURIComponent(MAILTO)}`;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, next: { revalidate: 3600 } });
    if (!r.ok) {
      return NextResponse.json({ papers: [], provider: 'openalex', error: `OpenAlex: ${r.status}` });
    }
    const j = (await r.json()) as { results?: OAWork[] };
    // Preserve the count-descending order from our tally — OA's
    // result order isn't guaranteed to match the filter order.
    const byId = new Map<string, OAWork>();
    for (const w of j.results || []) {
      const wid = (w.id || '').replace(/^https:\/\/openalex\.org\//, '');
      if (wid) byId.set(wid, w);
    }
    const papers = topIds
      .map(([id, count]) => {
        const w = byId.get(id);
        if (!w) return null;
        const p = workToPaper(w);
        // Stash the in-cohort cite count on a custom field so the
        // UI can show "cited by N of the cohort".
        (p as RelatedPaper & { cohortCites?: number }).cohortCites = count;
        return p;
      })
      .filter((p): p is RelatedPaper => !!p && !!p.title);

    const body = { papers, provider: 'openalex' };
    await setCachedLookup(cacheKey, body);
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json({ papers: [], provider: 'openalex', error: (e as Error).message }, { status: 502 });
  }
}
