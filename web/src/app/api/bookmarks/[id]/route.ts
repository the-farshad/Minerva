import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, schema } from '@/db';
import { eq, and } from 'drizzle-orm';
import { bus } from '@/lib/event-bus';

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { label?: string; note?: string; ref?: number };
  const patch: Partial<typeof schema.bookmarks.$inferInsert> = {};
  if (typeof body.label === 'string') patch.label = body.label.slice(0, 200);
  if (typeof body.note === 'string') patch.note = body.note.slice(0, 5000);
  if (typeof body.ref === 'number') patch.ref = Math.max(0, Math.floor(body.ref));
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  const [updated] = await db.update(schema.bookmarks)
    .set(patch)
    .where(and(eq(schema.bookmarks.id, id), eq(schema.bookmarks.userId, userId)))
    .returning();
  if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  bus.emit(userId, { kind: 'bookmark.changed', url: updated.url, op: 'updated' });
  return NextResponse.json(updated);
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const { id } = await ctx.params;
  const [deleted] = await db.delete(schema.bookmarks)
    .where(and(eq(schema.bookmarks.id, id), eq(schema.bookmarks.userId, userId)))
    .returning();
  if (!deleted) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  bus.emit(userId, { kind: 'bookmark.changed', url: deleted.url, op: 'deleted' });
  return NextResponse.json({ ok: true });
}
