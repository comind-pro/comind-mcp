ALTER TABLE "sources" ADD COLUMN "status_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "read_only" boolean;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "dangerous" boolean;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "permissions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "examples" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "recommended_use" jsonb;