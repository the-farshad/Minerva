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
import { deleteDriveFile } from '@/lib/drive';
import { bus } from '@/lib/event-bus';

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

    // Collect rows we're about to delete so we can pull their Drive
    // file ids and clean those up afterwards. RETURNING handles the
    // count; the offline-marker scan happens in a separate read just
    // before the update so we don't lose the data.
    let deleted = 0;
    /** When the group field is a multiselect (e.g. `category`),
     * rows that carry MORE than just the targeted value shouldn't
     * be wiped — only the matching tag is stripped from their
     * data, the row stays. This number reports those untagged. */
    let untagged = 0;
    let driveIds: string[] = [];
    if (Array.isArray(body.ids) && body.ids.length > 0) {
      const toGo = await db.query.rows.findMany({
        where: and(
          eq(schema.rows.userId, userId),
          eq(schema.rows.sectionId, sec.id),
          inArray(schema.rows.id, body.ids),
        ),
      });
      driveIds = toGo
        .flatMap((r) => {
          const d = r.data as Record<string, unknown>;
          const offlineIds = Array.from(String(d.offline || '').matchAll(/drive:([\w-]{20,})/g)).map((m) => m[1]);
          const origId = String(d.originalFileId || '').trim();
          return origId ? [...offlineIds, origId] : offlineIds;
        });
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

      // Is the targeted column a multiselect? If so, rows that
      // carry the targeted value alongside OTHER values should
      // only have that one tag stripped, not be deleted outright.
      // Single-valued columns (e.g. `playlist`) keep the legacy
      // behaviour where everything in the group goes away.
      const headers = (sec.schema as { headers?: string[] }).headers || [];
      const types = (sec.schema as { types?: string[] }).types || [];
      const colIdx = headers.indexOf(field);
      const isMulti = colIdx >= 0 && /^multiselect\(/.test(String(types[colIdx] || ''));

      // Pre-fetch the rows we're about to act on so we can scrub
      // their Drive copies after the update (for the full-delete
      // batch) and so we can compute the untag patch (for the
      // multi-tagged batch).
      const toGo = await db.execute<{ id: string; data: Record<string, unknown> }>(
        sql`SELECT id, data FROM rows
            WHERE "userId" = ${userId}
              AND "sectionId" = ${sec.id}
              AND deleted = false
              AND ((data ->> ${field}) = ${value} OR (data ->> ${field}) ~ ${pattern})`,
      );
      const toGoRows = Array.isArray(toGo) ? toGo : ((toGo as unknown as { rows?: { id: string; data: Record<string, unknown> }[] }).rows || []);

      // Partition: rows whose entire field value is just this one
      // tag get fully deleted; rows with more than one tag get the
      // targeted tag stripped and stay alive.
      const toDelete: string[] = [];
      const toUntag: { id: string; data: Record<string, unknown> }[] = [];
      for (const r of toGoRows) {
        const raw = String((r.data || {})[field] || '');
        const tokens = raw.split(',').map((s) => s.trim()).filter(Boolean);
        if (isMulti && tokens.length > 1) {
          const remaining = tokens.filter((t) => t !== value);
          toUntag.push({ id: r.id, data: { ...(r.data || {}), [field]: remaining.join(', ') } });
        } else {
          toDelete.push(r.id);
        }
      }

      driveIds = toGoRows
        .filter((r) => toDelete.includes(r.id))
        .flatMap((r) => {
          const d = r.data || {};
          const offlineIds = Array.from(String(d.offline || '').matchAll(/drive:([\w-]{20,})/g)).map((m) => m[1]);
          const origId = String(d.originalFileId || '').trim();
          return origId ? [...offlineIds, origId] : offlineIds;
        });

      if (toDelete.length > 0) {
        const res = await db.update(schema.rows)
          .set({ deleted: true, updatedAt: new Date() })
          .where(and(
            eq(schema.rows.userId, userId),
            eq(schema.rows.sectionId, sec.id),
            inArray(schema.rows.id, toDelete),
          ))
          .returning({ id: schema.rows.id });
        deleted = res.length;
      }
      if (toUntag.length > 0) {
        // No bulk-set-jsonb in Drizzle — issue per-row patches in
        // parallel. The per-row count is small in practice (one
        // category's worth of multi-tagged rows) so this is fine.
        await Promise.all(toUntag.map((r) => db.update(schema.rows)
          .set({ data: r.data, updatedAt: new Date() })
          .where(and(
            eq(schema.rows.userId, userId),
            eq(schema.rows.sectionId, sec.id),
            eq(schema.rows.id, r.id),
          ))));
        untagged = toUntag.length;
      }
    } else {
      return NextResponse.json({ error: 'Specify ids OR (field+value)' }, { status: 400 });
    }

    // Fire-and-await Drive cleanups in parallel so the call doesn't
    // return until they've all been attempted. Each one is
    // self-tolerant (404 / network failure → silent).
    if (driveIds.length) {
      await Promise.all(driveIds.map((fid) => deleteDriveFile(userId, fid)));
    }
    // Broadcast once: every open tab on this section invalidates
    // its cached row list. We don't itemise the IDs in the payload
    // for an ids-mode delete (the client only needs to know *that*
    // the list changed) — passing an empty `rowIds: []` is the
    // signal "refetch this section."
    if (deleted > 0 || untagged > 0) {
      bus.emit(userId, { kind: 'rows.bulkChanged', sectionSlug: sec.slug, rowIds: [] });
    }
    return NextResponse.json({ ok: true, deleted, untagged, driveDeleted: driveIds.length });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
