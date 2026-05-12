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
      location: poll.location || '',
      finalSlot: poll.finalSlot || null,
      mode: (poll.mode as 'group' | 'book') || 'group',
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

  // 1-to-1 booking mode: enforce that exactly one cell is picked
  // AND that nobody else has already claimed it. Atomically — we
  // re-query existing responses inside the same handler so a near-
  // simultaneous submission can't double-book the same slot.
  if (poll.mode === 'book') {
    const ones: number[] = [];
    for (let i = 0; i < bits.length; i++) if (bits[i] === '1') ones.push(i);
    if (ones.length !== 1) {
      return NextResponse.json({ error: 'Pick exactly one slot.' }, { status: 400 });
    }
    if (/[?]/.test(bits)) {
      return NextResponse.json({ error: 'Tentative cells (?) aren\'t allowed in 1-to-1 booking mode.' }, { status: 400 });
    }
    const picked = ones[0];
    const existing = await db.query.pollResponses.findMany({
      where: eq(schema.pollResponses.pollId, poll.id),
      columns: { bits: true },
    });
    for (const r of existing) {
      if (r.bits.charAt(picked) === '1') {
        return NextResponse.json({ error: 'That slot was just claimed by someone else — refresh and pick another.' }, { status: 409 });
      }
    }
  }

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

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const { token } = await ctx.params;
  const poll = await loadByToken(token);
  if (!poll) return NextResponse.json({ error: 'Poll not found.' }, { status: 404 });
  if (poll.userId !== userId) return NextResponse.json({ error: 'Not your poll.' }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as {
    location?: string;
    finalSlot?: string | null;
    closesAt?: string | null;
  };
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof body.location === 'string') patch.location = body.location.slice(0, 500);
  if (body.finalSlot === null || typeof body.finalSlot === 'string') {
    // Validate "<dayIdx>:<slotIdx>" against the poll's grid so we
    // can't end up with a final slot that doesn't exist.
    if (body.finalSlot && body.finalSlot.length > 0) {
      const m = /^(\d+):(\d+)$/.exec(body.finalSlot);
      if (!m) return NextResponse.json({ error: 'finalSlot must be "<dayIdx>:<slotIdx>".' }, { status: 400 });
      const dayIdx = Number(m[1]);
      const slotIdx = Number(m[2]);
      const slots = poll.slots as { fromHour: number; toHour: number; slotMin: number };
      const perDay = Math.floor((slots.toHour - slots.fromHour) * 60 / slots.slotMin);
      const days = poll.days as string[];
      if (dayIdx < 0 || dayIdx >= days.length || slotIdx < 0 || slotIdx >= perDay) {
        return NextResponse.json({ error: 'finalSlot out of range.' }, { status: 400 });
      }
    }
    patch.finalSlot = body.finalSlot;
  }
  if (body.closesAt !== undefined) patch.closesAt = body.closesAt ? new Date(body.closesAt) : null;

  const [updated] = await db.update(schema.polls)
    .set(patch)
    .where(eq(schema.polls.id, poll.id))
    .returning();
  return NextResponse.json({
    token: updated.token,
    title: updated.title,
    days: updated.days,
    slots: updated.slots,
    closesAt: updated.closesAt?.toISOString() ?? null,
    location: updated.location || '',
    finalSlot: updated.finalSlot || null,
    mode: (updated.mode as 'group' | 'book') || 'group',
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
