/**
 * GET  /api/users/me     — return the signed-in user's public profile
 *                          (username, discoverable, display name).
 * PATCH /api/users/me    — update username and/or discoverable.
 *
 * Sharing Phase 1: the foundation other users will search against
 * when picking a recipient. Username is the only field that needs
 * uniqueness; the rest are local prefs.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { db, schema } from '@/db';

export const dynamic = 'force-dynamic';

const USERNAME_RE = /^[a-z][a-z0-9-]{2,23}$/;

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const row = await db.query.users.findFirst({
    where: eq(schema.users.id, userId),
    columns: { id: true, name: true, image: true, username: true, discoverable: true },
  });
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(row);
}

export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const body = (await req.json().catch(() => ({}))) as {
    username?: string | null;
    discoverable?: boolean;
  };

  const patch: { username?: string | null; discoverable?: boolean } = {};

  if (body.username !== undefined) {
    if (body.username === null || body.username === '') {
      patch.username = null;
    } else {
      const candidate = String(body.username).trim().toLowerCase();
      if (!USERNAME_RE.test(candidate)) {
        return NextResponse.json({
          error: 'Username must be 3–24 chars, start with a letter, and contain only a–z, 0–9, or hyphen.',
        }, { status: 400 });
      }
      // Case-insensitive duplicate check.
      const taken = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(sql`lower(${schema.users.username}) = ${candidate}`)
        .limit(1);
      if (taken.length > 0 && taken[0].id !== userId) {
        return NextResponse.json({ error: 'That username is taken.' }, { status: 409 });
      }
      patch.username = candidate;
    }
  }

  if (typeof body.discoverable === 'boolean') {
    patch.discoverable = body.discoverable;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No-op patch.' }, { status: 400 });
  }

  await db.update(schema.users).set(patch).where(eq(schema.users.id, userId));
  return NextResponse.json({ ok: true, ...patch });
}
