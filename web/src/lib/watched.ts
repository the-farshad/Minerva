/**
 * Per-video watched-fraction helpers. Source of truth:
 *
 *   - `row.data.duration` — total length. Either an ISO 8601 string
 *     ("PT1H23M45S" from YouTube Data API), a `HH:MM:SS` / `MM:SS`
 *     string (yt-dlp formats), or a raw number of seconds. All
 *     three shapes show up in practice depending on how the row was
 *     enriched, so the parser handles each.
 *
 *   - `localStorage["minerva.v2.resume.<url>"]` — last playback
 *     position in seconds. Written by the preview modal's resume
 *     listener; lives per-device (LOCAL_ONLY).
 *
 * Returns `null` when the row has no usable duration so callers can
 * hide the bar instead of rendering a 0-of-0 progress chip.
 */

export function parseDurationSeconds(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  const s = String(v).trim();
  if (!s) return null;
  // ISO 8601 "PT1H23M45S".
  const iso = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(s);
  if (iso) {
    const [, h, m, sec] = iso;
    const total = (Number(h) || 0) * 3600 + (Number(m) || 0) * 60 + (Number(sec) || 0);
    return total > 0 ? total : null;
  }
  // HH:MM:SS or MM:SS.
  if (/^\d+(?::\d{1,2}){1,2}$/.test(s)) {
    const parts = s.split(':').map(Number);
    let total = 0;
    for (const p of parts) total = total * 60 + p;
    return total > 0 ? total : null;
  }
  // Bare number-of-seconds.
  const n = Number(s);
  if (Number.isFinite(n) && n > 0) return n;
  return null;
}

const NS = 'minerva.v2.';

export function readWatchedSeconds(url: string): number {
  if (typeof window === 'undefined' || !url) return 0;
  try {
    const raw = localStorage.getItem(NS + 'resume.' + url);
    if (!raw) return 0;
    const n = Number(JSON.parse(raw));
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export type WatchedStats = {
  /** Total duration in seconds, null if unknown. */
  duration: number | null;
  /** Seconds watched (capped at duration if known). */
  watched: number;
  /** 0..1, only meaningful when duration is known. */
  pct: number | null;
};

export function computeWatched(row: { data: Record<string, unknown> }): WatchedStats {
  const url = String(row.data.url || '');
  const duration = parseDurationSeconds(row.data.duration);
  const raw = readWatchedSeconds(url);
  const watched = duration ? Math.min(raw, duration) : raw;
  return {
    duration,
    watched,
    pct: duration ? watched / duration : null,
  };
}
