/**
 * Reading-time estimation for papers.
 *
 * Two inputs supported, in order of precedence:
 *   - `pages` (from PDF metadata): ~6 min/page is realistic for
 *     a careful read of a dense academic paper (equations, figures,
 *     methods walkthrough). The previous 3 min/page assumed a
 *     skim, which under-counted a real read by ~2×.
 *   - `words` (from text extraction): 180 wpm — academic prose is
 *     denser than the 250 wpm typical for casual / journalistic
 *     reading. Applied when pages isn't available so the estimate
 *     isn't withheld for older rows that pre-date the page-count
 *     column.
 *
 * Returned value is integer minutes. Callers should display it as
 * "~N min" so the user reads it as an estimate, not a stopwatch.
 */
export const MINUTES_PER_PAGE = 6;
export const WORDS_PER_MINUTE = 180;

/** Sanity ceiling for a paper's page count. PDF metadata often
 *  reports 200+ pages for stitched lecture-notes booklets, theses,
 *  or full-issue dumps the user mis-tagged as a paper. Those
 *  inflate the per-card "~20 h to read" badge to a number that
 *  reads as garbage. Clamp at MAX_PAGES so a wildly over-large
 *  reading time gets bounded instead of leaking into every group
 *  total it touches. */
const MAX_PAGES = 60;

export function readingMinutesFromPages(pages: number | undefined | null): number | null {
  if (!pages || pages <= 0) return null;
  const clamped = Math.min(pages, MAX_PAGES);
  return Math.max(1, Math.round(clamped * MINUTES_PER_PAGE));
}

export function readingMinutesFromWords(words: number | undefined | null): number | null {
  if (!words || words <= 0) return null;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

/** Best estimate from whatever row data is present. */
export function readingMinutes(data: Record<string, unknown>): number | null {
  // Authors' own estimate wins — the user can override either via
  // a manual edit or via a future "set my pace" pref.
  const explicit = Number(data.readingMinutes);
  if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit);
  const pages = Number(data.pages);
  if (Number.isFinite(pages) && pages > 0) return readingMinutesFromPages(pages);
  const words = Number(data.words);
  if (Number.isFinite(words) && words > 0) return readingMinutesFromWords(words);
  return null;
}

/** Format as "12 min" / "1h 30 min". The leading "~" is added by
 *  the caller when context makes the rough nature obvious. */
export function formatReadingMinutes(mins: number): string {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
