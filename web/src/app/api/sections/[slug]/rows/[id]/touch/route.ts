import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, schema } from '@/db';
import { eq, and } from 'drizzle-orm';

/**
 * POST /api/sections/[slug]/rows/[id]/touch
 *
 * Records that the row was just opened — sets `data._accessedAt` to
 * now. Deliberately does NOT bump the row's `updatedAt`: opening a
 * row is not editing it, and conflating the two would pollute the
 * "recently edited" sort and the info-pane "Edited" line.
 *
 * Fire-and-forget from the client, which also debounces it so
 * re-opening the same row within a few minutes doesn't write again.
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ slug: string; id: string }> },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const { slug, id } = await ctx.params;

  const section = await db.query.sections.findFirst({
    where: and(eq(schema.sections.userId, userId), eq(schema.sections.slug, slug)),
  });
  if (!section) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const row = await db.query.rows.findFirst({
    where: and(
      eq(schema.rows.userId, userId),
      eq(schema.rows.sectionId, section.id),
      eq(schema.rows.id, id),
    ),
  });
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const merged = {
    ...(row.data as Record<string, unknown>),
    _accessedAt: new Date().toISOString(),
  };
  // No `updatedAt` in the set — see the comment above.
  await db.update(schema.rows)
    .set({ data: merged })
    .where(eq(schema.rows.id, id));

  return NextResponse.json({ ok: true });
}
