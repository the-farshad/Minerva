/**
 * Local-worker endpoint: report a job completed.
 *
 *   POST /api/worker/jobs/:id/complete
 *   Headers: X-Worker-Secret: <env WORKER_SECRET>
 *   Body:    { driveFileId: string, filename?: string }
 *
 * Flips the job row to status='done', patches the owning row's
 * `data.offline` marker to include the new `drive:<fileId>` token,
 * and broadcasts row.updated over SSE so every open tab refreshes.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { bus } from '@/lib/event-bus';

export const dynamic = 'force-dynamic';

function checkAuth(req: NextRequest): boolean {
  const secret = process.env.WORKER_SECRET || '';
  if (!secret) return false;
  return req.headers.get('x-worker-secret') === secret;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { driveFileId?: string; filename?: string };
  const driveFileId = String(body.driveFileId || '').trim();
  if (!driveFileId) return NextResponse.json({ error: 'driveFileId required' }, { status: 400 });

  const job = await db.query.downloadJobs.findFirst({
    where: eq(schema.downloadJobs.id, id),
  });
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (job.status === 'done') return NextResponse.json({ ok: true, idempotent: true });

  // Flip the job to done.
  await db.update(schema.downloadJobs)
    .set({ status: 'done', completedAt: new Date(), lastError: null })
    .where(eq(schema.downloadJobs.id, id));

  // Patch the row's offline marker. Mirror the in-place offline
  // bookkeeping save-offline does for the synchronous path: strip
  // any prior `drive:` token, append the new one.
  const row = await db.query.rows.findFirst({ where: eq(schema.rows.id, job.rowId) });
  if (row) {
    const data = (row.data as Record<string, unknown>) || {};
    const prevOffline = String((data as { offline?: string }).offline || '').trim();
    const parts = prevOffline ? prevOffline.split(' · ').filter(Boolean) : [];
    const without = parts.filter((p) => !p.startsWith('drive:'));
    without.push(`drive:${driveFileId}`);
    // Clear the `_queued` marker the save-offline route stamped on
    // the row — the worker is done; the pill should disappear.
    const nextData: Record<string, unknown> = { ...data, offline: without.join(' · ') };
    delete nextData._queued;
    await db.update(schema.rows)
      .set({ data: nextData, updatedAt: new Date() })
      .where(eq(schema.rows.id, job.rowId));
    bus.emit(job.userId, {
      kind: 'row.updated',
      sectionSlug: job.sectionSlug,
      rowId: job.rowId,
      data: nextData,
    });
  }

  return NextResponse.json({ ok: true });
}
