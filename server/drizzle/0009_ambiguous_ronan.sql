ALTER TABLE "sources" ADD COLUMN "objects" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "objects_checked_at" timestamp with time zone;