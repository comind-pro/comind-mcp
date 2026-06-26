ALTER TABLE "call_logs" ADD COLUMN "source" text DEFAULT 'live' NOT NULL;--> statement-breakpoint
CREATE INDEX "call_logs_owner_ts_idx" ON "call_logs" USING btree ("owner_id","created_at");