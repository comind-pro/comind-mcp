CREATE TABLE "rate_limits" (
	"key" text NOT NULL,
	"bucket" integer NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "rate_limits_pk" ON "rate_limits" USING btree ("key","bucket");