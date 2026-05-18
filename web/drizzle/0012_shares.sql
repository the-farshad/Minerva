-- Sharing Phase 2: share records + recipients.
-- Owner X creates a `shares` row scoped to a section / row, and
-- one `share_recipients` row per intended recipient (a Minerva
-- user by id, or an anonymous public-link token). Recipients can
-- accept or decline; owner can revoke the share or individual
-- recipients.

CREATE TABLE IF NOT EXISTS "shares" (
  "id" text PRIMARY KEY NOT NULL,
  "ownerUserId" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "scope" text NOT NULL,
  "targetId" text NOT NULL,
  "defaultMode" text NOT NULL DEFAULT 'view',
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "revokedAt" timestamp
);

CREATE INDEX IF NOT EXISTS "shares_owner_idx" ON "shares" ("ownerUserId");
CREATE INDEX IF NOT EXISTS "shares_target_idx" ON "shares" ("scope", "targetId");

CREATE TABLE IF NOT EXISTS "share_recipients" (
  "id" text PRIMARY KEY NOT NULL,
  "shareId" text NOT NULL REFERENCES "shares"("id") ON DELETE CASCADE,
  "recipientUserId" text REFERENCES "users"("id") ON DELETE CASCADE,
  "publicToken" text,
  "mode" text NOT NULL DEFAULT 'view',
  "acceptedAt" timestamp,
  "declinedAt" timestamp,
  "createdAt" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "share_recipients_share_idx" ON "share_recipients" ("shareId");
CREATE INDEX IF NOT EXISTS "share_recipients_recipient_idx" ON "share_recipients" ("recipientUserId");
CREATE UNIQUE INDEX IF NOT EXISTS "share_recipients_token_uniq" ON "share_recipients" ("publicToken") WHERE "publicToken" IS NOT NULL;
