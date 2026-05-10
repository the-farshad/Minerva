/**
 * Tiny client-side preferences store. Mirrors v1's localStorage
 * pattern but namespaces every key under `minerva.v2.<scope>.<id>`
 * so v1 and v2 can coexist in the same browser without trampling
 * each other. PG-backed sync across devices is a TODO; this is
 * sufficient for per-device knobs in the meantime.
 */

const NS = 'minerva.v2.';

export function readPref<T = string>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(NS + key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch { return fallback; }
}
export function writePref(key: string, value: unknown) {
  if (typeof window === 'undefined') return;
  try {
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) {
      localStorage.removeItem(NS + key);
    } else {
      localStorage.setItem(NS + key, JSON.stringify(value));
    }
  } catch { /* quota — ignore */ }
}

export type GroupSort = 'default' | 'title-asc' | 'title-desc' | 'newest' | 'oldest';
export type SectionGroupSort = 'default' | 'name-asc' | 'name-desc' | 'newest' | 'oldest';
