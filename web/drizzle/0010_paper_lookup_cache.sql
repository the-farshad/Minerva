CREATE TABLE "paperLookupCache" (
	"key" text PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"fetchedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "paperLookupCache_fetchedAt_idx" ON "paperLookupCache" USING btree ("fetchedAt");
