ALTER TABLE "oauth_access_tokens" ALTER COLUMN "group_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_auth_codes" ALTER COLUMN "group_id" DROP NOT NULL;