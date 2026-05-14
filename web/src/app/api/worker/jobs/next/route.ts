/**
 * Local-worker endpoint: atomically claim the oldest pending job.
 *
 *   GET /api/worker/jobs/next
 *   Headers: X-Worker-Secret: <env WORKER_SECRET>
 *
 * Race-safe via an UPDATE … WHERE status='pending' … RETURNING.
 * If no job is pending, returns { job: null } so the worker can
 * sleep and poll again.
 *
 * On a successful claim the response includes a fresh Google
 * access token minted from the user's stored refresh token. The
 * worker uses that to upload the resulting bytes to the user's
 * Drive directly — no double-transfer through the droplet.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { and, asc, eq, sql } from 'drizzle-orm';
import { getGoogleAccessToken } from '@/lib/google';

export const dynamic = 'force-dynamic';

function checkAuth(req: NextRequest): boolean {
  const secret = process.env.WORKER_SECRET || '';
  if (!secret) return false;
  return req.headers.get('x-worker-secret') === secret;
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Atomic claim: pick the oldest pending job and flip its status
  // to 'claimed' in a single UPDATE so two workers can never
  // claim the same row. Drizzle's `update().set().where().returning()`
  // maps to PG's UPDATE … RETURNING under the hood — race-safe.
  const candidate = await db.query.downloadJobs.findFirst({
    where: eq(schema.downloadJobs.status, 'pending'),
    orderBy: asc(schema.downloadJobs.createdAt),
  });
  if (!candidate) return NextResponse.json({ job: null });

  const [claimed] = await db.update(schema.downloadJobs)
    .set({ status: 'claimed', claimedAt: new Date(), attempts: sql`${schema.downloadJobs.attempts} + 1` })
    .where(and(
      eq(schema.downloadJobs.id, candidate.id),
      eq(schema.downloadJobs.status, 'pending'),
    ))
    .returning();
  if (!claimed) {
    // Lost the race — another worker got it first. Tell the caller
    // there's nothing for them right now; they'll re-poll.
    return NextResponse.json({ job: null });
  }

  // Fresh Drive access token for the owning user. Short-lived
  // (~1h); the worker should finish the upload within that window
  // or call this endpoint again to mint another. Worker also gets
  // the rowId / sectionSlug so the complete-callback can find the
  // right row to patch.
  let accessToken: string;
  try {
    accessToken = await getGoogleAccessToken(claimed.userId);
  } catch (e) {
    // No refresh token / revoked grant / network error. Mark the
    // job failed immediately rather than handing the worker a job
    // it can't finish.
    await db.update(schema.downloadJobs)
      .set({ status: 'failed', lastError: `drive-auth: ${(e as Error).message}`, completedAt: new Date() })
      .where(eq(schema.downloadJobs.id, claimed.id));
    return NextResponse.json({ error: 'drive auth failed', detail: (e as Error).message }, { status: 502 });
  }

  return NextResponse.json({
    job: {
      id: claimed.id,
      url: claimed.url,
      format: claimed.format,
      quality: claimed.quality,
      rowId: claimed.rowId,
      sectionSlug: claimed.sectionSlug,
      attempts: claimed.attempts,
    },
    driveAccessToken: accessToken,
  });
}
