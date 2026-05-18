/**
 * DELETE /api/shares/[id] — owner revokes a share. All recipients
 *                            lose access immediately.
 */
import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { db, schema } from '@/db';
import { bus } from '@/lib/event-bus';

export const dynamic = 'force-dynamic';

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const { id } = await ctx.params;

  const share = await db.query.shares.findFirst({
    where: and(eq(schema.shares.id, id), eq(schema.shares.ownerUserId, userId)),
  });
  if (!share) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await db.update(schema.shares)
    .set({ revokedAt: new Date() })
    .where(eq(schema.shares.id, id));

  // Notify recipients so any open inbox refreshes.
  const recipients = await db
    .select({ userId: schema.shareRecipients.recipientUserId })
    .from(schema.shareRecipients)
    .where(eq(schema.shareRecipients.shareId, id));
  for (const r of recipients) {
    if (r.userId) bus.emit(r.userId, { kind: 'share.received', shareId: id });
  }

  return NextResponse.json({ ok: true });
}
