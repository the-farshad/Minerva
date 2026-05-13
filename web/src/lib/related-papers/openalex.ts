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

  // Title fallback for the truly-no-title-and-no-DOI case (the
  // CrossRef backfill couldn't help). Synthesize a label from
  // first author + year + venue so the row is still recognisable.
  let title = w.title || undefined;
  if (!title) {
    const firstAuthor = (w.authorships || []).find((a) => a.author?.display_name)?.author?.display_name;
    const parts: string[] = [];
    if (firstAuthor) {
      const authorCount = (w.authorships || []).length;
      parts.push(authorCount > 1 ? `${firstAuthor} et al.` : firstAuthor);
    }
    if (w.publication_year) parts.push(String(w.publication_year));
    if (venue) parts.push(venue);
    if (parts.length > 0) {
      // Leading `〔synth〕` marker so the client knows to italicise
      // and signal "this label was synthesised". The marker gets
      // stripped before render — see related-view.tsx.
      title = `〔synth〕${parts.join(' · ')}`;
    }
  }

  return {
    paperId: (w.id || '').replace(/^https:\/\/openalex\.org\//, ''),
    externalIds: {
      DOI: doi || undefined,
      ArXiv: arxivMatch?.[1] || undefined,
    },
    title,
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
  // The seed's curated related_works[] is small (~10–20 max).
  // For well-cited classics we boost coverage by also pulling
  // the top-cited papers that CITE the seed — those are usually
  // the followup / application papers a user studying the seed
  // wants to know about. OpenAlex's /works?filter=cites:<id>
  // endpoint is free and respects per_page up to 200.
  const limit = Math.max(1, Math.min(opts.limit, 50));
  const seedId = seed.id.replace(/^https:\/\/openalex\.org\//, '');
  const fields = 'id,doi,title,authorships,publication_year,abstract_inverted_index,open_access,primary_location,referenced_works';
  const relatedIds = seed.related.map((u) => u.replace(/^https:\/\/openalex\.org\//, ''));

  // Fetch top citers of the seed in parallel. cited_by_count
  // descending gives "most-impactful citers" — papers that
  // built on the seed and themselves became important.
  let citerIds: string[] = [];
  try {
    const rCite = await fetch(politeUrl(
      `/works?filter=cites:${encodeURIComponent(seedId)}&sort=cited_by_count:desc&per_page=${Math.max(20, limit)}&select=id`,
      opts.email,
    ));
    if (rCite.ok) {
      const jc = (await rCite.json()) as { results?: { id?: string }[] };
      citerIds = (jc.results || [])
        .map((w) => (w.id || '').replace(/^https:\/\/openalex\.org\//, ''))
        .filter(Boolean);
    }
  } catch { /* citer expansion is best-effort */ }

  // Union, dedupe (related-first so the curated list has visual
  // priority), cap at limit.
  const seen = new Set<string>();
  const combinedIds: string[] = [];
  for (const wid of [...relatedIds, ...citerIds]) {
    if (!wid || seen.has(wid)) continue;
    seen.add(wid);
    combinedIds.push(wid);
    if (combinedIds.length >= limit) break;
  }
  if (combinedIds.length === 0) {
    return { ok: true, papers: [], resolvedVia: opts.ref ? 'ref' : 'title' };
  }

  // Parallel single-work lookups. OpenAlex's list-filter for IDs
  // is finicky (pipe-OR returns only the first match in
  // practice). One-per-id parallel is robust.
  const lookups = combinedIds.map(async (wid) => {
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

  // Backfill titles via CrossRef for any work OpenAlex returned
  // with a null title BUT a real DOI. CrossRef almost always
  // has the title — these "untitled" rows were just OpenAlex
  // record gaps, not actually anonymous papers.
  await backfillTitlesFromCrossRef(works);

  const papers = works.map(workToPaper);
  const dropped = raw.length - works.length;
  return { ok: true, papers, resolvedVia: opts.ref ? 'ref' : 'title', dropped };
}

/** For OpenAlex Works that came back without a title but with a
 *  DOI, fetch the missing title from CrossRef. Mutates the
 *  `works` array in place. Quiet on per-paper failure. */
async function backfillTitlesFromCrossRef(works: OAWork[]): Promise<void> {
  const needs = works.filter((w) => !w.title && w.doi);
  if (needs.length === 0) return;
  await Promise.all(needs.map(async (w) => {
    const doi = (w.doi || '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
    if (!doi) return;
    try {
      const r = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
        headers: { Accept: 'application/json' },
        next: { revalidate: 3600 },
      });
      if (!r.ok) return;
      const j = (await r.json()) as { message?: { title?: string[] } };
      const t = j.message?.title?.[0];
      if (t) w.title = t;
    } catch { /* tolerate */ }
  }));
}
