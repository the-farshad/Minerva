/**
 * Semantic Scholar backend for connected papers. Same shape as
 * the OpenAlex module; the route picks one at runtime based on
 * the user's `related_papers_provider` server pref.
 *
 * SS rate-limits shared cloud IPs aggressively without a key —
 * set SEMANTIC_SCHOLAR_API_KEY in the droplet env to unlock the
 * partner tier. The route's error path tells the user when 429s
 * are happening.
 */

import type { RelatedPaper, RelatedResult, ResolvedRef } from './types';

const FIELDS = [
  'externalIds',
  'title',
  'authors',
  'year',
  'abstract',
  'openAccessPdf',
  'venue',
].join(',');

function ssHeaders(): HeadersInit {
  const h: Record<string, string> = { Accept: 'application/json' };
  if (process.env.SEMANTIC_SCHOLAR_API_KEY) {
    h['x-api-key'] = process.env.SEMANTIC_SCHOLAR_API_KEY;
  }
  return h;
}

async function getRecommendations(paperRef: string, limit: number) {
  const url = `https://api.semanticscholar.org/recommendations/v1/papers/forpaper/${encodeURIComponent(paperRef)}?limit=${limit}&fields=${encodeURIComponent(FIELDS)}`;
  const r = await fetch(url, {
    headers: ssHeaders(),
    next: { revalidate: 300 },
  });
  if (!r.ok) return { ok: false as const, status: r.status, text: await r.text().catch(() => '') };
  const j = (await r.json()) as { recommendedPapers?: RelatedPaper[] };
  return { ok: true as const, papers: j.recommendedPapers ?? [] };
}

async function searchByTitle(title: string): Promise<string | null> {
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(title)}&limit=1&fields=paperId,title`;
  try {
    const r = await fetch(url, { headers: ssHeaders(), next: { revalidate: 300 } });
    if (!r.ok) return null;
    const j = (await r.json()) as { data?: { paperId?: string }[] };
    return j.data?.[0]?.paperId ?? null;
  } catch {
    return null;
  }
}

export async function fetchRelatedFromSemanticScholar(opts: {
  ref: ResolvedRef | null;
  title: string | null;
  limit: number;
}): Promise<RelatedResult> {
  if (!opts.ref && !opts.title) {
    return { ok: false, status: 400, error: '`ref` or `title` is required.' };
  }
  const refStr = opts.ref
    ? `${opts.ref.kind === 'ARXIV' ? 'ARXIV' : 'DOI'}:${opts.ref.id}`
    : null;
  if (refStr) {
    const res = await getRecommendations(refStr, opts.limit);
    if (res.ok) return { ok: true, papers: res.papers, resolvedVia: 'ref' };
    if (res.status !== 404 && !opts.title) {
      const rateLimited = res.status === 429;
      return {
        ok: false, status: res.status,
        error: rateLimited
          ? 'Semantic Scholar is rate-limiting this IP. Set SEMANTIC_SCHOLAR_API_KEY on the droplet, or switch the provider to OpenAlex in Settings.'
          : `Semantic Scholar returned ${res.status}${res.text ? `: ${res.text.slice(0, 200)}` : ''}`,
        rateLimited,
      };
    }
  }
  if (opts.title) {
    const paperId = await searchByTitle(opts.title);
    if (!paperId) {
      return { ok: false, status: 404, error: "Couldn't find this paper in Semantic Scholar by title." };
    }
    const res = await getRecommendations(paperId, opts.limit);
    if (res.ok) return { ok: true, papers: res.papers, resolvedVia: 'title' };
    const rateLimited = res.status === 429;
    return {
      ok: false, status: res.status,
      error: rateLimited
        ? 'Semantic Scholar is rate-limiting this IP. Set SEMANTIC_SCHOLAR_API_KEY, or switch to OpenAlex in Settings.'
        : `Semantic Scholar returned ${res.status}${res.text ? `: ${res.text.slice(0, 200)}` : ''}`,
      rateLimited,
    };
  }
  return { ok: false, status: 404, error: 'Unable to resolve a paper reference.' };
}

/**
 * Fetch the list of papers a given paper cites (its references)
 * from Semantic Scholar. Returns `RelatedPaper` shapes so the
 * frontend reuses the existing card rendering. Capped at the SS
 * default 100 per call; the few papers with >100 references can
 * paginate later, but every single-paper bibliometric tool out
 * there starts at 100 too.
 */
export async function fetchReferencesFromSS(
  ref: { kind: 'ARXIV' | 'DOI'; id: string },
  limit: number = 100,
): Promise<
  | { ok: true; papers: RelatedPaper[] }
  | { ok: false; status: number; error: string; rateLimited?: boolean }
> {
  try {
    const ssId = `${ref.kind}:${ref.id}`;
    const url =
      `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(ssId)}/references` +
      `?fields=${encodeURIComponent(FIELDS)}&limit=${Math.min(1000, Math.max(1, limit))}`;
    const r = await fetch(url, { headers: ssHeaders(), next: { revalidate: 3600 } });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return {
        ok: false,
        status: r.status,
        error:
          r.status === 429
            ? 'Semantic Scholar is rate-limiting this IP. Set SEMANTIC_SCHOLAR_API_KEY on the droplet.'
            : `Semantic Scholar returned ${r.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
        rateLimited: r.status === 429,
      };
    }
    const j = (await r.json()) as { data?: { citedPaper?: RelatedPaper | null }[] };
    const papers = (j.data ?? [])
      .map((d) => d.citedPaper)
      .filter((p): p is RelatedPaper => !!p && (!!p.title || !!p.externalIds));
    return { ok: true, papers };
  } catch (e) {
    return { ok: false, status: 502, error: (e as Error).message };
  }
}

/**
 * Best-effort fetch of bibliometric stats for one paper — citation
 * count, reference count, influential-citation count — keyed by
 * arXiv id or DOI. Returns `null` on miss / rate-limit / network
 * failure, so callers can degrade gracefully (the row just lands
 * without the stats, the import flow doesn't fail because SS is
 * having a moment).
 */
export async function fetchPaperStatsFromSS(ref: {
  kind: 'ARXIV' | 'DOI';
  id: string;
}): Promise<{
  citationCount?: number;
  referenceCount?: number;
  influentialCitationCount?: number;
} | null> {
  try {
    const ssId = `${ref.kind}:${ref.id}`;
    const url = `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(
      ssId,
    )}?fields=citationCount,referenceCount,influentialCitationCount`;
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 6_000);
    const r = await fetch(url, {
      headers: ssHeaders(),
      signal: ac.signal,
      next: { revalidate: 3600 },
    }).finally(() => clearTimeout(timeout));
    if (!r.ok) return null;
    const j = (await r.json()) as {
      citationCount?: number;
      referenceCount?: number;
      influentialCitationCount?: number;
    };
    return {
      citationCount: typeof j.citationCount === 'number' ? j.citationCount : undefined,
      referenceCount: typeof j.referenceCount === 'number' ? j.referenceCount : undefined,
      influentialCitationCount:
        typeof j.influentialCitationCount === 'number' ? j.influentialCitationCount : undefined,
    };
  } catch {
    return null;
  }
}
