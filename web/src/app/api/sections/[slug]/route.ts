/**
 * Per-section management — toggle enabled, rename, or delete.
 *
 *   PATCH /api/sections/<slug>   { enabled?: boolean, title?: string }
 *   DELETE /api/sections/<slug>            soft delete (rows stay)
 *   DELETE /api/sections/<slug>?purge=1    hard delete (drops rows)
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, schema } from '@/db';
import { eq, and } from 'drizzle-orm';
import { bus } from '@/lib/event-bus';

async function loadOwn(userId: string, slug: string) {
  return db.query.sections.findFirst({
    where: and(eq(schema.sections.userId, userId), eq(schema.sections.slug, slug)),
  });
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const { slug } = await ctx.params;
  const sec = await loadOwn(userId, slug);
  if (!sec) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as {
    enabled?: boolean;
    title?: string;
    order?: number;
    /** Replace the `multiselect(...)` option list for a column on
     * the section schema. The Categories dialog uses this to add
     * / remove category values without forcing the user to drop
     * the section. */
    setMultiselect?: { column: string; options: string[] };
    /** Replace the `select(...)` option list for a column on the
     *  section schema. The Kanban "+ Column" / rename / delete
     *  controls use this to manage status values without forcing
     *  a schema migration. */
    setSelect?: { column: string; options: string[] };
  };
  const patch: Partial<typeof schema.sections.$inferInsert> = {};
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
  if (typeof body.title === 'string' && body.title.trim()) patch.title = body.title.trim();
  if (typeof body.order === 'number' && Number.isFinite(body.order)) patch.order = body.order;
  if (body.setMultiselect && typeof body.setMultiselect.column === 'string') {
    const sch = (sec.schema as { headers: string[]; types: string[] }) || { headers: [], types: [] };
    const idx = sch.headers.indexOf(body.setMultiselect.column);
    if (idx < 0) {
      return NextResponse.json({ error: `Section has no column "${body.setMultiselect.column}".` }, { status: 400 });
    }
    const cleaned = Array.from(new Set(
      (body.setMultiselect.options || [])
        .map((s) => String(s).trim())
        .filter(Boolean),
    ));
    const nextTypes = sch.types.slice();
    nextTypes[idx] = `multiselect(${cleaned.join(', ')})`;
    patch.schema = { headers: sch.headers, types: nextTypes } as typeof schema.sections.$inferInsert.schema;
  }
  if (body.setSelect && typeof body.setSelect.column === 'string') {
    const sch = (sec.schema as { headers: string[]; types: string[] }) || { headers: [], types: [] };
    const idx = sch.headers.indexOf(body.setSelect.column);
    if (idx < 0) {
      return NextResponse.json({ error: `Section has no column "${body.setSelect.column}".` }, { status: 400 });
    }
    const cleaned = Array.from(new Set(
      (body.setSelect.options || [])
        .map((s) => String(s).trim())
        .filter(Boolean),
    ));
    if (cleaned.length === 0) {
      return NextResponse.json({ error: 'At least one option is required.' }, { status: 400 });
    }
    const nextTypes = sch.types.slice();
    nextTypes[idx] = `select(${cleaned.join(',')})`;
    patch.schema = { headers: sch.headers, types: nextTypes } as typeof schema.sections.$inferInsert.schema;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }
  patch.updatedAt = new Date();

  const [updated] = await db.update(schema.sections)
    .set(patch)
    .where(eq(schema.sections.id, sec.id))
    .returning();
  // Broadcast the change so the sidebar + any open section view
  // refetch. Title changes don't currently rewrite the slug — the
  // slug is stable — but if that ever changes the section.renamed
  // event will carry both so other tabs can redirect.
  bus.emit(userId, { kind: 'section.changed', sectionSlug: sec.slug });
  if (patch.title && patch.title !== sec.title) {
    bus.emit(userId, {
      kind: 'section.renamed',
      oldSlug: sec.slug,
      newSlug: updated.slug,
      title: updated.title,
    });
  }
  bus.emit(userId, { kind: 'sections.listChanged' });
  return NextResponse.json(updated);
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const { slug } = await ctx.params;
  const sec = await loadOwn(userId, slug);
  if (!sec) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const purge = req.nextUrl.searchParams.get('purge') === '1';
  if (purge) {
    await db.delete(schema.sections).where(eq(schema.sections.id, sec.id));
    bus.emit(userId, { kind: 'sections.listChanged' });
    return NextResponse.json({ ok: true, purged: true });
  }
  await db.update(schema.sections)
    .set({ enabled: false, updatedAt: new Date() })
    .where(eq(schema.sections.id, sec.id));
  bus.emit(userId, { kind: 'sections.listChanged' });
  return NextResponse.json({ ok: true, hidden: true });
}
