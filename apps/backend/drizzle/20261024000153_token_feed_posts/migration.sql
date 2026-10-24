ALTER TYPE "token_scope" ADD VALUE 'feed:write';--> statement-breakpoint
ALTER TYPE "token_scope" ADD VALUE 'notifications:read';--> statement-breakpoint
ALTER TABLE "feed_posts" ADD COLUMN "author_token_id" uuid;--> statement-breakpoint
ALTER TABLE "feed_posts" ADD CONSTRAINT "feed_posts_author_token_id_api_tokens_id_fkey" FOREIGN KEY ("author_token_id") REFERENCES "api_tokens"("id");--> statement-breakpoint
ALTER TABLE "feed_posts" ADD CONSTRAINT "feed_posts_one_author" CHECK ("author_id" is null or "author_token_id" is null);