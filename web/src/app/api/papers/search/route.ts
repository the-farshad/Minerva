/**
 * GET /api/papers/search?q=<query>&limit=<n>
 *
 * Public, unauthenticated keyword search over scholarly metadata.
 * Returns a ranked candidate list a UI can present as seeds to
 * explore. Backed by Semantic Scholar's paper/search; falls back to
 * OpenAlex /works?search on SS failure (including rate-limit) so the
 * endpoint stays usable on shared IPs.
 *
 * Boolean queries — those containing AND / OR / NOT, parens, or
 * "quoted phrases" — are routed straight to OpenAlex, which is the
 * only backend in the chain with documented boolean-operator
 * support. SS's paper/search is best-match free-text and silently
 * ignores boolean tokens.
 *
 * Response shape mirrors /api/papers/refs and /api/related-papers
 * (`{ papers: RelatedPaper[] }`) so the client reuses the same row
 * renderer for results.
 */
import { NextRequest, NextResponse } from 'next/server';
import { searchPapers } from '@/lib/related-papers/semanticscholar';
import type { RelatedPaper } from '@/lib/related-papers/types';

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 25;

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
    externalIds: {
      DOI: doi,
      ArXiv: arxivMatch?.[1],
    },
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

async function searchOpenAlex(query: string, limit: number): Promise<RelatedPaper[]> {
  const perPage = Math.min(50, Math.max(1, limit));
  const url =
    `https://api.openalex.org/works?search=${encodeURIComponent(query)}` +
    `&per_page=${perPage}` +
    `&select=id,doi,title,authorships,publication_year,open_access,primary_location,cited_by_count` +
    `&mailto=${encodeURIComponent('minerva@thefarshad.com')}`;
  const r = await fetch(url, { headers: { Accept: 'application/json' }, next: { revalidate: 300 } });
  if (!r.ok) return [];
  const j = (await r.json()) as { results?: OAWork[] };
  return (j.results || []).map(workToPaper).filter((p) => p.title);
}

// AND / OR / NOT as whole words, parens, or quoted phrases.
const BOOLEAN_RE = /\b(AND|OR|NOT)\b|[()]|"[^"]+"/;

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get('q') || '').trim();
  if (!q) return NextResponse.json({ papers: [] });
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number(req.nextUrl.searchParams.get('limit')) || DEFAULT_LIMIT),
  );

  // Boolean queries skip SS (no operator support) and go straight
  // to OpenAlex. Plain-text queries take the SS-first path.
  const isBoolean = BOOLEAN_RE.test(q);
  if (isBoolean) {
    const oa = await searchOpenAlex(q, limit);
    return NextResponse.json({ papers: oa, provider: 'openalex', boolean: true });
  }

  const ss = await searchPapers(q, limit);
  if (ss.ok && ss.papers.length > 0) {
    return NextResponse.json({ papers: ss.papers, provider: 'semanticscholar' });
  }

  const oa = await searchOpenAlex(q, limit);
  if (oa.length > 0) {
    return NextResponse.json({ papers: oa, provider: 'openalex' });
  }

  if (!ss.ok) {
    return NextResponse.json(
      { error: ss.error, rateLimited: ss.rateLimited ?? false },
      { status: ss.status },
    );
  }
  return NextResponse.json({ papers: [], provider: 'semanticscholar' });
}
