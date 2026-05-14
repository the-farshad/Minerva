/** Human "time ago" + absolute date formatting for row timestamps
 *  (createdAt / updatedAt). Shared so cards, the info pane, and the
 *  sort UI all phrase dates the same way. */

const UNITS: [limit: number, div: number, name: string][] = [
  [45, 1, 'second'],
  [3600, 60, 'minute'],
  [86400, 3600, 'hour'],
  [604800, 86400, 'day'],
  [2629800, 604800, 'week'],
  [31557600, 2629800, 'month'],
  [Number.POSITIVE_INFINITY, 31557600, 'year'],
];

/** "just now", "5 minutes ago", "3 days ago", "2 months ago". */
export function relativeTime(iso: string | number | Date | null | undefined): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 45) return 'just now';
  for (const [limit, div, name] of UNITS) {
    if (secs < limit) {
      const n = Math.round(secs / div);
      return `${n} ${name}${n === 1 ? '' : 's'} ago`;
    }
  }
  return '';
}

/** Absolute, locale-formatted date + time — for tooltips and the
 *  info pane, where the exact moment matters. */
export function formatDateTime(iso: string | number | Date | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}
