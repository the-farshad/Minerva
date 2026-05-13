/**
 * Reading-time estimation for papers.
 *
 * Two inputs supported, in order of precedence:
 *   - `pages` (from PDF metadata): ~3 min/page is the typical
 *     academic-paper rate (dense layout, equations, figures).
 *   - `words` (from text extraction): 250 wpm is the canonical
 *     adult silent-reading rate; we apply it when pages isn't
 *     available so a reading estimate isn't withheld for older
 *     rows that pre-date the page-count column.
 *
 * Returned value is integer minutes. Callers should display it as
 * "~N min" so the user reads it as an estimate, not a stopwatch.
 */
export const MINUTES_PER_PAGE = 3;
export const WORDS_PER_MINUTE = 250;

export function readingMinutesFromPages(pages: number | undefined | null): number | null {
  if (!pages || pages <= 0) return null;
  return Math.max(1, Math.round(pages * MINUTES_PER_PAGE));
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
