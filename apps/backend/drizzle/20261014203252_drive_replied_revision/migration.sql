ALTER TABLE "drive_commands" ADD COLUMN "replied_revision" bigint;--> statement-breakpoint
UPDATE "drive_commands" SET "replied_revision" = r."revision" FROM "space_drive_replies" r WHERE r."space_id" = "drive_commands"."space_id";--> statement-breakpoint
INSERT INTO "drive_commands" ("space_id", "organization_id", "revision", "replied_revision") SELECT r."space_id", s."organization_id", r."revision", r."revision" FROM "space_drive_replies" r JOIN "spaces" s ON s."space_id" = r."space_id" ON CONFLICT ("space_id") DO NOTHING;--> statement-breakpoint
DROP TABLE "space_drive_replies";
