/**
 * OpenCitations COCI backend — second source of truth for a
 * paper's references / citations list. Used as a fallback in
 * /api/papers/refs when Semantic Scholar returns no data (a real
 * miss for non-indexed papers; OpenCitations indexes from
 * Crossref's open citations dataset which is broader for some
 * publishers).
 *
 * DOI-only — there's no arXiv ID path here. Callers must
 * normalise an arXiv id to its DOI before calling.
 *
 * Two upstream endpoints in play:
 *   GET /index/coci/api/v1/references/<doi>  → bare DOI list (cited)
 *   GET /index/coci/api/v1/citations/<doi>   → bare DOI list (citing)
 * Both return rows without titles, so we follow up with one
 * batched `metadata/<doi1>__<doi2>__…` call to enrich each entry.
 * The batch endpoint accepts a small ceiling; we chunk at 25.
 */
import type { RelatedPaper } from './types';

const OC_BASE = 'https://opencitations.net/index/coci/api/v1';

function ocHeaders(): HeadersInit {
  return { Accept: 'application/json' };
}

/** Parse `"Lastname, F.; Other, G."` → `[{name: 'Lastname F'}, ...]`. */
function parseAuthors(s: string): { name?: string }[] {
  if (!s) return [];
  return s.split(';').map((part) => {
    const t = part.trim();
    if (!t) return null;
    // OC's "Last, F." → render as "F Last" for natural reading.
    const m = t.match(/^([^,]+),\s*(.+)$/);
    const name = m ? `${m[2].trim()} ${m[1].trim()}` : t;
    return { name };
  }).filter((x): x is { name: string } => !!x);
}

/** Chunk an array into runs of at most `n` items. */
function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

interface OcEdgeRow {
  oci?: string;
  citing?: string;
  cited?: string;
  creation?: string;
}

interface OcMetadataRow {
  doi?: string;
  title?: string;
  author?: string;
  year?: string;
  source_title?: string;
  citation_count?: string;
}

async function fetchEdgeDois(
  ref: { kind: 'DOI'; id: string },
  direction: 'references' | 'citations',
  limit: number,
  signal: AbortSignal,
): Promise<string[]> {
  const url = `${OC_BASE}/${direction}/${encodeURIComponent(ref.id)}`;
  const r = await fetch(url, { headers: ocHeaders(), signal, next: { revalidate: 3600 } });
  if (!r.ok) throw new Error(`OpenCitations ${r.status}`);
  const rows = (await r.json()) as OcEdgeRow[];
  const field = direction === 'references' ? 'cited' : 'citing';
  const dois = rows
    .map((row) => row[field])
    .filter((d): d is string => !!d && /^10\./.test(d));
  // Dedup + cap. Rare to see duplicates but OC has occasionally
  // returned them in tightly-coupled review papers.
  return Array.from(new Set(dois)).slice(0, Math.max(1, limit));
}

async function fetchMetadataBatch(dois: string[], signal: AbortSignal): Promise<OcMetadataRow[]> {
  if (dois.length === 0) return [];
  const joined = dois.map((d) => encodeURIComponent(d)).join('__');
  const url = `${OC_BASE}/metadata/${joined}`;
  const r = await fetch(url, { headers: ocHeaders(), signal, next: { revalidate: 3600 } });
  if (!r.ok) return [];
  try {
    return (await r.json()) as OcMetadataRow[];
  } catch {
    return [];
  }
}

/**
 * Fetch references / citations from OpenCitations and enrich the
 * DOI list with bulk metadata calls (chunked at 25 per request).
 * Returns the same `RelatedPaper[]` shape that the SS backend
 * returns, so callers spread either source identically.
 */
export async function fetchPaperEdgesFromOpenCitations(
  ref: { kind: 'ARXIV' | 'DOI'; id: string },
  opts: { direction: 'references' | 'citations'; limit?: number },
): Promise<
  | { ok: true; papers: RelatedPaper[] }
  | { ok: false; status: number; error: string; rateLimited?: boolean }
> {
  if (ref.kind !== 'DOI') {
    return { ok: false, status: 400, error: 'OpenCitations only supports DOI lookups.' };
  }
  const limit = Math.min(200, Math.max(1, opts.limit ?? 100));
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 15_000);
  try {
    const dois = await fetchEdgeDois({ kind: 'DOI', id: ref.id }, opts.direction, limit, ac.signal);
    if (dois.length === 0) return { ok: true, papers: [] };

    const batches = chunks(dois, 25);
    const all: OcMetadataRow[] = [];
    for (const batch of batches) {
      const rows = await fetchMetadataBatch(batch, ac.signal);
      all.push(...rows);
    }
    // Index by DOI so the output order tracks the original edge
    // list (most-recent-first per OC), not the metadata API's
    // alphabetical default.
    const byDoi = new Map<string, OcMetadataRow>();
    for (const m of all) {
      if (m.doi) byDoi.set(m.doi.toLowerCase(), m);
    }
    const papers: RelatedPaper[] = dois.map((doi): RelatedPaper => {
      const m = byDoi.get(doi.toLowerCase());
      const yearNum = m?.year ? Number(m.year) : NaN;
      const ccNum = m?.citation_count ? Number(m.citation_count) : NaN;
      return {
        externalIds: { DOI: doi },
        title: m?.title || '',
        authors: parseAuthors(m?.author ?? ''),
        ...(Number.isFinite(yearNum) ? { year: yearNum } : {}),
        ...(m?.source_title ? { venue: m.source_title } : {}),
        ...(Number.isFinite(ccNum) && ccNum > 0 ? { citationCount: ccNum } : {}),
      };
    });
    return { ok: true, papers };
  } catch (e) {
    const err = e as Error;
    const rateLimited = /429/.test(err.message);
    return {
      ok: false,
      status: rateLimited ? 429 : 502,
      error: rateLimited
        ? 'OpenCitations is rate-limiting this IP. Try again in a few minutes.'
        : err.message,
      rateLimited,
    };
  } finally {
    clearTimeout(timeout);
  }
}
