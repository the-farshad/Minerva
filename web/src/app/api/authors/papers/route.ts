/**
 * GET /api/authors/papers?q=<author name>&limit=<n>
 *
 * Public, unauthenticated. Resolves a free-text author name to the
 * most likely scholarly author and returns their paper list.
 *
 * Primary: Semantic Scholar — /author/search top hit → /author/{id}/papers.
 * Fallback: OpenAlex — /authors?search top hit → /works?filter=author.id.
 *
 * Response shape mirrors /api/papers/search:
 *   { papers: RelatedPaper[], provider, author: { id, name } }
 */
import { NextRequest, NextResponse } from 'next/server';
import type { RelatedPaper } from '@/lib/related-papers/types';

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

export const dynamic = 'force-dynamic';

const SS_FIELDS = [
  'externalIds',
  'title',
  'authors',
  'year',
  'abstract',
  'openAccessPdf',
  'venue',
  'citationCount',
  'influentialCitationCount',
].join(',');

function ssHeaders(): HeadersInit {
  const h: Record<string, string> = { Accept: 'application/json' };
  if (process.env.SEMANTIC_SCHOLAR_API_KEY) {
    h['x-api-key'] = process.env.SEMANTIC_SCHOLAR_API_KEY;
  }
  return h;
}

type SSAuthor = { authorId?: string; name?: string };

async function ssResolveAuthor(name: string): Promise<SSAuthor | null> {
  const url = `https://api.semanticscholar.org/graph/v1/author/search?query=${encodeURIComponent(name)}&limit=1&fields=name`;
  const r = await fetch(url, { headers: ssHeaders(), next: { revalidate: 300 } });
  if (!r.ok) return null;
  const j = (await r.json()) as { data?: SSAuthor[] };
  return j.data?.[0] ?? null;
}

async function ssAuthorPapers(authorId: string, limit: number, offset: number): Promise<RelatedPaper[] | null> {
  // SS's /author/papers endpoint has no `sort` parameter, so pull a
  // wider window than the caller asked for, then sort by citation
  // count client-side and slice the requested page out of it. SS
  // accepts `offset`; we forward it but ALSO pull `limit + offset`
  // worth of records so the client-side sort window covers every
  // paper that could land in the page after sorting.
  const fetchLimit = Math.min(500, Math.max(limit + offset, 100));
  const url =
    `https://api.semanticscholar.org/graph/v1/author/${encodeURIComponent(authorId)}/papers` +
    `?fields=${encodeURIComponent(SS_FIELDS)}&limit=${fetchLimit}&offset=0`;
  const r = await fetch(url, { headers: ssHeaders(), next: { revalidate: 1800 } });
  if (!r.ok) return null;
  const j = (await r.json()) as { data?: RelatedPaper[] };
  const papers = (j.data ?? [])
    .filter((p) => p.title)
    .sort((a, b) => (b.citationCount ?? -1) - (a.citationCount ?? -1))
    .slice(offset, offset + limit);
  return papers;
}

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

async function oaResolveAuthor(name: string): Promise<{ id: string; name: string } | null> {
  const url =
    `https://api.openalex.org/authors?search=${encodeURIComponent(name)}` +
    `&per_page=1&select=id,display_name&mailto=minerva@thefarshad.com`;
  const r = await fetch(url, { headers: { Accept: 'application/json' }, next: { revalidate: 300 } });
  if (!r.ok) return null;
  const j = (await r.json()) as { results?: { id?: string; display_name?: string }[] };
  const hit = j.results?.[0];
  if (!hit?.id) return null;
  const id = hit.id.replace(/^https:\/\/openalex\.org\//, '');
  return { id, name: hit.display_name || name };
}

async function oaAuthorPapers(authorId: string, limit: number, offset: number): Promise<RelatedPaper[]> {
  const perPage = Math.min(100, Math.max(1, limit));
  const page = Math.max(1, Math.floor(offset / perPage) + 1);
  const url =
    `https://api.openalex.org/works?filter=author.id:${encodeURIComponent(authorId)}` +
    `&sort=cited_by_count:desc&per_page=${perPage}&page=${page}` +
    `&select=id,doi,title,authorships,publication_year,open_access,primary_location,cited_by_count` +
    `&mailto=minerva@thefarshad.com`;
  const r = await fetch(url, { headers: { Accept: 'application/json' }, next: { revalidate: 1800 } });
  if (!r.ok) return [];
  const j = (await r.json()) as { results?: OAWork[] };
  return (j.results || []).map(workToPaper).filter((p) => p.title);
}

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get('q') || '').trim();
  if (!q) return NextResponse.json({ papers: [] });
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number(req.nextUrl.searchParams.get('limit')) || DEFAULT_LIMIT),
  );
  const offset = Math.max(0, Number(req.nextUrl.searchParams.get('offset')) || 0);

  // OpenAlex preferred: its /works endpoint sorts by cited_by_count
  // directly, so the response is the author's top-cited work without
  // a client-side rerank pass. Semantic Scholar is the fallback for
  // authors OpenAlex doesn't disambiguate confidently.
  const oaAuthor = await oaResolveAuthor(q);
  if (oaAuthor) {
    const papers = await oaAuthorPapers(oaAuthor.id, limit, offset);
    if (papers.length > 0) {
      return NextResponse.json({
        papers,
        provider: 'openalex',
        author: { id: oaAuthor.id, name: oaAuthor.name },
        hasMore: papers.length === limit,
      });
    }
  }

  const ssAuthor = await ssResolveAuthor(q);
  if (ssAuthor?.authorId) {
    const papers = await ssAuthorPapers(ssAuthor.authorId, limit, offset);
    if (papers && papers.length > 0) {
      return NextResponse.json({
        papers,
        provider: 'semanticscholar',
        author: { id: ssAuthor.authorId, name: ssAuthor.name || q },
        hasMore: papers.length === limit,
      });
    }
  }

  return NextResponse.json({ papers: [], author: { id: '', name: q }, hasMore: false });
}
