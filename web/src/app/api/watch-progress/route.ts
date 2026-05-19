/**
 * POST /api/watch-progress  { rowId, position, duration?, url? }
 *   Upsert the current user's watch progress for a row.
 *
 * GET  /api/watch-progress?rowIds=id1,id2,id3
 *   Return the current user's watch progress for the given rows.
 *
 * Server-side persistence of what used to live only in
 * localStorage.minerva.v2.resume.<url> per device. Drives the
 * Phase-4 progress-comparison view on shared content.
 */
/**
 * Also: DELETE /api/watch-progress  { rowIds: string[] }
 *   Drop the current user's watch_progress rows for the given
 *   rowIds. Used by the group-level "Reset watch progress" action
 *   so server-side data stays in sync with the localStorage wipe.
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { db, schema } from '@/db';

export const dynamic = 'force-dynamic';

type UpsertBody = {
  rowId?: string;
  position?: number;
  duration?: number;
  url?: string;
};

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const body = (await req.json().catch(() => ({}))) as UpsertBody;
  if (!body.rowId) return NextResponse.json({ error: 'Missing rowId' }, { status: 400 });
  const pos = Math.max(0, Math.round(Number(body.position) || 0));
  const dur = Number.isFinite(Number(body.duration)) && Number(body.duration) > 0
    ? Math.round(Number(body.duration))
    : undefined;

  // Verify the row belongs to the current user OR is reachable via
  // an accepted share. Anything else is a write attempt on someone
  // else's content and we reject.
  const row = await db.query.rows.findFirst({ where: eq(schema.rows.id, body.rowId), columns: { id: true, userId: true, sectionId: true } });
  if (!row) return NextResponse.json({ error: 'Row not found' }, { status: 404 });
  if (row.userId !== userId) {
    // Allow if the user has an accepted share that reaches this row.
    const reachable = await db
      .select({ id: schema.shareRecipients.id })
      .from(schema.shareRecipients)
      .innerJoin(schema.shares, eq(schema.shares.id, schema.shareRecipients.shareId))
      .where(and(
        eq(schema.shareRecipients.recipientUserId, userId),
        sql`${schema.shareRecipients.acceptedAt} is not null`,
        sql`(
          (${schema.shares.scope} = 'row' AND ${schema.shares.targetId} = ${body.rowId})
          OR (${schema.shares.scope} = 'section' AND ${schema.shares.targetId} = ${row.sectionId})
          OR (${schema.shares.scope} = 'group' AND ${schema.shares.targetId} LIKE ${row.sectionId + ':%'})
        )`,
      ))
      .limit(1);
    if (reachable.length === 0) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Upsert on (userId, rowId).
  await db
    .insert(schema.watchProgress)
    .values({
      userId,
      rowId: body.rowId,
      positionSec: pos,
      durationSec: dur,
      videoUrl: body.url ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [schema.watchProgress.userId, schema.watchProgress.rowId],
      set: {
        positionSec: pos,
        durationSec: dur,
        videoUrl: body.url ?? null,
        updatedAt: new Date(),
      },
    });

  return NextResponse.json({ ok: true });
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const ids = (req.nextUrl.searchParams.get('rowIds') || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return NextResponse.json({ progress: [] });
  if (ids.length > 200) return NextResponse.json({ error: 'Too many rowIds' }, { status: 400 });

  const rows = await db
    .select({
      rowId: schema.watchProgress.rowId,
      positionSec: schema.watchProgress.positionSec,
      durationSec: schema.watchProgress.durationSec,
      updatedAt: schema.watchProgress.updatedAt,
    })
    .from(schema.watchProgress)
    .where(and(
      eq(schema.watchProgress.userId, userId),
      inArray(schema.watchProgress.rowId, ids),
    ));

  return NextResponse.json({ progress: rows });
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const body = (await req.json().catch(() => ({}))) as { rowIds?: string[] };
  const ids = (body.rowIds || []).filter((s) => typeof s === 'string' && s);
  if (ids.length === 0) return NextResponse.json({ deleted: 0 });
  if (ids.length > 500) return NextResponse.json({ error: 'Too many rowIds' }, { status: 400 });

  const res = await db
    .delete(schema.watchProgress)
    .where(and(
      eq(schema.watchProgress.userId, userId),
      inArray(schema.watchProgress.rowId, ids),
    ));
  return NextResponse.json({ deleted: (res as { rowCount?: number }).rowCount ?? ids.length });
}
