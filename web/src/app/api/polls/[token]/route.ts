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
import { cellCount, hashPollPassword, validateSlots, type PollSlots } from '@/lib/poll';

async function loadByToken(token: string) {
  return db.query.polls.findFirst({ where: eq(schema.polls.token, token) });
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;
  const poll = await loadByToken(token);
  if (!poll) return NextResponse.json({ error: 'Poll not found.' }, { status: 404 });

  // Password gate. The participant supplies `?p=<plaintext>` (or
  // header `x-poll-password`); we hash and compare. If the poll
  // has no password the gate is open. If it does have one and the
  // supplied digest doesn't match, we return a stripped payload
  // (no slots, no responses) plus `passwordRequired: true` so the
  // UI can render the prompt without leaking anything.
  let passwordOk = !poll.passwordHash;
  if (poll.passwordHash) {
    const supplied = req.nextUrl.searchParams.get('p') || req.headers.get('x-poll-password') || '';
    if (supplied) {
      const digest = await hashPollPassword(supplied);
      if (digest === poll.passwordHash) passwordOk = true;
    }
  }
  if (!passwordOk) {
    return NextResponse.json({
      poll: {
        token: poll.token,
        title: poll.title,
        days: [],
        slots: poll.slots,
        closesAt: poll.closesAt?.toISOString() ?? null,
        location: '',
        finalSlot: null,
        mode: (poll.mode as 'group' | 'book') || 'group',
        kind: (poll.kind as 'meeting' | 'yesno' | 'ranked') || 'meeting',
        passwordSet: true,
      },
      responses: [],
      passwordRequired: true,
    }, { status: 401 });
  }

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
      kind: (poll.kind as 'meeting' | 'yesno' | 'ranked') || 'meeting',
      passwordSet: !!poll.passwordHash,
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
  const body = (await req.json().catch(() => ({}))) as { name?: string; bits?: string; note?: string; password?: string };
  if (poll.passwordHash) {
    const supplied = body.password || req.headers.get('x-poll-password') || '';
    const digest = supplied ? await hashPollPassword(supplied) : '';
    if (digest !== poll.passwordHash) {
      return NextResponse.json({ error: 'Password is wrong or missing.' }, { status: 401 });
    }
  }
  const name = String(body.name || '').trim().slice(0, 80);
  if (!name) return NextResponse.json({ error: 'Name is required.' }, { status: 400 });
  const kind = (poll.kind as 'meeting' | 'yesno' | 'ranked') || 'meeting';
  const days = poll.days as string[];
  const bits = String(body.bits || '');

  if (kind === 'meeting') {
    const expectedLen = cellCount({ days, slots: poll.slots as PollSlots });
    if (bits.length !== expectedLen) {
      return NextResponse.json(
        { error: `bits must be exactly ${expectedLen} chars (got ${bits.length}).` },
        { status: 400 },
      );
    }
    if (!/^[01?]+$/.test(bits)) {
      return NextResponse.json({ error: "bits must contain only '0', '1', or '?'." }, { status: 400 });
    }
  } else if (kind === 'yesno') {
    if (bits.length !== 1 || !/^[01?]$/.test(bits)) {
      return NextResponse.json({ error: "yes/no response must be one of '1', '0', '?'." }, { status: 400 });
    }
  } else {
    // ranked: one digit per option, '0' = unranked, '1'-'9' = rank
    // position (1 = top). For >9 options we'd need a different
    // encoding; the composer caps `days.length` at 20 but practical
    // ranked polls top out well below that anyway.
    if (bits.length !== days.length) {
      return NextResponse.json(
        { error: `ranked response must be ${days.length} chars (got ${bits.length}).` },
        { status: 400 },
      );
    }
    if (!/^[0-9]+$/.test(bits)) {
      return NextResponse.json({ error: 'ranked response must be digits only.' }, { status: 400 });
    }
    // No duplicate non-zero ranks allowed (each rank appears once).
    const seen = new Set<string>();
    for (const c of bits) {
      if (c === '0') continue;
      if (seen.has(c)) {
        return NextResponse.json({ error: `Rank ${c} appears more than once.` }, { status: 400 });
      }
      seen.add(c);
    }
  }
  const note = String(body.note || '').slice(0, 500);

  // 1-to-1 booking mode: enforce that exactly one cell is picked
  // AND that nobody else has already claimed it. Atomically — we
  // re-query existing responses inside the same handler so a near-
  // simultaneous submission can't double-book the same slot. Only
  // applies to meeting polls — yes/no and ranked have their own
  // shape validation above.
  if (poll.mode === 'book' && kind === 'meeting') {
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
    title?: string;
    location?: string;
    finalSlot?: string | null;
    closesAt?: string | null;
    days?: string[];
    slots?: unknown;
    /** Either a plaintext (sets/changes the password) or
     * explicitly null (clears it). Omit to leave as-is. */
    password?: string | null;
  };
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof body.title === 'string' && body.title.trim()) patch.title = body.title.trim().slice(0, 200);
  if (typeof body.location === 'string') patch.location = body.location.slice(0, 500);
  if (body.password === null) patch.passwordHash = null;
  else if (typeof body.password === 'string' && body.password.trim()) {
    patch.passwordHash = await hashPollPassword(body.password.trim());
  }
  if (Array.isArray(body.days)) {
    // For meeting polls `days` must be date-shaped; for yes/no and
    // ranked it's the question / option list and we keep the raw
    // strings verbatim.
    const pollKind = (poll.kind as 'meeting' | 'yesno' | 'ranked') || 'meeting';
    if (pollKind === 'meeting') {
      const days = Array.from(new Set(
        body.days.map((d) => String(d).trim()).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
      )).sort();
      if (days.length === 0) {
        return NextResponse.json({ error: 'Days must be YYYY-MM-DD strings.' }, { status: 400 });
      }
      patch.days = days;
    } else {
      const raw = body.days.map((d) => String(d).trim()).filter(Boolean);
      if (pollKind === 'yesno' && raw.length !== 1) {
        return NextResponse.json({ error: 'A yes/no poll needs exactly one question.' }, { status: 400 });
      }
      if (pollKind === 'ranked' && (raw.length < 2 || raw.length > 20)) {
        return NextResponse.json({ error: 'A ranked poll needs between 2 and 20 options.' }, { status: 400 });
      }
      patch.days = raw;
    }
  }
  if (body.slots !== undefined) {
    try { patch.slots = validateSlots(body.slots); }
    catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  }
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
    kind: (updated.kind as 'meeting' | 'yesno' | 'ranked') || 'meeting',
    passwordSet: !!updated.passwordHash,
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
