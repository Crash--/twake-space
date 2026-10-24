ALTER TYPE "feed_post_kind" ADD VALUE 'announcement';--> statement-breakpoint
ALTER TYPE "feed_post_kind" ADD VALUE 'feedback';--> statement-breakpoint
ALTER TABLE "feed_posts" ADD COLUMN "pinned_at" timestamp with time zone;