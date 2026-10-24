CREATE TYPE "feed_post_kind" AS ENUM('text', 'poll', 'yes_no', 'approval');--> statement-breakpoint
ALTER TYPE "notification_type" ADD VALUE 'approval_request';--> statement-breakpoint
ALTER TABLE "feed_poll_votes" ADD COLUMN "comment" text;--> statement-breakpoint
ALTER TABLE "feed_posts" ADD COLUMN "kind" "feed_post_kind" DEFAULT 'text'::"feed_post_kind" NOT NULL;--> statement-breakpoint
ALTER TABLE "feed_posts" ADD COLUMN "approver_ids" uuid[];--> statement-breakpoint
UPDATE "feed_posts" SET "kind" = 'poll' WHERE "poll_options" IS NOT NULL;