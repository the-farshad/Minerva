/**
 * Meeting polls — list this user's polls and create new ones.
 *
 *   GET  /api/polls           → { polls: [...] }       (auth)
 *   POST /api/polls           → { token, title, ... }  (auth)
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq, desc, inArray } from 'drizzle-orm';
import { auth } from '@/auth';
import { db, schema } from '@/db';
import { newPollToken, validateSlots, slotsPerDay } from '@/lib/poll';

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const rows = await db.query.polls.findMany({
    where: eq(schema.polls.userId, userId),
    orderBy: [desc(schema.polls.createdAt)],
  });
  // Surface response counts for the list page so it can show
  // "<title> · 5 responses" without a follow-up round-trip per
  // poll. Single grouped query keeps it cheap.
  const pollIds = rows.map((p) => p.id);
  const respCounts = new Map<string, number>();
  if (pollIds.length > 0) {
    const responses = await db.query.pollResponses.findMany({
      where: inArray(schema.pollResponses.pollId, pollIds),
      columns: { pollId: true },
    });
    for (const r of responses) {
      respCounts.set(r.pollId, (respCounts.get(r.pollId) || 0) + 1);
    }
  }
  return NextResponse.json({
    polls: rows.map((p) => ({
      token: p.token,
      title: p.title,
      days: p.days,
      slots: p.slots,
      closesAt: p.closesAt?.toISOString() ?? null,
      location: p.location || '',
      finalSlot: p.finalSlot || null,
      mode: (p.mode as 'group' | 'book') || 'group',
      responseCount: respCounts.get(p.id) || 0,
      createdAt: p.createdAt.toISOString(),
    })),
  });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;

  const body = (await req.json().catch(() => ({}))) as {
    title?: string;
    days?: string[];
    slots?: unknown;
    closesAt?: string | null;
    location?: string;
    mode?: 'group' | 'book';
  };
  const title = String(body.title || '').trim();
  if (!title) return NextResponse.json({ error: 'Title is required.' }, { status: 400 });
  if (!Array.isArray(body.days) || body.days.length === 0) {
    return NextResponse.json({ error: 'At least one day is required.' }, { status: 400 });
  }
  const days = Array.from(new Set(
    body.days.map((d) => String(d).trim()).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
  )).sort();
  if (days.length === 0) {
    return NextResponse.json({ error: 'Days must be YYYY-MM-DD strings.' }, { status: 400 });
  }
  let slots;
  try { slots = validateSlots(body.slots); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  const cells = days.length * slotsPerDay(slots);
  if (cells > 2000) {
    return NextResponse.json({ error: `Too many cells (${cells}). Shrink the day range or the slot resolution.` }, { status: 400 });
  }
  const closesAt = body.closesAt ? new Date(body.closesAt) : null;

  const location = String(body.location || '').slice(0, 500);
  const mode = body.mode === 'book' ? 'book' : 'group';
  const token = newPollToken();
  const [inserted] = await db.insert(schema.polls).values({
    token, userId, title, days, slots, closesAt, location, mode,
  }).returning();

  return NextResponse.json({
    token: inserted.token,
    title: inserted.title,
    days: inserted.days,
    slots: inserted.slots,
    closesAt: inserted.closesAt?.toISOString() ?? null,
    location: inserted.location,
    finalSlot: inserted.finalSlot,
    mode: inserted.mode,
  });
}
