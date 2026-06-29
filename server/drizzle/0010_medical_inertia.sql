CREATE TABLE "virtuals" (
	"id" text PRIMARY KEY NOT NULL,
	"tool_id" text NOT NULL,
	"executable" boolean DEFAULT true NOT NULL,
	"request" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "virtuals" ADD CONSTRAINT "virtuals_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE cascade ON UPDATE no action;