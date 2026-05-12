/**
 * Resolve a paper row's identifiable bits to a Semantic Scholar
 * reference. Returns one of:
 *
 *   ARXIV:<id>     — preferred when we have an arXiv shape
 *   DOI:<id>       — when the row carries a DOI
 *   null           — couldn't tell; caller should bail
 *
 * Accepts the row's `data` map (where we sometimes stash a
 * normalized `doi` / `arxiv` field) and falls back to scraping
 * the URL when the explicit fields are missing.
 */
export function resolvePaperRef(data: Record<string, unknown>): string | null {
  const arxiv = String(data.arxiv || '').trim();
  if (arxiv) return `ARXIV:${arxiv.replace(/^arxiv:/i, '')}`;
  const doi = String(data.doi || '').trim();
  if (doi) return `DOI:${doi.replace(/^doi:/i, '')}`;
  const url = String(data.url || '');
  const mArxiv = url.match(/arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,6}|[a-z-]+\/\d{7})/i);
  if (mArxiv) return `ARXIV:${mArxiv[1].replace(/v\d+(\.pdf)?$/i, '')}`;
  const mDoi = url.match(/(?:doi\.org\/|dx\.doi\.org\/)(10\.[^\s/?#]+\/[^\s?#]+)/i);
  if (mDoi) return `DOI:${mDoi[1]}`;
  // Loose DOI anywhere in the URL — covers publisher pages that
  // expose the DOI in the path (e.g. Springer, ACM, IEEE).
  const mAnyDoi = url.match(/(10\.\d{4,9}\/[^\s?#]+)/);
  if (mAnyDoi) return `DOI:${mAnyDoi[1]}`;
  return null;
}
