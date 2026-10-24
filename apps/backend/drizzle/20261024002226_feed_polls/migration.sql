CREATE TABLE "feed_poll_votes" (
	"post_id" uuid,
	"user_id" uuid,
	"option" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feed_poll_votes_pkey" PRIMARY KEY("post_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "feed_posts" ADD COLUMN "poll_options" text[];--> statement-breakpoint
ALTER TABLE "feed_posts" ADD COLUMN "poll_closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "feed_poll_votes" ADD CONSTRAINT "feed_poll_votes_post_id_feed_posts_id_fkey" FOREIGN KEY ("post_id") REFERENCES "feed_posts"("id") ON DELETE CASCADE;