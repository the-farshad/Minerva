/**
 * Cross-section text search over the current user's rows + sections.
 * Lightweight: ILIKE against the row's JSONB cast to text. With
 * Postgres GIN indexing on the data JSONB this scales fine to
 * the personal-app scale (~tens of thousands of rows).
 *
 *   GET /api/search?q=<query>
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, schema } from '@/db';
import { sql, and, eq } from 'drizzle-orm';

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const q = (req.nextUrl.searchParams.get('q') || '').trim();
  if (!q) return NextResponse.json({ rows: [], sections: [] });

  const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
  const limit = Math.min(50, Number(req.nextUrl.searchParams.get('limit') || 20));

  const result = await db.execute(sql`
    select r.id, r."sectionId", r.data, r."updatedAt", s.slug as "sectionSlug", s.title as "sectionTitle"
    from ${schema.rows} r
    join ${schema.sections} s on s.id = r."sectionId"
    where r."userId" = ${userId}
      and r.deleted = false
      and r.data::text ilike ${like}
    order by r."updatedAt" desc
    limit ${limit}
  `) as unknown as Record<string, unknown>[];

  const sections = await db.query.sections.findMany({
    where: and(eq(schema.sections.userId, userId), eq(schema.sections.enabled, true)),
  });
  const matchingSections = sections.filter((s) => s.title.toLowerCase().includes(q.toLowerCase()));

  return NextResponse.json({ rows: result, sections: matchingSections });
}
