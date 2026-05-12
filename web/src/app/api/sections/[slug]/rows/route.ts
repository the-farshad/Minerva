import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, schema } from '@/db';
import { eq, and, asc } from 'drizzle-orm';
import { bus } from '@/lib/event-bus';

async function loadSection(userId: string, slug: string) {
  return db.query.sections.findFirst({
    where: and(
      eq(schema.sections.userId, userId),
      eq(schema.sections.slug, slug),
    ),
  });
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { slug } = await ctx.params;
  const userId = (session.user as { id: string }).id;

  const sec = await loadSection(userId, slug);
  if (!sec) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const rows = await db.query.rows.findMany({
    where: and(
      eq(schema.rows.userId, userId),
      eq(schema.rows.sectionId, sec.id),
      eq(schema.rows.deleted, false),
    ),
    orderBy: [asc(schema.rows.createdAt)],
  });
  return NextResponse.json(rows.map((r) => ({
    id: r.id,
    data: r.data,
    updatedAt: r.updatedAt.toISOString(),
  })));
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { slug } = await ctx.params;
  const userId = (session.user as { id: string }).id;
  const sec = await loadSection(userId, slug);
  if (!sec) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { data?: Record<string, unknown> };
  const data = body.data ?? {};

  const [inserted] = await db.insert(schema.rows).values({
    userId,
    sectionId: sec.id,
    data,
  }).returning();
  bus.emit(userId, {
    kind: 'row.created',
    sectionSlug: slug,
    rowId: inserted.id,
    data: inserted.data as Record<string, unknown>,
  });
  return NextResponse.json({
    id: inserted.id,
    data: inserted.data,
    updatedAt: inserted.updatedAt.toISOString(),
  });
}
