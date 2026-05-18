/**
 * DBLP backend for the keyword paper-search merge. DBLP is a
 * free, CS-focused bibliographic index — strong on authoritative
 * author IDs, conferences, and computer-science venues that
 * Semantic Scholar and OpenAlex sometimes miss. No API key needed.
 *
 *   GET https://dblp.org/search/publ/api?q=<query>&format=json&h=<limit>&f=<offset>
 *
 * DBLP doesn't return abstracts or citation counts — its strength
 * is coverage and author disambiguation, not bibliometrics. Cite
 * stats are filled in later if another backend in the merge has
 * the same paper.
 */
import type { RelatedPaper } from './types';

type DBLPAuthor = { '@pid'?: string; text?: string };
type DBLPHit = {
  '@id'?: string;
  info?: {
    authors?: { author?: DBLPAuthor | DBLPAuthor[] };
    title?: string;
    venue?: string;
    year?: string;
    type?: string;
    doi?: string;
    ee?: string;
    url?: string;
  };
};

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function dblpToPaper(hit: DBLPHit): RelatedPaper {
  const info = hit.info || {};
  const authorArr = asArray(info.authors?.author);
  const authors = authorArr
    .map((a) => ({ name: a.text || '' }))
    .filter((a) => a.name);
  // DBLP exposes the DOI directly on most modern records; older
  // records put a doi.org URL in `ee` (external entry). Recover it.
  let doi = info.doi;
  if (!doi && info.ee) {
    const m = info.ee.match(/^https?:\/\/(?:dx\.)?doi\.org\/(.+)$/i);
    if (m) doi = m[1];
  }
  const year = info.year ? Number(info.year) : undefined;
  return {
    paperId: hit['@id'] || undefined,
    externalIds: doi ? { DOI: doi } : {},
    title: info.title || undefined,
    authors,
    year: Number.isFinite(year) ? year : undefined,
    venue: info.venue || undefined,
  };
}

export async function searchDBLP(
  query: string,
  limit: number,
  offset: number = 0,
): Promise<RelatedPaper[]> {
  const h = Math.min(1000, Math.max(1, limit));
  const f = Math.max(0, offset);
  const url =
    `https://dblp.org/search/publ/api?q=${encodeURIComponent(query)}` +
    `&format=json&h=${h}&f=${f}`;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, next: { revalidate: 300 } });
    if (!r.ok) return [];
    const j = (await r.json()) as { result?: { hits?: { hit?: DBLPHit | DBLPHit[] } } };
    const hits = asArray(j?.result?.hits?.hit);
    return hits.map(dblpToPaper).filter((p) => p.title);
  } catch {
    return [];
  }
}
