CREATE TABLE "agent_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"hash" text NOT NULL,
	"prefix" text NOT NULL,
	"label" text,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "api_key_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "api_key_prefix" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_keys" ADD CONSTRAINT "agent_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_keys_hash_unique" ON "agent_keys" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "agent_keys_agent_idx" ON "agent_keys" USING btree ("agent_id");--> statement-breakpoint
-- backfill: move each agent's existing key into agent_keys (label 'default')
INSERT INTO "agent_keys" ("id", "agent_id", "hash", "prefix", "label", "archived", "created_at")
SELECT "id" || '-default', "id", "api_key_hash", "api_key_prefix", 'default', false, "created_at"
FROM "agents" WHERE "api_key_hash" IS NOT NULL;