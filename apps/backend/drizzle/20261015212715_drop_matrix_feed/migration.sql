DELETE FROM "notifications" WHERE "type" = 'message_mention';--> statement-breakpoint
DELETE FROM "notification_settings" WHERE "type" = 'message_mention';--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_one_source", ADD CONSTRAINT "notifications_one_source" CHECK (num_nonnulls("activity_event_id", "external_id") = 1);--> statement-breakpoint
DROP TABLE "app_service_transactions";--> statement-breakpoint
DROP TABLE "feed_messages";--> statement-breakpoint
DROP TABLE "feed_reactions";--> statement-breakpoint
ALTER TABLE "homeservers" DROP CONSTRAINT "homeservers_hs_token_hash_key";--> statement-breakpoint
DROP INDEX "activity_events_unposted_idx";--> statement-breakpoint
DROP INDEX "notifications_matrix_event_idx";--> statement-breakpoint
ALTER TABLE "notification_settings" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "notification_type";--> statement-breakpoint
CREATE TYPE "notification_type" AS ENUM('card_mention', 'assignment', 'invitation', 'attended_event_change', 'space_change', 'assistant_suggestion');--> statement-breakpoint
ALTER TABLE "notification_settings" ALTER COLUMN "type" SET DATA TYPE "notification_type" USING "type"::"notification_type";--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "type" SET DATA TYPE "notification_type" USING "type"::"notification_type";--> statement-breakpoint
ALTER TABLE "activity_events" DROP COLUMN "matrix_event_id";--> statement-breakpoint
ALTER TABLE "activity_events" DROP COLUMN "post_failed_at";--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN "matrix_event_id";--> statement-breakpoint
ALTER TABLE "homeservers" DROP COLUMN "as_token";--> statement-breakpoint
ALTER TABLE "homeservers" DROP COLUMN "hs_token";--> statement-breakpoint
ALTER TABLE "homeservers" DROP COLUMN "hs_token_hash";