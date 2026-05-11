/**
 * One-shot bulk delete inside a section. Pass either an explicit
 * list of row ids, or a `playlist` value to delete every row whose
 * `data.playlist` matches. Soft-delete (sets deleted=true) — same
 * semantics as the per-row DELETE.
 *
 *   POST /api/sections/<slug>/rows/bulk-delete
 *     { ids?: string[], playlist?: string }
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, schema } from '@/db';
import { eq, and, inArray, sql } from 'drizzle-orm';

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = (session.user as { id: string }).id;
    const { slug } = await ctx.params;
    const sec = await db.query.sections.findFirst({
      where: and(eq(schema.sections.userId, userId), eq(schema.sections.slug, slug)),
    });
    if (!sec) return NextResponse.json({ error: 'Section not found' }, { status: 404 });

    const body = (await req.json().catch(() => ({}))) as { ids?: string[]; playlist?: string };

    let deleted = 0;
    if (Array.isArray(body.ids) && body.ids.length > 0) {
      const res = await db.update(schema.rows)
        .set({ deleted: true, updatedAt: new Date() })
        .where(and(
          eq(schema.rows.userId, userId),
          eq(schema.rows.sectionId, sec.id),
          inArray(schema.rows.id, body.ids),
        ))
        .returning({ id: schema.rows.id });
      deleted = res.length;
    } else if (typeof body.playlist === 'string') {
      // JSONB equality on data->>'playlist'. Match exactly the value
      // the caller scoped the bulk action to.
      const res = await db.update(schema.rows)
        .set({ deleted: true, updatedAt: new Date() })
        .where(and(
          eq(schema.rows.userId, userId),
          eq(schema.rows.sectionId, sec.id),
          sql`(data ->> 'playlist') = ${body.playlist}`,
        ))
        .returning({ id: schema.rows.id });
      deleted = res.length;
    } else {
      return NextResponse.json({ error: 'Specify ids or playlist' }, { status: 400 });
    }

    return NextResponse.json({ ok: true, deleted });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
