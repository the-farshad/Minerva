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
import { bus } from '@/lib/event-bus';
import { syncPaperShortcuts } from '@/lib/drive';

/** Normalise HTML entities so "Spring &#39;06" (the way YouTube's
 *  older metadata endpoints encode apostrophes) matches the literal
 *  "Spring '06" the user may have typed back into the rename input.
 *  Without this, rewrite-tag found 0 rows on titles imported from
 *  YouTube even when the user copy-pasted the visible group name. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
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
  /** Every row touched by this rewrite — fed to a single
   *  `rows.bulkChanged` SSE event after the loop so other tabs
   *  invalidate their cached row list once instead of N times. */
  const touched: string[] = [];

  // CRITICAL: only multiselect-typed columns get comma-split into a
  // membership list. A plain text column (`playlist` is typed as
  // text) whose VALUE happens to contain a comma — e.g.
  // "MIT 18.086 Mathematical Methods for Engineers II, Spring '06"
  // — must be matched as a single string, not split into fragments,
  // or the rename will report "0 rows" every time the title has a
  // comma in it. The earlier UI-side comma-split fix never made it
  // into this server route.
  const colIdx = sch.headers.indexOf(column);
  const colType = String(sch.types?.[colIdx] || '');
  const isMulti = /^multiselect\(/.test(colType) || /^select\(/.test(colType);

  // Compare against both the raw `from` and its HTML-decoded form
  // so callers can ship either flavour and still hit rows whose DB
  // value uses the other encoding.
  const fromDecoded = decodeEntities(from);
  const matchesFrom = (v: string): boolean =>
    v === from || v === fromDecoded || decodeEntities(v) === from || decodeEntities(v) === fromDecoded;

  for (const r of rows) {
    const data = r.data as Record<string, unknown>;
    const raw = String(data[column] ?? '');
    // For multiselect / select columns we split on commas and match
    // any token; for single-valued columns we compare the entire
    // value as a string. `list` is filled accordingly so the
    // downstream rewrite logic stays identical.
    const list = isMulti
      ? raw.split(',').map((s) => s.trim()).filter(Boolean)
      : (raw.trim() ? [raw.trim()] : []);
    const matchedAs = list.find(matchesFrom);
    if (!matchedAs) continue;

    // Strip `from`, optionally swap in `to`, dedupe preserving order.
    const next: string[] = [];
    for (const v of list) {
      if (v === matchedAs) continue;
      if (!next.includes(v)) next.push(v);
    }
    if (to && !next.includes(to)) next.push(to);
    // Single-valued columns get the literal `to` (or empty) written
    // back; multiselect columns get the comma-joined list.
    const joined = isMulti ? next.join(', ') : (next[0] ?? '');
    if (next.length === 0 && deleteOrphaned) {
      await db.update(schema.rows)
        .set({ deleted: true, updatedAt: new Date() })
        .where(eq(schema.rows.id, r.id));
      deleted += 1;
    } else {
      const nextData: Record<string, unknown> = { ...data, [column]: joined };
      // Papers + the category column → keep Drive shortcuts in step
      // with the rewritten category list. The real PDF lives in the
      // primary (first) category folder; every other category gets
      // a shortcut, and removed categories get their shortcuts
      // deleted. Tolerant: a Drive hiccup logs + continues.
      if (sec.preset === 'papers' && column === 'category' && next.length > 0) {
        const offline = String(data.offline || '');
        const m = offline.match(/drive:([\w-]{20,})/);
        if (m) {
          const fileId = m[1];
          const fileLeaf = String(data.title || 'paper').replace(/[^\w.\- ]+/g, '_').slice(0, 100) + '.pdf';
          const existing = (data._shortcuts as Record<string, string> | undefined) || {};
          try {
            const shortcuts = await syncPaperShortcuts(userId, fileId, fileLeaf, next[0], next, existing);
            if (Object.keys(shortcuts).length > 0) nextData._shortcuts = shortcuts;
            else delete nextData._shortcuts;
          } catch (e) {
            console.warn('[rewrite-tag] shortcuts:', (e as Error).message);
          }
        }
      }
      await db.update(schema.rows)
        .set({ data: nextData, updatedAt: new Date() })
        .where(eq(schema.rows.id, r.id));
      rewrote += 1;
      if (next.length > 0) stillTagged += 1;
    }
    touched.push(r.id);
  }

  // Keep the schema's option list in step with the bulk rewrite —
  // for `multiselect(...)` (categories on Papers) and for
  // `select(...)` (Tasks Kanban status). Without this, renaming a
  // Kanban column would leave the old name in the schema and the
  // new column would never appear.
  {
    const idx = sch.headers.indexOf(column);
    if (idx >= 0) {
      const typeStr = String(sch.types?.[idx] || '');
      const mMulti = typeStr.match(/^multiselect\(([^)]*)\)/);
      const mSel   = typeStr.match(/^select\(([^)]*)\)/);
      if (mMulti || mSel) {
        const raw = (mMulti?.[1] ?? mSel?.[1]) || '';
        const opts = raw.split(',').map((s) => s.trim()).filter(Boolean);
        const nextOpts: string[] = [];
        for (const v of opts) {
          if (v === from) continue;
          if (!nextOpts.includes(v)) nextOpts.push(v);
        }
        if (to && !nextOpts.includes(to)) nextOpts.push(to);
        const nextTypes = sch.types.slice();
        nextTypes[idx] = mMulti
          ? `multiselect(${nextOpts.join(', ')})`
          : `select(${nextOpts.join(',')})`;
        await db.update(schema.sections)
          .set({ schema: { headers: sch.headers, types: nextTypes }, updatedAt: new Date() })
          .where(eq(schema.sections.id, sec.id));
      }
    }
  }

  // Broadcast once: every open tab refetches the section's row
  // list (so a group rename or delete propagates without refresh).
  // Schema may also have changed (select/multiselect option list)
  // so we emit section.changed as well — the section sidebar
  // refetches and the CategoryBar picker picks up the new options.
  if (touched.length > 0) {
    bus.emit(userId, { kind: 'rows.bulkChanged', sectionSlug: sec.slug, rowIds: touched });
    bus.emit(userId, { kind: 'section.changed', sectionSlug: sec.slug });
  }

  return NextResponse.json({ rewrote, deleted, stillTagged });
}
