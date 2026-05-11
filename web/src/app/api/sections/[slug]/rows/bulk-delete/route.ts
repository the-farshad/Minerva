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

    const body = (await req.json().catch(() => ({}))) as {
      ids?: string[];
      field?: string;     // 'playlist' | 'category' | 'kind' | ...
      value?: string;
      // legacy
      playlist?: string;
    };

    // Backwards-compat: old callers sent { playlist }; new callers
    // pass { field, value } so Papers (category), YouTube (playlist),
    // or any other groupable column can use the same endpoint.
    const field = body.field || (body.playlist != null ? 'playlist' : '');
    const value = body.value != null ? body.value : body.playlist;

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
    } else if (field && typeof value === 'string') {
      // Match either an exact value (single-valued columns like
      // `playlist`) OR the value as one of the comma-separated
      // entries inside a multiselect column (`category` on papers).
      // The grouped grid splits multiselect cells on `,` and keys
      // the group by the FIRST token, so exact-equality would miss
      // every row that has more than one category.
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) {
        return NextResponse.json({ error: 'Invalid field' }, { status: 400 });
      }
      // Regex-escape the value before splicing it into the pattern.
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = `(^|,\\s*)${escaped}(\\s*,|\\s*$)`;
      const res = await db.execute(
        sql`UPDATE rows SET deleted = true, "updatedAt" = NOW()
            WHERE "userId" = ${userId}
              AND "sectionId" = ${sec.id}
              AND (
                (data ->> ${field}) = ${value}
                OR (data ->> ${field}) ~ ${pattern}
              )
          RETURNING id`,
      );
      deleted = Array.isArray(res) ? res.length : ((res as unknown as { length: number }).length ?? 0);
    } else {
      return NextResponse.json({ error: 'Specify ids OR (field+value)' }, { status: 400 });
    }

    return NextResponse.json({ ok: true, deleted });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
