import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, schema } from '@/db';
import { eq, and, asc } from 'drizzle-orm';
import { PRESETS } from '@/lib/presets';

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;

  const rows = await db.query.sections.findMany({
    where: eq(schema.sections.userId, userId),
    orderBy: [asc(schema.sections.order)],
  });
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;

  const body = (await req.json().catch(() => ({}))) as {
    preset?: string;
    slug?: string;
    title?: string;
  };
  const presetSlug = body.preset || body.slug;
  if (!presetSlug) return NextResponse.json({ error: 'Missing preset or slug' }, { status: 400 });

  const preset = PRESETS.find((p) => p.slug === presetSlug);
  if (!preset) return NextResponse.json({ error: 'Unknown preset' }, { status: 404 });

  const existing = await db.query.sections.findFirst({
    where: and(eq(schema.sections.userId, userId), eq(schema.sections.slug, preset.slug)),
  });
  if (existing) {
    if (!existing.enabled) {
      const [revived] = await db.update(schema.sections)
        .set({ enabled: true, updatedAt: new Date() })
        .where(eq(schema.sections.id, existing.id))
        .returning();
      return NextResponse.json(revived);
    }
    return NextResponse.json(existing);
  }

  const order = (await db.query.sections.findMany({
    where: eq(schema.sections.userId, userId),
  })).length;
  const [created] = await db.insert(schema.sections).values({
    userId,
    slug: preset.slug,
    title: body.title || preset.title,
    icon: preset.icon,
    order,
    schema: preset.schema,
    defaultSort: preset.defaultSort,
    defaultFilter: preset.defaultFilter,
    enabled: true,
    preset: preset.preset,
  }).returning();
  return NextResponse.json(created);
}
