/**
 * POST   /api/shares/recipients/[id]   — { action: 'accept' | 'decline' }
 *
 * The recipient mutates their own row. Owner-side revocation goes
 * through DELETE /api/shares/[shareId] which sets revokedAt on the
 * share itself.
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { db, schema } from '@/db';
import { bus } from '@/lib/event-bus';

export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    action?: 'accept' | 'decline';
    /** Phase-4 inverse direction toggle — recipient opts in to
     *  exposing their watch_progress back to the owner. Independent
     *  of accept/decline; can be flipped any time after acceptance. */
    recipientShareProgress?: boolean;
  };
  const action = body.action;

  // Handle the progress-toggle action without changing accept
  // status. Allowed even after acceptance; ignored before.
  if (typeof body.recipientShareProgress === 'boolean' && !action) {
    const rec = await db.query.shareRecipients.findFirst({
      where: and(
        eq(schema.shareRecipients.id, id),
        eq(schema.shareRecipients.recipientUserId, userId),
      ),
    });
    if (!rec) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!rec.acceptedAt) return NextResponse.json({ error: 'Accept the share first.' }, { status: 400 });
    await db.update(schema.shareRecipients)
      .set({ recipientShareProgress: body.recipientShareProgress })
      .where(eq(schema.shareRecipients.id, id));
    const share = await db.query.shares.findFirst({
      where: eq(schema.shares.id, rec.shareId),
      columns: { id: true, ownerUserId: true },
    });
    if (share) bus.emit(share.ownerUserId, { kind: 'share.received', shareId: share.id });
    return NextResponse.json({ ok: true, recipientShareProgress: body.recipientShareProgress });
  }

  if (action !== 'accept' && action !== 'decline') {
    return NextResponse.json({ error: 'Invalid action.' }, { status: 400 });
  }

  const rec = await db.query.shareRecipients.findFirst({
    where: and(
      eq(schema.shareRecipients.id, id),
      eq(schema.shareRecipients.recipientUserId, userId),
    ),
  });
  if (!rec) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (action === 'accept') {
    await db.update(schema.shareRecipients)
      .set({ acceptedAt: new Date(), declinedAt: null })
      .where(eq(schema.shareRecipients.id, id));
  } else {
    await db.update(schema.shareRecipients)
      .set({ declinedAt: new Date(), acceptedAt: null })
      .where(eq(schema.shareRecipients.id, id));
  }

  // Notify the owner so their outgoing-shares list reflects the
  // accept/decline without a refresh.
  const share = await db.query.shares.findFirst({
    where: eq(schema.shares.id, rec.shareId),
    columns: { id: true, ownerUserId: true },
  });
  if (share) bus.emit(share.ownerUserId, { kind: 'share.received', shareId: share.id });

  return NextResponse.json({ ok: true });
}
