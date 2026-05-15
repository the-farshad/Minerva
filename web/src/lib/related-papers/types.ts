/**
 * Common shapes shared by every connected-papers backend. The
 * /api/related-papers route picks a backend at runtime; the
 * frontend never sees which one produced the list.
 */

export type ResolvedRef =
  | { kind: 'ARXIV'; id: string }
  | { kind: 'DOI'; id: string }
  | { kind: 'TITLE_ONLY'; id: '' };

export type RelatedPaper = {
  paperId?: string;
  externalIds?: { DOI?: string; ArXiv?: string; CorpusId?: string };
  title?: string;
  authors?: { name?: string }[];
  year?: number;
  abstract?: string;
  openAccessPdf?: { url?: string };
  venue?: string;
  /** Citations-of, when the backend supplied it. Shown next to
   *  year / venue on list cards so the user can spot heavy hitters
   *  at a glance. */
  citationCount?: number;
  /** Influential citations (SS's term — citations that meaningfully
   *  build on this work rather than merely reference it). */
  influentialCitationCount?: number;
  /** Bare OpenAlex Work IDs this paper cites (e.g. ["W123", …]).
   *  Used to compute bibliographic-coupling edges between
   *  papers in the graph view. OpenAlex provides this for free;
   *  Semantic Scholar would need a per-paper /references call so
   *  the graph view degrades to hub-and-spoke when this is empty. */
  referencedWorks?: string[];
};

export type RelatedResult =
  | { ok: true; papers: RelatedPaper[]; resolvedVia: 'ref' | 'title'; dropped?: number }
  | { ok: false; status: number; error: string; rateLimited?: boolean };

export function parseRef(ref: string | null): ResolvedRef | null {
  if (!ref) return null;
  const m1 = ref.match(/^ARXIV:(.+)$/i);
  if (m1) return { kind: 'ARXIV', id: m1[1] };
  const m2 = ref.match(/^DOI:(.+)$/i);
  if (m2) return { kind: 'DOI', id: m2[1] };
  return null;
}
