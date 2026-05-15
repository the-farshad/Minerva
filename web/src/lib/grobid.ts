/**
 * GROBID adapter — server-side bibliographic header extraction
 * from a paper PDF. Used as a stronger alternative to the local
 * regex-based `extractPdfMeta`: GROBID actually parses the PDF
 * structure, so it nails title / authors / abstract / DOI / year
 * on cases where the regex falls back to "first big string on
 * page 1".
 *
 * Default endpoint is the public hosted instance at
 * cloud.science-miner.com — free, rate-limited (~10 req/s
 * shared). Override with the `GROBID_URL` env var to point at a
 * self-hosted instance (`docker run lfoppiano/grobid:<ver>` on
 * the droplet) once load justifies the RAM cost.
 *
 * Returns `null` on any failure so callers degrade gracefully:
 * a slow / down GROBID never blocks an upload or refresh; the
 * caller still has `extractPdfMeta` as the local fallback.
 */

export type GrobidHeader = {
  title?: string;
  authors?: string;
  abstract?: string;
  doi?: string;
  year?: string;
};

function grobidBase(): string {
  return (process.env.GROBID_URL || 'https://cloud.science-miner.com/grobid').replace(/\/+$/, '');
}

/** Strip inner XML/HTML tags and collapse whitespace. */
function flatten(s: string): string {
  return s.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}

/** Parse TEI XML the GROBID processHeaderDocument endpoint returns
 *  into the shape Minerva stores on row.data. Regex-based: TEI is
 *  well-formed enough that we don't pull in a DOM parser for this. */
export function parseGrobidHeader(tei: string): GrobidHeader {
  const out: GrobidHeader = {};
  const titleM = tei.match(/<title[^>]*level="a"[^>]*>([\s\S]*?)<\/title>/i)
    ?? tei.match(/<title[^>]*type="main"[^>]*>([\s\S]*?)<\/title>/i);
  if (titleM) {
    const t = flatten(titleM[1]);
    if (t) out.title = t;
  }
  const authors: string[] = [];
  const authorRe = /<author\b[^>]*>([\s\S]*?)<\/author>/gi;
  let am: RegExpExecArray | null;
  while ((am = authorRe.exec(tei)) !== null) {
    const block = am[1];
    if (/<roleName\b/i.test(block)) continue; // editor / corresponding markers — skip non-author roles
    const fore = block.match(/<forename[^>]*>([\s\S]*?)<\/forename>/i)?.[1];
    const sur = block.match(/<surname[^>]*>([\s\S]*?)<\/surname>/i)?.[1];
    if (sur) {
      const name = [fore ? flatten(fore) : '', flatten(sur)].filter(Boolean).join(' ').trim();
      if (name) authors.push(name);
    }
  }
  if (authors.length) out.authors = Array.from(new Set(authors)).join(', ');
  const abstractM = tei.match(/<abstract\b[^>]*>([\s\S]*?)<\/abstract>/i);
  if (abstractM) {
    const a = flatten(abstractM[1]);
    if (a) out.abstract = a;
  }
  const doiM = tei.match(/<idno[^>]*type="DOI"[^>]*>([\s\S]*?)<\/idno>/i);
  if (doiM) {
    const d = flatten(doiM[1]);
    if (/^10\.\d{4,9}\//.test(d)) out.doi = d;
  }
  const dateM = tei.match(/<date[^>]*when="([0-9]{4})/);
  if (dateM) out.year = dateM[1];
  return out;
}

/**
 * Call GROBID's processHeaderDocument with the given PDF bytes.
 * Returns the parsed header on success, `null` on any failure
 * (network, non-200, parse error, timeout).
 */
export async function grobidExtractHeader(
  pdfBytes: Uint8Array,
  opts: { timeoutMs?: number; consolidate?: 0 | 1 | 2 } = {},
): Promise<GrobidHeader | null> {
  const url = `${grobidBase()}/api/processHeaderDocument`;
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), opts.timeoutMs ?? 25_000);
  try {
    const form = new FormData();
    // GROBID expects the field name "input" (per its OpenAPI spec).
    // `consolidate` levels: 0 = none, 1 = consolidate against
    // Crossref via DOI (slower, more accurate), 2 = aggressive.
    form.append('input', new Blob([new Uint8Array(pdfBytes)], { type: 'application/pdf' }), 'paper.pdf');
    if (opts.consolidate !== undefined) form.append('consolidateHeader', String(opts.consolidate));
    const r = await fetch(url, {
      method: 'POST',
      body: form,
      signal: ac.signal,
      headers: { Accept: 'application/xml' },
    });
    if (!r.ok) return null;
    const tei = await r.text();
    if (!tei || !tei.includes('<teiHeader')) return null;
    return parseGrobidHeader(tei);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
