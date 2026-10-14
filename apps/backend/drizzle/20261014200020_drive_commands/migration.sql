CREATE TABLE "drive_commands" (
	"space_id" uuid PRIMARY KEY,
	"organization_id" text NOT NULL,
	"revision" bigint NOT NULL,
	"command" jsonb
);
