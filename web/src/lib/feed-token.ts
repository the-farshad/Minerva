/**
 * Per-user secret token used to authenticate feed subscriptions
 * (iCal, RSS) and the bookmarklet — clients that can't send a
 * session cookie. Stored as `feedToken` inside `userPrefs.data`.
 */
import { eq } from 'drizzle-orm';
import { db, schema } from '@/db';

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function getOrCreateFeedToken(userId: string): Promise<string> {
  const row = await db.query.userPrefs.findFirst({
    where: eq(schema.userPrefs.userId, userId),
  });
  const data = (row?.data as Record<string, unknown>) || {};
  const existing = typeof data.feedToken === 'string' ? data.feedToken : null;
  if (existing) return existing;
  const tok = randomToken();
  if (row) {
    await db.update(schema.userPrefs)
      .set({ data: { ...data, feedToken: tok }, updatedAt: new Date() })
      .where(eq(schema.userPrefs.userId, userId));
  } else {
    await db.insert(schema.userPrefs).values({ userId, data: { feedToken: tok } });
  }
  return tok;
}

export async function rotateFeedToken(userId: string): Promise<string> {
  const tok = randomToken();
  const row = await db.query.userPrefs.findFirst({
    where: eq(schema.userPrefs.userId, userId),
  });
  const data = (row?.data as Record<string, unknown>) || {};
  if (row) {
    await db.update(schema.userPrefs)
      .set({ data: { ...data, feedToken: tok }, updatedAt: new Date() })
      .where(eq(schema.userPrefs.userId, userId));
  } else {
    await db.insert(schema.userPrefs).values({ userId, data: { feedToken: tok } });
  }
  return tok;
}

export async function userIdFromFeedToken(token: string): Promise<string | null> {
  if (!token || typeof token !== 'string') return null;
  // Linear scan is fine: per-user one row, total < 10k for the
  // foreseeable future. If this grows, add a GIN index on the JSONB.
  const all = await db.query.userPrefs.findMany();
  for (const row of all) {
    const t = (row.data as Record<string, unknown>)?.feedToken;
    if (typeof t === 'string' && t === token) return row.userId;
  }
  return null;
}
