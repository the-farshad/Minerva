-- Sharing Phase 4: server-side watch progress + the shareProgress
-- opt-in flag on share_recipients. Lays the foundation for the
-- progress-comparison view on /shared-with-me; cross-user reads
-- only resolve when the relevant share_recipients.shareProgress is
-- true on either side.

ALTER TABLE "share_recipients"
  ADD COLUMN IF NOT EXISTS "shareProgress" boolean DEFAULT false NOT NULL;

CREATE TABLE IF NOT EXISTS "watch_progress" (
  "userId" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "rowId" text NOT NULL REFERENCES "rows"("id") ON DELETE CASCADE,
  "positionSec" integer NOT NULL DEFAULT 0,
  "durationSec" integer,
  "videoUrl" text,
  "updatedAt" timestamp DEFAULT now() NOT NULL,
  PRIMARY KEY ("userId", "rowId")
);

CREATE INDEX IF NOT EXISTS "watch_progress_row_idx" ON "watch_progress" ("rowId");
