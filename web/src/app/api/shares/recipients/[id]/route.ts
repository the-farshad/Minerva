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
  const body = (await req.json().catch(() => ({}))) as { action?: 'accept' | 'decline' };
  const action = body.action;
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
