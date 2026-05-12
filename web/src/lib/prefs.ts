/**
 * Tiny client-side preferences store. Mirrors v1's localStorage
 * pattern but namespaces every key under `minerva.v2.<scope>.<id>`
 * so v1 and v2 can coexist in the same browser without trampling
 * each other. PG-backed sync across devices is a TODO; this is
 * sufficient for per-device knobs in the meantime.
 */

const NS = 'minerva.v2.';

/** Keys excluded from cross-device sync — per-device by design. */
const LOCAL_ONLY = new Set(['theme']);

/** Prefix-matched keys that are per-device too. The exact `pdf.page.<rowId>`
 * / `resume.<videoUrl>` keys are unbounded, so we match by leading
 * namespace instead of enumerating one row at a time. Without this,
 * `pullServerPrefs` on the next page load overwrites the local
 * value with whatever the server last received — which is whatever
 * a different device wrote, or the initial 1/0, or stale from
 * before the user's scroll. Bug pattern: "I scrolled to page 30,
 * closed, reopened → page 1 again." */
const LOCAL_ONLY_PREFIXES = [
  'pdf.page.',
  'resume.',
  'notes.mode',
  'reader.',
  'paper.theme',
  'catfilter.',
  'collapsed.',
  'groupsort.',
  'grouporder.',
  'sectiongrouporder.',
];

function isLocalOnly(key: string): boolean {
  if (LOCAL_ONLY.has(key)) return true;
  return LOCAL_ONLY_PREFIXES.some((p) => key.startsWith(p));
}

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
      if (!isLocalOnly(key)) schedulePush(key, null);
    } else {
      localStorage.setItem(NS + key, JSON.stringify(value));
      if (!isLocalOnly(key)) schedulePush(key, value);
    }
  } catch { /* quota — ignore */ }
}

// --- cross-device sync via /api/userprefs ----------------------------

let pending: Record<string, unknown> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function schedulePush(key: string, value: unknown) {
  if (typeof window === 'undefined') return;
  pending = pending || {};
  pending[key] = value;
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, 1500);
}

async function flush() {
  if (!pending) return;
  const body = pending;
  pending = null;
  timer = null;
  try {
    await fetch('/api/userprefs', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // Signed-out users get 401 — harmless to attempt.
    });
  } catch { /* offline / 401 — keep local copy */ }
}

/** Pull server-side prefs and overlay them into localStorage. Called
 * once at mount. Last-write-wins: server values overwrite local on
 * boot. Theme is excluded so per-device choice survives. */
export async function pullServerPrefs(): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    const r = await fetch('/api/userprefs');
    if (!r.ok) return;
    const j = (await r.json()) as Record<string, unknown>;
    for (const [k, v] of Object.entries(j)) {
      if (isLocalOnly(k)) continue;
      if (v == null) localStorage.removeItem(NS + k);
      else localStorage.setItem(NS + k, JSON.stringify(v));
    }
  } catch { /* offline / signed out — skip */ }
}

export type GroupSort = 'default' | 'title-asc' | 'title-desc' | 'newest' | 'oldest';
export type SectionGroupSort = 'default' | 'name-asc' | 'name-desc' | 'newest' | 'oldest';
