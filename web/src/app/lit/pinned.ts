/**
 * Pinned-papers store for the comparison matrix. Lives in
 * localStorage under the v2 namespace so the rest of the
 * preferences plumbing already knows about it. Cross-tab updates
 * fire a `storage` event other components can subscribe to.
 *
 * The store is intentionally a flat list of full Paper objects
 * rather than a list of IDs — the comparison view can render
 * without re-fetching, even after the user navigated away from
 * /lit and lost the in-memory state.
 */

const STORAGE_KEY = 'minerva.v2.lit.pinned';
const MAX_PINS = 6;

export type PinnedPaper = {
  paperId?: string;
  externalIds?: { DOI?: string; ArXiv?: string };
  title?: string;
  authors?: string | { name?: string }[];
  year?: string | number;
  venue?: string;
  doi?: string;
  arxiv?: string;
  abstract?: string;
  url?: string;
  pdf?: string;
  citationCount?: number;
  influentialCitationCount?: number;
  openAccessPdf?: { url?: string };
  /** When the user pinned it — used for sort order in the
   *  comparison view (oldest first by default). */
  pinnedAt?: number;
};

/** Stable identity for a paper across the store — same key shape
 *  used by the search-dedup helper, so a pin from any list maps
 *  to the same record. */
export function pinKey(p: PinnedPaper): string {
  const doi = p.doi || p.externalIds?.DOI;
  if (doi) return `doi:${doi.toLowerCase()}`;
  const arxiv = p.arxiv || p.externalIds?.ArXiv;
  if (arxiv) return `arxiv:${arxiv.toLowerCase()}`;
  if (p.paperId) return `id:${p.paperId}`;
  const t = (p.title || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  return t ? `t:${t}` : 'pin:' + Math.random().toString(36);
}

export function getPinned(): PinnedPaper[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as PinnedPaper[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writePinned(list: PinnedPaper[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    // Re-dispatch a synthetic storage event so listeners in the
    // same tab can react. The browser only fires storage events
    // across tabs by default.
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }));
  } catch {
    /* tolerate quota / disabled storage */
  }
}

export function isPinned(p: PinnedPaper): boolean {
  const k = pinKey(p);
  return getPinned().some((q) => pinKey(q) === k);
}

export function togglePin(p: PinnedPaper): boolean {
  const k = pinKey(p);
  const list = getPinned();
  const idx = list.findIndex((q) => pinKey(q) === k);
  if (idx >= 0) {
    list.splice(idx, 1);
    writePinned(list);
    return false;
  }
  if (list.length >= MAX_PINS) {
    // Drop oldest to make room. Compare needs to stay readable,
    // so we cap aggressively rather than letting the table get
    // wider than the viewport.
    list.shift();
  }
  list.push({ ...p, pinnedAt: Date.now() });
  writePinned(list);
  return true;
}

export function unpin(p: PinnedPaper) {
  const k = pinKey(p);
  writePinned(getPinned().filter((q) => pinKey(q) !== k));
}

export function clearPinned() {
  writePinned([]);
}

export { MAX_PINS };
