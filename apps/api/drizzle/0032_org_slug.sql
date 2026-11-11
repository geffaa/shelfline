-- M24: more than one organisation on one deployment. A sign-in can name its organisation (the slug) when the same email exists in several.
ALTER TABLE "shelfline"."org" ADD COLUMN "slug" text;--> statement-breakpoint
WITH x AS (SELECT id, created_at, left(trim(both '-' from regexp_replace(lower("name"), '[^a-z0-9]+', '-', 'g')), 40) AS base FROM "shelfline"."org"), s AS (SELECT id, base, row_number() OVER (PARTITION BY base ORDER BY created_at, id) AS rn FROM x) UPDATE "shelfline"."org" o SET "slug" = CASE WHEN length(s.base) < 3 THEN 'org' ELSE s.base END || CASE WHEN s.rn > 1 OR length(s.base) < 3 THEN '-' || substr(o.id::text, 1, 6) ELSE '' END FROM s WHERE s.id = o.id;--> statement-breakpoint
ALTER TABLE "shelfline"."org" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "shelfline"."org" ADD CONSTRAINT "org_slug_uq" UNIQUE("slug");--> statement-breakpoint
ALTER TABLE "shelfline"."org" ADD CONSTRAINT "org_slug_chk" CHECK ("slug" ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$');
