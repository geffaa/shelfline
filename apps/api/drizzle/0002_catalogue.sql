CREATE TABLE "shelfline"."catalog_version" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shelfline"."category" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shelfline"."product" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"title" text NOT NULL,
	"category_id" uuid,
	"tax_class_id" uuid NOT NULL,
	"brand" text,
	"status" text DEFAULT 'active' NOT NULL,
	"version" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_status_chk" CHECK ("shelfline"."product"."status" in ('active','archived'))
);
--> statement-breakpoint
CREATE TABLE "shelfline"."tax_class" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "tax_class_org_key_uq" UNIQUE("org_id","key")
);
--> statement-breakpoint
CREATE TABLE "shelfline"."tax_rate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tax_class_id" uuid NOT NULL,
	"region" text,
	"rate_bp" integer NOT NULL,
	"tax_inclusive" boolean NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_rate_bp_chk" CHECK ("shelfline"."tax_rate"."rate_bp" between 0 and 10000),
	CONSTRAINT "tax_rate_range_chk" CHECK ("shelfline"."tax_rate"."valid_to" is null or "shelfline"."tax_rate"."valid_to" > "shelfline"."tax_rate"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "shelfline"."variant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"barcode" text,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"base_price_minor" integer NOT NULL,
	"cost_minor" integer,
	"track_stock" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"version" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "variant_price_chk" CHECK ("shelfline"."variant"."base_price_minor" >= 0),
	CONSTRAINT "variant_status_chk" CHECK ("shelfline"."variant"."status" in ('active','archived'))
);
--> statement-breakpoint
ALTER TABLE "shelfline"."catalog_version" ADD CONSTRAINT "catalog_version_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."category" ADD CONSTRAINT "category_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."product" ADD CONSTRAINT "product_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."product" ADD CONSTRAINT "product_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "shelfline"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."product" ADD CONSTRAINT "product_tax_class_id_tax_class_id_fk" FOREIGN KEY ("tax_class_id") REFERENCES "shelfline"."tax_class"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."tax_class" ADD CONSTRAINT "tax_class_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."tax_rate" ADD CONSTRAINT "tax_rate_tax_class_id_tax_class_id_fk" FOREIGN KEY ("tax_class_id") REFERENCES "shelfline"."tax_class"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."variant" ADD CONSTRAINT "variant_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."variant" ADD CONSTRAINT "variant_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "shelfline"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "category_org_name_uq" ON "shelfline"."category" USING btree ("org_id",lower("name"));--> statement-breakpoint
CREATE INDEX "product_org_title_idx" ON "shelfline"."product" USING btree ("org_id",lower("title"));--> statement-breakpoint
CREATE UNIQUE INDEX "variant_org_sku_uq" ON "shelfline"."variant" USING btree ("org_id",lower(btrim("sku")));--> statement-breakpoint
CREATE UNIQUE INDEX "variant_org_barcode_uq" ON "shelfline"."variant" USING btree ("org_id","barcode") WHERE "shelfline"."variant"."barcode" is not null;--> statement-breakpoint
CREATE INDEX "variant_product_idx" ON "shelfline"."variant" USING btree ("product_id");