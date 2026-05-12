CREATE TABLE "pollResponses" (
	"id" text PRIMARY KEY NOT NULL,
	"pollId" text NOT NULL,
	"name" text NOT NULL,
	"bits" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "polls" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"userId" text NOT NULL,
	"title" text NOT NULL,
	"days" jsonb NOT NULL,
	"slots" jsonb NOT NULL,
	"closesAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "polls_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "pollResponses" ADD CONSTRAINT "pollResponses_pollId_polls_id_fk" FOREIGN KEY ("pollId") REFERENCES "public"."polls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polls" ADD CONSTRAINT "polls_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pollResponses_poll_idx" ON "pollResponses" USING btree ("pollId","createdAt");--> statement-breakpoint
CREATE INDEX "polls_user_idx" ON "polls" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "polls_token_idx" ON "polls" USING btree ("token");