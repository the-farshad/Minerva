/**
 * GET /api/users/search?q=<prefix>
 *
 * Sharing Phase 1: discover other users by username prefix. Only
 * users with discoverable=true are returned. The signed-in user is
 * excluded from their own results — Compose-a-share doesn't need
 * "share with yourself" as an option.
 *
 * Up to 10 matches per query, sorted alphabetically. Query is
 * lowercased before matching since usernames are stored lower-case.
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, eq, ilike, ne, sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { db, schema } from '@/db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const q = (req.nextUrl.searchParams.get('q') || '').trim().toLowerCase();
  if (q.length < 2) return NextResponse.json({ results: [] });

  // ilike with `q + '%'` for a prefix match, capped to 10.
  // discoverable=true filters out users who opted out of search.
  const rows = await db
    .select({
      id: schema.users.id,
      username: schema.users.username,
      name: schema.users.name,
      image: schema.users.image,
    })
    .from(schema.users)
    .where(and(
      eq(schema.users.discoverable, true),
      ne(schema.users.id, userId),
      sql`${schema.users.username} IS NOT NULL`,
      ilike(schema.users.username, `${q}%`),
    ))
    .orderBy(schema.users.username)
    .limit(10);

  return NextResponse.json({ results: rows });
}
