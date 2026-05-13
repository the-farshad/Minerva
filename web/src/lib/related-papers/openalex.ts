/**
 * OpenAlex backend for the connected-papers feature. OpenAlex is
 * an open scholarly metadata graph from OurResearch (the same
 * group behind Unpaywall) — 250 M+ works, 100 k requests/day in
 * the "polite pool" with no API key required (just an email in
 * the query string).
 *
 * Flow:
 *   1. resolve the seed paper to an OpenAlex Work ID (W…). DOI is
 *      direct (`/works/doi:<doi>`); arXiv we map to its CrossRef
 *      DOI shape (`10.48550/arXiv.<id>`) which OpenAlex indexes;
 *      title falls back to /works?search=<title>.
 *   2. read `related_works[]` off the seed (up to ~10 IDs).
 *   3. batch-fetch details for those IDs via
 *      `/works?filter=openalex_id:<id1>|<id2>|…`.
 *   4. reconstruct the abstract from OpenAlex's
 *      `abstract_inverted_index` (a position-indexed inverted
 *      dict) — that's what they emit instead of plain text for
 *      copyright reasons.
 *   5. shape the response to the same Paper-list the SS backend
 *      returns so the client doesn't have to know which source
 *      produced it.
 */

import type { RelatedPaper, RelatedResult, ResolvedRef } from './types';

const BASE = 'https://api.openalex.org';

function politeUrl(path: string, email?: string): string {
  const sep = path.includes('?') ? '&' : '?';
  // OpenAlex's polite pool — they ask for a `mailto` so they can
  // get in touch if our traffic looks pathological. Falls back to
  // an opaque project address when no user email is available.
  return `${BASE}${path}${sep}mailto=${encodeURIComponent(email || 'minerva@thefarshad.com')}`;
}

/** OpenAlex returns abstracts as `abstract_inverted_index`:
 *   { "token": [positions], … }
 *  Walk that map to reconstruct the original prose. */
function reconstructAbstract(idx: Record<string, number[]> | null | undefined): string | undefined {
  if (!idx || typeof idx !== 'object') return undefined;
  const slots: string[] = [];
  for (const [word, positions] of Object.entries(idx)) {
    for (const p of positions) slots[p] = word;
  }
  const out = slots.filter(Boolean).join(' ').trim();
  return out || undefined;
}

type OAAuthor = { author?: { display_name?: string } };
type OAWork = {
  id?: string;
  doi?: string | null;
  title?: string | null;
  authorships?: OAAuthor[];
  publication_year?: number | null;
  abstract_inverted_index?: Record<string, number[]> | null;
  open_access?: { oa_url?: string | null } | null;
  host_venue?: { display_name?: string | null } | null;
  primary_location?: { source?: { display_name?: string | null } | null } | null;
  related_works?: string[];
  referenced_works?: string[];
};

