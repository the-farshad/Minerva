/**
 * Meeting-poll primitives shared between the composer page, the
 * public participant view, and the API. The legacy SPA used these
 * same shapes (compact JSON encoded into a URL token); the v2 build
 * stores the same objects in PG so URLs stay short and responses
 * can't race each other.
 */

export type PollSlots = {
  /** Hour the day's slot range starts (0–23). */
  fromHour: number;
  /** Hour the day's slot range ends (1–24, exclusive). */
  toHour: number;
  /** Minutes per slot. Common: 30, 60. */
  slotMin: number;
  /** IANA timezone of the organizer when they composed the poll —
   * displayed alongside the cells so a participant in a different
   * tz can sanity-check. */
  tz: string;
};

export type PollMode = 'group' | 'book';

export type Poll = {
  token: string;
  title: string;
  days: string[];      // ISO date strings, e.g. "2026-06-12"
  slots: PollSlots;
  closesAt: string | null;
  /** Free-text — Zoom URL, Meet URL, address, "TBD", … */
  location: string;
  /** "<dayIdx>:<slotIdx>" once the organizer locks in a final slot. */
  finalSlot: string | null;
  /** 'group' (default) — every participant marks a 0/1/? bit per
   *  cell, organizer reads the heat-map. 'book' — Calendly-style:
   *  each participant picks exactly one cell, first-come claims it. */
  mode: PollMode;
  /** True when a password is set on the poll. The plaintext is
   *  never returned to the client — participants type the password
   *  separately and the server compares hashes. */
  passwordSet: boolean;
};

export type PollResponse = {
  id: string;
  name: string;
  bits: string;
  note: string;
  createdAt: string;
};

/** Number of distinct time slots per day, given the slots block. */
export function slotsPerDay(slots: PollSlots): number {
  const hours = Math.max(0, slots.toHour - slots.fromHour);
  return Math.floor((hours * 60) / Math.max(1, slots.slotMin));
}

/** Total cells in the availability grid = days × slots-per-day. */
export function cellCount(poll: Pick<Poll, 'days' | 'slots'>): number {
  return poll.days.length * slotsPerDay(poll.slots);
}

/** Renders a human-readable label for a given slot index inside a
 * day (e.g. "09:30"). */
export function slotLabel(slots: PollSlots, slotIdx: number): string {
  const minutes = slots.fromHour * 60 + slotIdx * slots.slotMin;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Generate a short random poll token. 10 chars from a 36-symbol
 * alphabet gives ≈ 1.5e15 possibilities — plenty for a small
 * single-user system, no collision retry needed in practice. */
export function newPollToken(): string {
  let out = '';
  const buf = new Uint8Array(10);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  for (let i = 0; i < buf.length; i++) out += ALPHABET[buf[i] % ALPHABET.length];
  return out;
}

/** Hash a poll password with SHA-256. Same on the server and the
 * client so a participant can supply it once and we verify by
 * digest comparison without ever logging the plaintext. */
export async function hashPollPassword(plaintext: string): Promise<string> {
  const bytes = new TextEncoder().encode(plaintext);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex;
}

/** Sanity-check a slots block before persisting. Throws on invalid
 * input — callers wrap and surface as 400. */
export function validateSlots(s: unknown): PollSlots {
  if (typeof s !== 'object' || !s) throw new Error('slots must be an object');
  const x = s as Record<string, unknown>;
  const fromHour = Number(x.fromHour);
  const toHour = Number(x.toHour);
  const slotMin = Number(x.slotMin);
  const tz = String(x.tz || 'UTC');
  if (!Number.isInteger(fromHour) || fromHour < 0 || fromHour > 23) {
    throw new Error('slots.fromHour must be 0–23');
  }
  if (!Number.isInteger(toHour) || toHour <= fromHour || toHour > 24) {
    throw new Error('slots.toHour must be > fromHour and ≤ 24');
  }
  if (!Number.isInteger(slotMin) || ![15, 30, 60].includes(slotMin)) {
    throw new Error('slots.slotMin must be 15, 30, or 60');
  }
  return { fromHour, toHour, slotMin, tz };
}
