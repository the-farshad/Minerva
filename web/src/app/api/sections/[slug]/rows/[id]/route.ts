import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, schema } from '@/db';
import { eq, and } from 'drizzle-orm';

async function loadSectionAndRow(userId: string, slug: string, id: string) {
  const section = await db.query.sections.findFirst({
    where: and(eq(schema.sections.userId, userId), eq(schema.sections.slug, slug)),
  });
  if (!section) return null;
  const row = await db.query.rows.findFirst({
    where: and(
      eq(schema.rows.userId, userId),
      eq(schema.rows.sectionId, section.id),
      eq(schema.rows.id, id),
    ),
  });
  return row ? { section, row } : null;
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string; id: string }> },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const { slug, id } = await ctx.params;
  const ref = await loadSectionAndRow(userId, slug, id);
  if (!ref) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = (await req.json()) as { data?: Record<string, unknown> };
  const merged = { ...(ref.row.data as Record<string, unknown>), ...(body.data ?? {}) };
  const [updated] = await db.update(schema.rows)
    .set({ data: merged, updatedAt: new Date() })
    .where(eq(schema.rows.id, id))
    .returning();
  return NextResponse.json({
    id: updated.id,
    data: updated.data,
    updatedAt: updated.updatedAt.toISOString(),
  });
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ slug: string; id: string }> },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const { slug, id } = await ctx.params;
  const ref = await loadSectionAndRow(userId, slug, id);
  if (!ref) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await db.update(schema.rows)
    .set({ deleted: true, updatedAt: new Date() })
    .where(eq(schema.rows.id, id));
  return NextResponse.json({ ok: true });
}
