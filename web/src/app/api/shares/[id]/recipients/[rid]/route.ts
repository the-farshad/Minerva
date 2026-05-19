/**
 * DELETE /api/shares/[id]/recipients/[rid]
 *
 * Owner action: revoke a single recipient without tearing down the
 * whole share. Useful when the share goes to a group of people and
 * the owner wants to drop one without nuking access for the rest.
 *
 * PATCH  /api/shares/[id]/recipients/[rid]
 *   { mode?: 'view'|'edit', shareProgress?: boolean }
 *
 * Owner-side update after share creation. The recipient toggles
 * recipientShareProgress on their own row via POST
 * /api/shares/recipients/[id]; this PATCH covers the owner side
 * of the same model (mode and the owner→recipient shareProgress
 * flag).
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { db, schema } from '@/db';
import { bus } from '@/lib/event-bus';

export const dynamic = 'force-dynamic';

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; rid: string }> },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const { id, rid } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { mode?: 'view' | 'edit'; shareProgress?: boolean };

  // Ownership check: same share-owns-the-recipient rule as DELETE.
  const share = await db.query.shares.findFirst({
    where: and(eq(schema.shares.id, id), eq(schema.shares.ownerUserId, userId)),
  });
  if (!share) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const rec = await db.query.shareRecipients.findFirst({
    where: and(eq(schema.shareRecipients.id, rid), eq(schema.shareRecipients.shareId, id)),
  });
  if (!rec) return NextResponse.json({ error: 'Recipient not found' }, { status: 404 });

  const patch: { mode?: 'view' | 'edit'; shareProgress?: boolean } = {};
  if (body.mode === 'view' || body.mode === 'edit') patch.mode = body.mode;
  if (typeof body.shareProgress === 'boolean') patch.shareProgress = body.shareProgress;
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: 'No-op patch.' }, { status: 400 });

  await db.update(schema.shareRecipients).set(patch).where(eq(schema.shareRecipients.id, rid));

  // Notify the recipient (Minerva user, public-token recipients
  // ignore the flag anyway) so their inbox / shared-with-me view
  // refetches.
  if (rec.recipientUserId) {
    bus.emit(rec.recipientUserId, { kind: 'share.received', shareId: id });
  }
  // Owner's own outgoing list also refreshes on the same event.
  bus.emit(userId, { kind: 'share.received', shareId: id });

  return NextResponse.json({ ok: true, ...patch });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string; rid: string }> },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const { id, rid } = await ctx.params;

  // Owner ownership check via the parent share.
  const share = await db.query.shares.findFirst({
    where: and(eq(schema.shares.id, id), eq(schema.shares.ownerUserId, userId)),
  });
  if (!share) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const rec = await db.query.shareRecipients.findFirst({
    where: and(eq(schema.shareRecipients.id, rid), eq(schema.shareRecipients.shareId, id)),
  });
  if (!rec) return NextResponse.json({ error: 'Recipient not found' }, { status: 404 });

  await db.delete(schema.shareRecipients).where(eq(schema.shareRecipients.id, rid));

  // Notify the dropped recipient (if a Minerva user) so their
  // inbox reflects the change. Public-token recipients have no
  // user-channel to notify, so we skip.
  if (rec.recipientUserId) {
    bus.emit(rec.recipientUserId, { kind: 'share.received', shareId: id });
  }
  bus.emit(userId, { kind: 'share.received', shareId: id });

  return NextResponse.json({ ok: true });
}
