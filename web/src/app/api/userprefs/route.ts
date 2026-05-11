/**
 * Per-user client prefs sync. localStorage is the source of truth on
 * each device; this endpoint snapshots the namespace into PG so a
 * fresh device can rehydrate it. The body is opaque — clients merge
 * shallowly. Theme stays per-device (excluded by the client).
 *
 *   GET   /api/userprefs       — returns `data.client` (object)
 *   PATCH /api/userprefs       — shallow-merges into `data.client`
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { db, schema } from '@/db';

async function readClient(userId: string): Promise<Record<string, unknown>> {
  const row = await db.query.userPrefs.findFirst({
    where: eq(schema.userPrefs.userId, userId),
  });
  const data = (row?.data as Record<string, unknown>) || {};
  return (data.client as Record<string, unknown>) || {};
}

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  return NextResponse.json(await readClient(userId));
}

export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const patch = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof patch !== 'object' || patch === null) {
    return NextResponse.json({ error: 'Body must be an object' }, { status: 400 });
  }
  const row = await db.query.userPrefs.findFirst({
    where: eq(schema.userPrefs.userId, userId),
  });
  const data = (row?.data as Record<string, unknown>) || {};
  const client = (data.client as Record<string, unknown>) || {};
  const nextClient: Record<string, unknown> = { ...client };
  // Apply each key; `null` deletes.
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete nextClient[k];
    else nextClient[k] = v;
  }
  const nextData = { ...data, client: nextClient };
  if (row) {
    await db.update(schema.userPrefs)
      .set({ data: nextData, updatedAt: new Date() })
      .where(eq(schema.userPrefs.userId, userId));
  } else {
    await db.insert(schema.userPrefs).values({ userId, data: nextData });
  }
  return NextResponse.json({ ok: true, client: nextClient });
}
