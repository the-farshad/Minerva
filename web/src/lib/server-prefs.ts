/**
 * Server-side userpref accessor. Reads/writes `userPrefs.data.server`,
 * a slice that is NEVER returned by GET /api/userprefs (which only
 * exposes `data.client`). Use this for anything that must not leak
 * into the browser bundle — API keys, OAuth tokens stored outside the
 * NextAuth tables, etc.
 */
import { eq } from 'drizzle-orm';
import { db, schema } from '@/db';

export async function getServerPref<T = unknown>(
  userId: string,
  key: string,
): Promise<T | null> {
  const row = await db.query.userPrefs.findFirst({
    where: eq(schema.userPrefs.userId, userId),
  });
  const data = (row?.data as Record<string, unknown>) || {};
  const server = (data.server as Record<string, unknown>) || {};
  const v = server[key];
  return v == null ? null : (v as T);
}

export async function setServerPref(
  userId: string,
  key: string,
  value: unknown,
): Promise<void> {
  const row = await db.query.userPrefs.findFirst({
    where: eq(schema.userPrefs.userId, userId),
  });
  const data = (row?.data as Record<string, unknown>) || {};
  const server = (data.server as Record<string, unknown>) || {};
  const nextServer = { ...server };
  if (value === null || value === undefined || value === '') {
    delete nextServer[key];
  } else {
    nextServer[key] = value;
  }
  const nextData = { ...data, server: nextServer };
  if (row) {
    await db.update(schema.userPrefs)
      .set({ data: nextData, updatedAt: new Date() })
      .where(eq(schema.userPrefs.userId, userId));
  } else {
    await db.insert(schema.userPrefs).values({ userId, data: nextData });
  }
}

export async function listServerPrefKeys(userId: string): Promise<string[]> {
  const row = await db.query.userPrefs.findFirst({
    where: eq(schema.userPrefs.userId, userId),
  });
  const data = (row?.data as Record<string, unknown>) || {};
  const server = (data.server as Record<string, unknown>) || {};
  return Object.keys(server);
}
