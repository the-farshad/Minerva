-- Sharing Phase 1: public-profile foundation.
-- Adds the optional `username` handle and `discoverable` flag the
-- user-search API filters on. Username is case-insensitively unique
-- via a functional lower() index; the column itself is plain text.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "username" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "discoverable" boolean DEFAULT true NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "users_username_lower_uniq"
  ON "users" (lower("username"))
  WHERE "username" IS NOT NULL;
