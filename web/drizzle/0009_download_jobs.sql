-- Queue table for the local-worker yt-dlp pattern. The droplet's
-- IP is hard-blocked by YouTube anti-bot, so the save-offline route
-- now ENQUEUES a job here instead of invoking yt-dlp in-process.
-- A trusted home-machine worker polls /api/worker/jobs/next, runs
-- yt-dlp on a residential IP, uploads the bytes to the user's Drive,
-- and POSTs back to /api/worker/jobs/:id/complete which patches the
-- row's offline marker.
--
-- Status lifecycle: pending → claimed → (done | failed)
--   pending  — newly enqueued, eligible for a worker to claim
--   claimed  — a worker has picked it up; reset back to pending on
--              fail (with attempts++) until attempts hits cap, then
--              status flips to failed
--   done     — bytes are in Drive, row.offline marker is updated
--   failed   — exceeded retry cap; surface to the user
CREATE TABLE IF NOT EXISTS "download_jobs" (
  "id" text PRIMARY KEY NOT NULL,
  "userId" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "rowId" text NOT NULL REFERENCES "rows"("id") ON DELETE CASCADE,
  "sectionSlug" text NOT NULL,
  "url" text NOT NULL,
  "format" text NOT NULL DEFAULT 'mp4',
  "quality" text NOT NULL DEFAULT 'best',
  "status" text NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "lastError" text,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "claimedAt" timestamp,
  "completedAt" timestamp
);

-- Index for the "pick the oldest pending job" pattern the worker
-- runs every poll. status-leading so the index narrows fast.
CREATE INDEX IF NOT EXISTS "download_jobs_status_created_idx"
  ON "download_jobs"("status", "createdAt");
-- Per-user listing (Settings → Queue panel, future).
CREATE INDEX IF NOT EXISTS "download_jobs_user_idx"
  ON "download_jobs"("userId");
