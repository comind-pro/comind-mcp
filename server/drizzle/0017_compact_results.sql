ALTER TABLE "call_logs" ADD COLUMN "bytes_in" integer;--> statement-breakpoint
ALTER TABLE "call_logs" ADD COLUMN "bytes_out" integer;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "compact_results" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "output_fields" jsonb;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "output_limit" integer;