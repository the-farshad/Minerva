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

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

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

/** Field-targeted search prefixes (findpapers-style). When a query
 *  starts with one of these, route the rest of the string into the
 *  matching OpenAlex full-text filter so the match is restricted to
 *  that field. SS has no equivalent — those queries skip SS. */
const FIELD_PREFIX_RE = /^(title|abstract|author):\s*(.+)$/i;
const OA_FIELD_FILTER: Record<string, string> = {
  title: 'title.search',
  abstract: 'abstract.search',
  author: 'raw_author_name.search',
};

async function searchOpenAlex(
  query: string,
  limit: number,
  offset: number,
  field?: string,
): Promise<RelatedPaper[]> {
  const perPage = Math.min(100, Math.max(1, limit));
  // OpenAlex pages are 1-indexed; translate offset by dividing into
  // whole-page chunks. Callers asking for `offset` non-multiple of
  // `limit` will lose the in-page tail, but the /lit UI always
  // requests in `limit`-sized strides so this is fine.
  const page = Math.max(1, Math.floor(offset / perPage) + 1);
  const params = new URLSearchParams();
  // Field-targeted search uses a `filter=<field>.search:<query>`
  // clause instead of the generic `search=` param so the match is
  // restricted to that field. Falls back to a body-wide search when
  // no field was specified.
  if (field && OA_FIELD_FILTER[field]) {
    // Auto-phrase multi-word field-targeted queries. OpenAlex's
    // `filter=<field>.search:foo bar` treats whitespace as an
    // AND-of-terms — so a query like `abstract:retrieval augmented`
    // returns papers that mention both words anywhere, not the
    // phrase. Wrapping in quotes forces phrase matching, which is
    // what a field-targeted query nearly always wants. Skip the
    // wrap when the user supplied their own quotes, or when there's
    // only one term.
    const needsQuote = query.includes(' ') && !query.includes('"');
    const filterValue = needsQuote ? `"${query}"` : query;
    params.set('filter', `${OA_FIELD_FILTER[field]}:${filterValue}`);
  } else {
    params.set('search', query);
  }
  params.set('per_page', String(perPage));
  params.set('page', String(page));
  params.set('select', 'id,doi,title,authorships,publication_year,open_access,primary_location,cited_by_count');
  params.set('mailto', 'minerva@thefarshad.com');
  const r = await fetch(`https://api.openalex.org/works?${params.toString()}`, {
    headers: { Accept: 'application/json' },
    next: { revalidate: 300 },
  });
  if (!r.ok) return [];
  const j = (await r.json()) as { results?: OAWork[] };
  return (j.results || []).map(workToPaper).filter((p) => p.title);
}

// AND / OR / NOT as whole words, parens, or quoted phrases.
const BOOLEAN_RE = /\b(AND|OR|NOT)\b|[()]|"[^"]+"/;

/** Stable identity for a paper across providers — prefer DOI, then
 *  arXiv id, then a normalised title. Used to dedupe the merged
 *  multi-source result set. */
function dedupKey(p: RelatedPaper): string {
  const doi = p.externalIds?.DOI?.toLowerCase();
  if (doi) return `doi:${doi}`;
  const arxiv = p.externalIds?.ArXiv;
  if (arxiv) return `arxiv:${arxiv.toLowerCase()}`;
  const t = (p.title || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  return t ? `t:${t}` : `id:${p.paperId || Math.random().toString(36)}`;
}

/** Merge two ranked candidate lists. Items appear in the order they
 *  were first seen; later duplicates contribute any fields the
 *  earlier copy was missing (so DOI from OA can backfill a SS hit
 *  that only had arXiv, etc.). */
function mergeDedup(primary: RelatedPaper[], secondary: RelatedPaper[]): RelatedPaper[] {
  const seen = new Map<string, RelatedPaper>();
  const order: string[] = [];
  for (const p of primary) {
    const k = dedupKey(p);
    if (seen.has(k)) continue;
    seen.set(k, p);
    order.push(k);
  }
  for (const p of secondary) {
    const k = dedupKey(p);
    const existing = seen.get(k);
    if (!existing) {
      seen.set(k, p);
      order.push(k);
      continue;
    }
    // Backfill missing fields on the kept record.
    existing.externalIds = { ...p.externalIds, ...existing.externalIds };
    if (existing.citationCount == null && p.citationCount != null) existing.citationCount = p.citationCount;
    if (!existing.openAccessPdf?.url && p.openAccessPdf?.url) existing.openAccessPdf = p.openAccessPdf;
    if (!existing.abstract && p.abstract) existing.abstract = p.abstract;
    if (!existing.venue && p.venue) existing.venue = p.venue;
    if (!existing.year && p.year) existing.year = p.year;
  }
  return order.map((k) => seen.get(k)!);
}

export async function GET(req: NextRequest) {
  const qRaw = (req.nextUrl.searchParams.get('q') || '').trim();
  if (!qRaw) return NextResponse.json({ papers: [] });
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number(req.nextUrl.searchParams.get('limit')) || DEFAULT_LIMIT),
  );
  const offset = Math.max(0, Number(req.nextUrl.searchParams.get('offset')) || 0);

  // Strip a field prefix off the front of the query. The rest of
  // the request shape stays the same; only the OpenAlex URL changes.
  const fieldMatch = qRaw.match(FIELD_PREFIX_RE);
  const field = fieldMatch ? fieldMatch[1].toLowerCase() : undefined;
  const q = fieldMatch ? fieldMatch[2].trim() : qRaw;

  // Field-targeted searches skip SS (no equivalent filter syntax)
  // and go straight to OpenAlex. SS would ignore the field hint and
  // return a generic best-match list anyway.
  if (field) {
    const oa = await searchOpenAlex(q, limit, offset, field);
    return NextResponse.json({
      papers: oa,
      provider: 'openalex',
      field,
      hasMore: oa.length === limit,
    });
  }

  // Boolean queries skip SS (no operator support) and go straight
  // to OpenAlex. SS would silently ignore the operators and return
  // a low-signal best-match list.
  const isBoolean = BOOLEAN_RE.test(q);
  if (isBoolean) {
    const oa = await searchOpenAlex(q, limit, offset);
    return NextResponse.json({
      papers: oa,
      provider: 'openalex',
      boolean: true,
      hasMore: oa.length === limit,
    });
  }

  // Plain queries: fire SS + OA in parallel and merge. The dedup
  // step folds duplicates (same DOI / arXiv id / normalised title)
  // so the user sees one merged ranked list rather than two
  // overlapping sets. SS is the primary because its similarity
  // ranking is better-tuned for free-text paper search; OA fills in
  // anything SS missed.
  const [ss, oa] = await Promise.all([
    searchPapers(q, limit, offset),
    searchOpenAlex(q, limit, offset),
  ]);
  const ssPapers = ss.ok ? ss.papers : [];
  const merged = mergeDedup(ssPapers, oa).slice(0, limit);

  if (merged.length > 0) {
    const provider =
      ssPapers.length > 0 && oa.length > 0 ? 'semanticscholar+openalex'
      : ssPapers.length > 0 ? 'semanticscholar'
      : 'openalex';
    return NextResponse.json({
      papers: merged,
      provider,
      hasMore: ssPapers.length === limit || oa.length === limit,
    });
  }

  if (!ss.ok) {
    return NextResponse.json(
      { error: ss.error, rateLimited: ss.rateLimited ?? false },
      { status: ss.status },
    );
  }
  return NextResponse.json({ papers: [], provider: 'semanticscholar+openalex', hasMore: false });
}
