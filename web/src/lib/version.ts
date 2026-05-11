/**
 * Build provenance — surfaced as a small badge in the Nav so the
 * user can see which commit/image they're actually running. Values
 * are baked in at `next build` time via NEXT_PUBLIC_* env vars set
 * by the GitHub Actions workflow.
 */
import pkg from '../../package.json';

export const VERSION = pkg.version as string;
export const BUILD_SHA = (process.env.NEXT_PUBLIC_BUILD_SHA || 'dev').slice(0, 7);
export const BUILD_TIME = process.env.NEXT_PUBLIC_BUILD_TIME || '';

/** Pretty short build timestamp, e.g. "2026-05-11 15:42". Empty for dev. */
export function buildTimeShort(): string {
  if (!BUILD_TIME) return '';
  const d = new Date(BUILD_TIME);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
