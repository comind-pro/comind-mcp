ALTER TABLE "agents" ADD COLUMN "system_tools" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "groups" DROP COLUMN "system_tools";