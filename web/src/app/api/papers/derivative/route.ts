/**
 * GET /api/papers/derivative?ref=ARXIV:<id>|DOI:<id>&title=<seed_title>&limit=<n>
 *
 * High-impact downstream papers — the Connected Papers "Derivative
 * Works" concept. Returns the top-N most-cited papers that cite
 * the seed, sorted by their own citation count. Differs from the
 * Cited-by tab in that it's filtered to high-impact citers (a
 * single-query OpenAlex shortcut: filter=cites:<seedId> &
 * sort=cited_by_count:desc).
 *
 * Response:
 *   { papers: RelatedPaper[], provider: 'openalex' }
 */
import { NextRequest, NextResponse } from 'next/server';
import { parseRef } from '@/lib/related-papers/types';
import type { RelatedPaper } from '@/lib/related-papers/types';
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

async function resolveSeedId(ref: { kind: 'ARXIV' | 'DOI'; id: string }, title: string | null): Promise<string | null> {
  // Mirror the strategy in openalex.ts edges: DOI / arXiv-DOI shape,
  // fall back to title search for older arXiv papers whose DOI
  // isn't minted in OpenAlex.
  const tryDoi = ref.kind === 'DOI' ? ref.id : `10.48550/arXiv.${ref.id}`;
  const r = await fetch(`https://api.openalex.org/works/doi:${encodeURIComponent(tryDoi)}?select=id&mailto=${encodeURIComponent(MAILTO)}`);
  if (r.ok) {
    const j = (await r.json()) as { id?: string };
    const id = (j.id || '').replace(/^https:\/\/openalex\.org\//, '');
    if (id) return id;
  }
  if (title) {
    const tr = await fetch(`https://api.openalex.org/works?search=${encodeURIComponent(title)}&per_page=1&select=id&mailto=${encodeURIComponent(MAILTO)}`);
    if (tr.ok) {
      const tj = (await tr.json()) as { results?: { id?: string }[] };
      const id = (tj.results?.[0]?.id || '').replace(/^https:\/\/openalex\.org\//, '');
      if (id) return id;
    }
  }
  return null;
}

export async function GET(req: NextRequest) {
  const refParam = req.nextUrl.searchParams.get('ref');
  const title = req.nextUrl.searchParams.get('title');
  const limit = Math.min(20, Math.max(1, Number(req.nextUrl.searchParams.get('limit')) || 8));
  const ref = parseRef(refParam);
  if (!ref) return NextResponse.json({ error: '`ref` is required.' }, { status: 400 });
  if (ref.kind === 'TITLE_ONLY') return NextResponse.json({ papers: [], provider: 'openalex' });

  const cacheKey = `derivative:${ref.kind}:${ref.id}:${limit}`;
  const cached = await getCachedLookup<{ papers: RelatedPaper[]; provider: string }>(cacheKey, TTL_SEC);
  if (cached) return NextResponse.json({ ...cached, cached: true });

  const seedId = await resolveSeedId(ref, title);
  if (!seedId) {
    return NextResponse.json({ papers: [], provider: 'openalex', error: 'Seed not in OpenAlex.' });
  }
  const fields = 'id,doi,title,authorships,publication_year,open_access,primary_location,cited_by_count';
  const url = `https://api.openalex.org/works?filter=cites:${encodeURIComponent(seedId)}&sort=cited_by_count:desc&per_page=${limit}&select=${fields}&mailto=${encodeURIComponent(MAILTO)}`;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, next: { revalidate: 3600 } });
    if (!r.ok) {
      return NextResponse.json({ papers: [], provider: 'openalex', error: `OpenAlex: ${r.status}` });
    }
    const j = (await r.json()) as { results?: OAWork[] };
    const papers = (j.results || [])
      .map(workToPaper)
      .filter((p) => p.title);
    const body = { papers, provider: 'openalex' };
    await setCachedLookup(cacheKey, body);
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json({ papers: [], provider: 'openalex', error: (e as Error).message }, { status: 502 });
  }
}
