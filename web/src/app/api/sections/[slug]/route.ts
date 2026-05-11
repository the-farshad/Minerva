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
  };
  const patch: Partial<typeof schema.sections.$inferInsert> = {};
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
  if (typeof body.title === 'string' && body.title.trim()) patch.title = body.title.trim();
  if (typeof body.order === 'number' && Number.isFinite(body.order)) patch.order = body.order;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }
  patch.updatedAt = new Date();

  const [updated] = await db.update(schema.sections)
    .set(patch)
    .where(eq(schema.sections.id, sec.id))
    .returning();
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
    return NextResponse.json({ ok: true, purged: true });
  }
  await db.update(schema.sections)
    .set({ enabled: false, updatedAt: new Date() })
    .where(eq(schema.sections.id, sec.id));
  return NextResponse.json({ ok: true, hidden: true });
}
