CREATE TABLE "project_access" (
	"project_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"granted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"parent_id" text,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "project_id" text;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "created_by_agent_id" text;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "role" text DEFAULT 'lead' NOT NULL;
--> statement-breakpoint
ALTER TABLE "call_logs" ADD COLUMN "project_id" text;
--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "project_id" text;
--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "created_by_agent_id" text;
--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "project_id" text;
--> statement-breakpoint
ALTER TABLE "secrets" ADD COLUMN "project_id" text;
--> statement-breakpoint
ALTER TABLE "secrets" ADD COLUMN "created_by_agent_id" text;
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "project_id" text;
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "created_by_agent_id" text;
--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "project_id" text;
--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "created_by_agent_id" text;
--> statement-breakpoint
ALTER TABLE "project_access" ADD CONSTRAINT "project_access_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "project_access_pk" ON "project_access" USING btree ("project_id","resource_type","resource_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "projects_slug_unique" ON "projects" USING btree ("owner_id","slug");
--> statement-breakpoint
CREATE INDEX "projects_path_idx" ON "projects" USING btree ("path");
--> statement-breakpoint
INSERT INTO "projects" ("id","owner_id","parent_id","kind","name","slug","path","created_at")
SELECT substr(md5(random()::text || u.id || 't'),1,16), u.id, NULL, 'team', 'My team', 'team', '', now()
FROM "users" u
WHERE NOT EXISTS (SELECT 1 FROM "projects" p WHERE p.owner_id = u.id AND p.kind = 'team' AND p.slug = 'team');
--> statement-breakpoint
UPDATE "projects" SET "path" = '/' || "id" || '/' WHERE "parent_id" IS NULL AND "path" = '';
--> statement-breakpoint
INSERT INTO "projects" ("id","owner_id","parent_id","kind","name","slug","path","created_at")
SELECT substr(md5(random()::text || t.id || 'p'),1,16), t.owner_id, t.id, 'project', 'Default', 'default', '', now()
FROM "projects" t
WHERE t.kind = 'team' AND t.slug = 'team'
  AND NOT EXISTS (SELECT 1 FROM "projects" p WHERE p.owner_id = t.owner_id AND p.kind = 'project' AND p.slug = 'default');
--> statement-breakpoint
UPDATE "projects" c SET "path" = t."path" || c."id" || '/' FROM "projects" t WHERE c."parent_id" = t."id" AND c."path" = '';
--> statement-breakpoint
UPDATE "sources" s SET "project_id" = p."id" FROM "projects" p WHERE p.owner_id = s.owner_id AND p.kind='project' AND p.slug='default' AND s."project_id" IS NULL;
--> statement-breakpoint
UPDATE "tools" s SET "project_id" = p."id" FROM "projects" p WHERE p.owner_id = s.owner_id AND p.kind='project' AND p.slug='default' AND s."project_id" IS NULL;
--> statement-breakpoint
UPDATE "groups" s SET "project_id" = p."id" FROM "projects" p WHERE p.owner_id = s.owner_id AND p.kind='project' AND p.slug='default' AND s."project_id" IS NULL;
--> statement-breakpoint
UPDATE "agents" s SET "project_id" = p."id" FROM "projects" p WHERE p.owner_id = s.owner_id AND p.kind='project' AND p.slug='default' AND s."project_id" IS NULL;
--> statement-breakpoint
UPDATE "secrets" s SET "project_id" = p."id" FROM "projects" p WHERE p.owner_id = s.owner_id AND p.kind='project' AND p.slug='default' AND s."project_id" IS NULL;
--> statement-breakpoint
UPDATE "schedules" s SET "project_id" = p."id" FROM "projects" p WHERE p.owner_id = s.owner_id AND p.kind='project' AND p.slug='default' AND s."project_id" IS NULL;
--> statement-breakpoint
UPDATE "call_logs" s SET "project_id" = p."id" FROM "projects" p WHERE p.owner_id = s.owner_id AND p.kind='project' AND p.slug='default' AND s."project_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "sources" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "tools" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "groups" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "secrets" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "schedules" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
