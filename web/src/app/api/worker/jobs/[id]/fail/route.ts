/**
 * Local-worker endpoint: report a job failed.
 *
 *   POST /api/worker/jobs/:id/fail
 *   Headers: X-Worker-Secret: <env WORKER_SECRET>
 *   Body:    { error: string }
 *
 * Resets `status` back to 'pending' if `attempts` is below the
 * retry cap so a transient blip is recoverable; flips to 'failed'
 * once attempts exceeds the cap. The user can see failed jobs in a
 * future Queue panel; for now they live in PG until the row gets
 * deleted (CASCADE cleans up).
 */
import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

const MAX_ATTEMPTS = 5;

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
  const body = (await req.json().catch(() => ({}))) as { error?: string };
  const errMsg = String(body.error || 'unknown').slice(0, 2000);

  const job = await db.query.downloadJobs.findFirst({
    where: eq(schema.downloadJobs.id, id),
  });
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // attempts was already incremented by /next when the worker
  // claimed it. Compare against the cap to decide between retry
  // (status back to pending so a different worker / a later poll
  // picks it up) vs terminal failure.
  const next = job.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
  await db.update(schema.downloadJobs)
    .set({
      status: next,
      lastError: errMsg,
      claimedAt: null,
      ...(next === 'failed' ? { completedAt: new Date() } : {}),
    })
    .where(eq(schema.downloadJobs.id, id));
  return NextResponse.json({ ok: true, requeued: next === 'pending', attempts: job.attempts });
}