function workToPaper(w: OAWork): RelatedPaper {
  // OpenAlex DOIs come back as full https://doi.org/… URLs;
  // normalise to the bare DOI so it matches our externalIds shape.
  const rawDoi = w.doi || '';
  const doi = rawDoi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '') || undefined;
  // arXiv ID isn't a first-class field on OpenAlex — it lives
  // inside DOIs of the form 10.48550/arXiv.NNNN.NNNNN. Surface
  // it as externalIds.ArXiv when we can spot it.
  const arxivMatch = doi?.match(/^10\.48550\/arXiv\.(.+)$/i);
  const venue = w.primary_location?.source?.display_name || w.host_venue?.display_name || undefined;
  // Strip the URL prefix off referenced work IDs so the client
  // can compute set intersections with cheap string equality.
  const refs = (w.referenced_works || []).map((u) => u.replace(/^https:\/\/openalex\.org\//, ''));
  return {
    paperId: (w.id || '').replace(/^https:\/\/openalex\.org\//, ''),
    externalIds: {
      DOI: doi || undefined,
      ArXiv: arxivMatch?.[1] || undefined,
    },
    title: w.title || undefined,
    authors: (w.authorships || [])
      .map((a) => ({ name: a.author?.display_name || '' }))
      .filter((a) => a.name),
    year: w.publication_year || undefined,
    abstract: reconstructAbstract(w.abstract_inverted_index),
    openAccessPdf: w.open_access?.oa_url ? { url: w.open_access.oa_url } : undefined,
    venue,
    referencedWorks: refs.length ? refs : undefined,
  };
}

async function findSeedWork(ref: ResolvedRef, title: string | null, email?: string): Promise<{ id: string; related: string[] } | { error: string; status: number }> {
  const select = 'id,related_works';

  // DOI path — direct lookup.
  if (ref.kind === 'DOI') {
    const r = await fetch(politeUrl(`/works/doi:${encodeURIComponent(ref.id)}?select=${select}`, email));
    if (r.ok) {
      const j = (await r.json()) as OAWork;
      return { id: j.id || '', related: j.related_works || [] };
    }
    if (r.status !== 404) return { error: `OpenAlex: ${r.status}`, status: r.status };
  }
  // arXiv path — try the CrossRef-shaped DOI OpenAlex uses for
  // arXiv submissions. arXiv assigns these for everything since
  // ~2022 so it covers most modern preprints.
  if (ref.kind === 'ARXIV') {
    const arxivDoi = `10.48550/arXiv.${ref.id}`;
    const r = await fetch(politeUrl(`/works/doi:${encodeURIComponent(arxivDoi)}?select=${select}`, email));
    if (r.ok) {
      const j = (await r.json()) as OAWork;
      return { id: j.id || '', related: j.related_works || [] };
    }
  }
  // Title fallback — OpenAlex's full-text search ranks by
  // relevance so the top hit is almost always the right paper
  // when the title is reasonably unique.
  if (title) {
    const r = await fetch(politeUrl(`/works?search=${encodeURIComponent(title)}&per_page=1&select=${select}`, email));
    if (r.ok) {
      const j = (await r.json()) as { results?: OAWork[] };
      const hit = j.results?.[0];
      if (hit) return { id: hit.id || '', related: hit.related_works || [] };
    }
  }
  return { error: "Couldn't find this paper in OpenAlex — try opening it with an arXiv / DOI URL so we have a stable ID to lookup.", status: 404 };
}

export async function fetchRelatedFromOpenAlex(opts: {
  ref: ResolvedRef | null;
  title: string | null;
  limit: number;
  email?: string;
}): Promise<RelatedResult> {
  if (!opts.ref && !opts.title) {
    return { ok: false, status: 400, error: '`ref` or `title` is required.' };
  }
  // Default ref to a sentinel so findSeedWork's title fallback fires.
  const ref = opts.ref || { kind: 'TITLE_ONLY', id: '' } as ResolvedRef;
  const seed = await findSeedWork(ref, opts.title, opts.email);
  if ('error' in seed) return { ok: false, status: seed.status, error: seed.error };
  if (!seed.id) {
    return { ok: false, status: 404, error: 'OpenAlex found the paper but returned no ID.' };
  }
  const related = seed.related.slice(0, Math.max(1, Math.min(opts.limit, 50)));
  if (related.length === 0) {
    return { ok: true, papers: [], resolvedVia: opts.ref ? 'ref' : 'title' };
  }
  // Batch-fetch details for the related work IDs. OpenAlex
  // accepts up to ~50 IDs in a single filter so we usually fit
  // in one round-trip.
  // Parallel single-work lookups. OpenAlex's list-filter for IDs
  // is finicky (pipe-OR returns only the first match in
  // practice), and the related_works array is small enough
  // (≤ ~10) that one-per-id is cheaper than fighting the filter
  // syntax. Failed lookups (404, network) drop silently so a
  // single deindexed work doesn't sink the whole page.
  // OpenAlex deprecated `host_venue` — it's now a 400 in the
  // select parameter. The venue lives under
  // primary_location.source.display_name; we keep the host_venue
  // type field on OAWork for compatibility but never request it.
  const fields = 'id,doi,title,authorships,publication_year,abstract_inverted_index,open_access,primary_location,referenced_works';
  const lookups = related.map(async (u) => {
    const wid = u.replace(/^https:\/\/openalex\.org\//, '');
    try {
      const r = await fetch(politeUrl(`/works/${encodeURIComponent(wid)}?select=${fields}`, opts.email));
      if (!r.ok) return null;
      return (await r.json()) as OAWork;
    } catch {
      return null;
    }
  });
  const raw = await Promise.all(lookups);
  const works = raw.filter((w): w is OAWork => w != null);
  const papers = works.map(workToPaper);
  // Number of related_works[] pointers that didn't resolve to a
  // live OpenAlex record on this fetch. Surfaced so the UI can
  // tell the user "20 found, 18 readable" instead of pretending
  // the list is complete.
  const dropped = raw.length - works.length;
  return { ok: true, papers, resolvedVia: opts.ref ? 'ref' : 'title', dropped };
}
