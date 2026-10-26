ALTER TABLE "sources" ADD COLUMN "drift" jsonb;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "drift_checked_at" timestamp with time zone;