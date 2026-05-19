/**
 * Extract the YouTube video id (11-char `videoId`) out of any of
 * the shapes a YouTube URL is normally written in:
 *
 *   https://www.youtube.com/watch?v=<id>
 *   https://www.youtube.com/watch?v=<id>&list=…           (playlist context)
 *   https://www.youtube.com/shorts/<id>
 *   https://www.youtube.com/embed/<id>
 *   https://youtu.be/<id>
 *   <id>                                                  (bare 11-char)
 *
 * Used for dedup when re-importing a playlist: the scraper hands
 * us bare `watch?v=` URLs while previously-imported rows carry
 * `watch?v=…&list=…` URLs, so a plain string-equality check
 * misses every duplicate. Comparing by videoId catches them all.
 *
 * Returns null when the input isn't recognisable as a YouTube
 * link / id — callers fall back to the original string in that
 * case.
 */
export function youtubeVideoId(u: string | null | undefined): string | null {
  if (!u) return null;
  const s = String(u).trim();
  if (!s) return null;
  try {
    const url = new URL(s);
    if (url.hostname.endsWith('youtu.be')) {
      const id = url.pathname.replace(/^\/+/, '').split('/')[0];
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (url.hostname.endsWith('youtube.com')) {
      const v = url.searchParams.get('v');
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
      const m = url.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/);
      if (m) return m[1];
    }
  } catch {
    /* not a URL — fall through to the bare-id test */
  }
  return /^[A-Za-z0-9_-]{11}$/.test(s) ? s : null;
}
