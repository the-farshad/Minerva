/**
 * Single-poll surface: read (public), respond (public), delete
 * (organizer only).
 *
 *   GET    /api/polls/<token>            → poll + responses (public)
 *   POST   /api/polls/<token>            { name, bits, note? }   (public)
 *   DELETE /api/polls/<token>                                    (auth, owner only)
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq, asc, and } from 'drizzle-orm';
import { auth } from '@/auth';
import { db, schema } from '@/db';
import { cellCount, type PollSlots } from '@/lib/poll';

async function loadByToken(token: string) {
  return db.query.polls.findFirst({ where: eq(schema.polls.token, token) });
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;
  const poll = await loadByToken(token);
  if (!poll) return NextResponse.json({ error: 'Poll not found.' }, { status: 404 });
  const responses = await db.query.pollResponses.findMany({
    where: eq(schema.pollResponses.pollId, poll.id),
    orderBy: [asc(schema.pollResponses.createdAt)],
  });
  return NextResponse.json({
    poll: {
      token: poll.token,
      title: poll.title,
      days: poll.days,
      slots: poll.slots,
      closesAt: poll.closesAt?.toISOString() ?? null,
    },
    responses: responses.map((r) => ({
      id: r.id,
      name: r.name,
      bits: r.bits,
      note: r.note,
      createdAt: r.createdAt.toISOString(),
    })),
  });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;
  const poll = await loadByToken(token);
  if (!poll) return NextResponse.json({ error: 'Poll not found.' }, { status: 404 });
  if (poll.closesAt && new Date(poll.closesAt) < new Date()) {
    return NextResponse.json({ error: 'This poll is closed.' }, { status: 409 });
  }
  const body = (await req.json().catch(() => ({}))) as { name?: string; bits?: string; note?: string };
  const name = String(body.name || '').trim().slice(0, 80);
  if (!name) return NextResponse.json({ error: 'Name is required.' }, { status: 400 });
  const expectedLen = cellCount({ days: poll.days as string[], slots: poll.slots as PollSlots });
  const bits = String(body.bits || '');
  if (bits.length !== expectedLen) {
    return NextResponse.json(
      { error: `bits must be exactly ${expectedLen} chars (got ${bits.length}).` },
      { status: 400 },
    );
  }
  if (!/^[01?]+$/.test(bits)) {
    return NextResponse.json({ error: "bits must contain only '0', '1', or '?'." }, { status: 400 });
  }
  const note = String(body.note || '').slice(0, 500);

  const [inserted] = await db.insert(schema.pollResponses).values({
    pollId: poll.id, name, bits, note,
  }).returning();
  return NextResponse.json({
    id: inserted.id,
    name: inserted.name,
    bits: inserted.bits,
    note: inserted.note,
    createdAt: inserted.createdAt.toISOString(),
  });
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const { token } = await ctx.params;
  const poll = await loadByToken(token);
  if (!poll) return NextResponse.json({ error: 'Poll not found.' }, { status: 404 });
  if (poll.userId !== userId) return NextResponse.json({ error: 'Not your poll.' }, { status: 403 });
  await db.delete(schema.polls).where(and(eq(schema.polls.id, poll.id)));
  return NextResponse.json({ ok: true });
}
