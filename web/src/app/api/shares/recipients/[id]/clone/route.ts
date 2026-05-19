/**
 * POST /api/shares/recipients/[id]/clone
 *
 * Recipient action: duplicate the shared content into a brand-new
 * section in the recipient's own library so they own it
 * independently of the share. Scopes:
 *
 *   section — clone the section's preset + schema + every row
 *   group   — clone the schema; copy only rows matching the group
 *   row     — not yet supported (would need a target-section
 *             picker; the user can use 'Add to library' from
 *             /lit's lookup flow instead).
 *
 * Returns the new section slug so the caller can redirect there.
 */
import { NextResponse } from 'next/server';
import { and, eq, isNull } from 'drizzle-orm';
import { auth } from '@/auth';
import { db, schema } from '@/db';
import { bus } from '@/lib/event-bus';

export const dynamic = 'force-dynamic';

function uniqueSlug(base: string): string {
  // Append a 6-char random suffix so a re-clone doesn't collide.
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes).map((b) => b.toString(36)).join('').slice(0, 6);
  return `${base.replace(/[^a-z0-9-]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40)}-${suffix}`;
}

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const { id } = await ctx.params;

  const rec = await db.query.shareRecipients.findFirst({
    where: and(
      eq(schema.shareRecipients.id, id),
      eq(schema.shareRecipients.recipientUserId, userId),
    ),
  });
  if (!rec || !rec.acceptedAt) return NextResponse.json({ error: 'Share not accepted.' }, { status: 404 });

  const share = await db.query.shares.findFirst({
    where: and(eq(schema.shares.id, rec.shareId), isNull(schema.shares.revokedAt)),
  });
  if (!share) return NextResponse.json({ error: 'Share has been revoked.' }, { status: 404 });

  let sourceSection: typeof schema.sections.$inferSelect | undefined;
  let sourceRows: (typeof schema.rows.$inferSelect)[] = [];

  if (share.scope === 'section') {
    sourceSection = await db.query.sections.findFirst({ where: eq(schema.sections.id, share.targetId) });
    if (!sourceSection) return NextResponse.json({ error: 'Source missing.' }, { status: 404 });
    sourceRows = await db.query.rows.findMany({ where: eq(schema.rows.sectionId, sourceSection.id) });
  } else if (share.scope === 'group') {
    const [sectionId, ...rest] = share.targetId.split(':');
    const groupKey = rest.join(':');
    sourceSection = await db.query.sections.findFirst({ where: eq(schema.sections.id, sectionId) });
    if (!sourceSection) return NextResponse.json({ error: 'Source missing.' }, { status: 404 });
    const all = await db.query.rows.findMany({ where: eq(schema.rows.sectionId, sourceSection.id) });
    const groupCol = sourceSection.preset === 'youtube' ? 'playlist' : 'category';
    sourceRows = all.filter((r) => {
      const data = r.data as Record<string, unknown>;
      const v = data[groupCol];
      const vs = typeof v === 'string' ? v.split(/,\s*/) : [];
      return vs.includes(groupKey);
    });
  } else {
    return NextResponse.json({
      error: 'Row-scope cloning is not supported. Use Add to library from the row preview instead.',
    }, { status: 400 });
  }

  const baseTitle = share.scope === 'group'
    ? `${share.targetId.split(':').slice(1).join(':')} (from @share)`
    : `${sourceSection.title} (cloned)`;
  const slug = uniqueSlug(baseTitle);

  const [destSection] = await db.insert(schema.sections).values({
    userId,
    title: baseTitle,
    slug,
    preset: sourceSection.preset,
    schema: sourceSection.schema,
  }).returning();

  if (sourceRows.length > 0) {
    await db.insert(schema.rows).values(
      sourceRows.map((r) => ({
        userId,
        sectionId: destSection.id,
        data: r.data,
      })),
    );
  }

  bus.emit(userId, { kind: 'sections.listChanged' });
  return NextResponse.json({
    sectionId: destSection.id,
    slug: destSection.slug,
    rowCount: sourceRows.length,
  });
}
