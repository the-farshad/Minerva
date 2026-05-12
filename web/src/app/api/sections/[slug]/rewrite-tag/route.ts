/**
 * Rename or remove a value from a comma-list column (`category`,
 * `playlist`, …) across every row in the section. Handles the
 * multi-cat semantics:
 *
 *   POST /api/sections/<slug>/rewrite-tag
 *     { column: 'category' | 'playlist' | …,
 *       from: 'old name',
 *       to:   'new name' | null,     // null = remove
 *       deleteOrphaned?: boolean }   // delete rows that have only this value
 *
 * For each row whose `data[column]` contains `from`:
 *   - parse the comma list, strip `from`
 *   - if `to` is a non-empty string, add `to` (dedupe)
 *   - if the resulting list is empty AND `deleteOrphaned` is true,
 *     soft-delete the row
 *   - otherwise PATCH `data[column]` to the new value
 *
 * When `column === 'category'` and the section's schema declares
 * `multiselect(...)`, the option list is rewritten too — so the
 * CategoryBar picker stays in sync without a second round trip.
 *
 * Response: { rewrote: N, deleted: M, stillTagged: K }.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, schema } from '@/db';
import { eq, and } from 'drizzle-orm';

function splitList(v: unknown): string[] {
  return String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const { slug } = await ctx.params;

  const sec = await db.query.sections.findFirst({
    where: and(eq(schema.sections.userId, userId), eq(schema.sections.slug, slug)),
  });
  if (!sec) return NextResponse.json({ error: 'Section not found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as {
    column?: string;
    from?: string;
    to?: string | null;
    deleteOrphaned?: boolean;
  };
  const column = String(body.column || '').trim();
  const from = String(body.from || '').trim();
  const toRaw = body.to == null ? null : String(body.to).trim();
  const to = toRaw && toRaw.length ? toRaw : null;
  const deleteOrphaned = !!body.deleteOrphaned;
  if (!column || !from) {
    return NextResponse.json({ error: '`column` and `from` are required.' }, { status: 400 });
  }
  const sch = (sec.schema as { headers: string[]; types: string[] }) || { headers: [], types: [] };
  if (!sch.headers.includes(column)) {
    return NextResponse.json({ error: `Section has no column "${column}".` }, { status: 400 });
  }
  if (to === from) {
    return NextResponse.json({ rewrote: 0, deleted: 0, stillTagged: 0 });
  }

  const rows = await db.query.rows.findMany({
    where: and(
      eq(schema.rows.userId, userId),
      eq(schema.rows.sectionId, sec.id),
      eq(schema.rows.deleted, false),
    ),
  });

  let rewrote = 0;
  let deleted = 0;
  let stillTagged = 0;

  for (const r of rows) {
    const data = r.data as Record<string, unknown>;
    const list = splitList(data[column]);
    if (!list.includes(from)) continue;
    // Strip `from`, optionally swap in `to`, dedupe preserving order.
    const next: string[] = [];
    for (const v of list) {
      if (v === from) continue;
      if (!next.includes(v)) next.push(v);
    }
    if (to && !next.includes(to)) next.push(to);
    const joined = next.join(', ');
    if (next.length === 0 && deleteOrphaned) {
      await db.update(schema.rows)
        .set({ deleted: true, updatedAt: new Date() })
        .where(eq(schema.rows.id, r.id));
      deleted += 1;
    } else {
      const nextData = { ...data, [column]: joined };
      await db.update(schema.rows)
        .set({ data: nextData, updatedAt: new Date() })
        .where(eq(schema.rows.id, r.id));
      rewrote += 1;
      if (next.length > 0) stillTagged += 1;
    }
  }

  // Schema's multiselect (currently only `category`) — keep the
  // picker vocabulary in step with the bulk rewrite.
  if (column === 'category') {
    const idx = sch.headers.indexOf(column);
    if (idx >= 0) {
      const typeStr = String(sch.types?.[idx] || '');
      const m = typeStr.match(/^multiselect\(([^)]*)\)/);
      const opts = m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
      const nextOpts: string[] = [];
      for (const v of opts) {
        if (v === from) continue;
        if (!nextOpts.includes(v)) nextOpts.push(v);
      }
      if (to && !nextOpts.includes(to)) nextOpts.push(to);
      const nextTypes = sch.types.slice();
      nextTypes[idx] = `multiselect(${nextOpts.join(', ')})`;
      await db.update(schema.sections)
        .set({ schema: { headers: sch.headers, types: nextTypes }, updatedAt: new Date() })
        .where(eq(schema.sections.id, sec.id));
    }
  }

  return NextResponse.json({ rewrote, deleted, stillTagged });
}
