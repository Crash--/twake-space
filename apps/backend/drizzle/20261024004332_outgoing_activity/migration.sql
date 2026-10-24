CREATE TABLE "outgoing_activity" (
	"id" uuid PRIMARY KEY,
	"event" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "outgoing_activity_created_at_index" ON "outgoing_activity" ("created_at");