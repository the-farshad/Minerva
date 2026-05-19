-- Phase 4 — bidirectional progress visibility.
-- shareProgress already handles the owner → recipient direction.
-- recipientShareProgress is its mirror: when true the recipient
-- has agreed to expose their watch_progress on the shared rows
-- back to the owner. Each side controls their direction
-- independently, so 'show progress to me' and 'show my progress
-- to them' aren't bound to one toggle.

ALTER TABLE "share_recipients"
  ADD COLUMN IF NOT EXISTS "recipientShareProgress" boolean DEFAULT false NOT NULL;
