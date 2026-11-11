CREATE TABLE "shelfline"."price_book" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"valid_from" date,
	"valid_to" date,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_book_status_chk" CHECK ("shelfline"."price_book"."status" in ('active','archived')),
	CONSTRAINT "price_book_window_chk" CHECK ("shelfline"."price_book"."valid_from" is null or "shelfline"."price_book"."valid_to" is null or "shelfline"."price_book"."valid_from" <= "shelfline"."price_book"."valid_to")
);
--> statement-breakpoint
CREATE TABLE "shelfline"."price_book_entry" (
	"price_book_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"price_minor" integer NOT NULL,
	CONSTRAINT "price_book_entry_pk" UNIQUE("price_book_id","variant_id"),
	CONSTRAINT "price_book_entry_chk" CHECK ("shelfline"."price_book_entry"."price_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "shelfline"."price_book_location" (
	"price_book_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	CONSTRAINT "price_book_location_pk" UNIQUE("price_book_id","location_id")
);
--> statement-breakpoint
CREATE TABLE "shelfline"."promotion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"value_bp" integer DEFAULT 0 NOT NULL,
	"amount_minor" integer DEFAULT 0 NOT NULL,
	"min_qty" integer DEFAULT 1 NOT NULL,
	"stackable" boolean DEFAULT false NOT NULL,
	"valid_from" date,
	"valid_to" date,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promotion_kind_chk" CHECK ("shelfline"."promotion"."kind" in ('percent','amount_off')),
	CONSTRAINT "promotion_status_chk" CHECK ("shelfline"."promotion"."status" in ('active','archived')),
	CONSTRAINT "promotion_value_chk" CHECK (("shelfline"."promotion"."kind" = 'percent' and "shelfline"."promotion"."value_bp" between 1 and 10000 and "shelfline"."promotion"."amount_minor" = 0) or ("shelfline"."promotion"."kind" = 'amount_off' and "shelfline"."promotion"."amount_minor" > 0 and "shelfline"."promotion"."value_bp" = 0)),
	CONSTRAINT "promotion_minqty_chk" CHECK ("shelfline"."promotion"."min_qty" >= 1),
	CONSTRAINT "promotion_window_chk" CHECK ("shelfline"."promotion"."valid_from" is null or "shelfline"."promotion"."valid_to" is null or "shelfline"."promotion"."valid_from" <= "shelfline"."promotion"."valid_to")
);
--> statement-breakpoint
CREATE TABLE "shelfline"."promotion_location" (
	"promotion_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	CONSTRAINT "promotion_location_pk" UNIQUE("promotion_id","location_id")
);
--> statement-breakpoint
CREATE TABLE "shelfline"."promotion_variant" (
	"promotion_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	CONSTRAINT "promotion_variant_pk" UNIQUE("promotion_id","variant_id")
);
--> statement-breakpoint
ALTER TABLE "shelfline"."price_book" ADD CONSTRAINT "price_book_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."price_book_entry" ADD CONSTRAINT "price_book_entry_price_book_id_price_book_id_fk" FOREIGN KEY ("price_book_id") REFERENCES "shelfline"."price_book"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."price_book_entry" ADD CONSTRAINT "price_book_entry_variant_id_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "shelfline"."variant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."price_book_location" ADD CONSTRAINT "price_book_location_price_book_id_price_book_id_fk" FOREIGN KEY ("price_book_id") REFERENCES "shelfline"."price_book"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."price_book_location" ADD CONSTRAINT "price_book_location_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "shelfline"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."promotion" ADD CONSTRAINT "promotion_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."promotion_location" ADD CONSTRAINT "promotion_location_promotion_id_promotion_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "shelfline"."promotion"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."promotion_location" ADD CONSTRAINT "promotion_location_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "shelfline"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."promotion_variant" ADD CONSTRAINT "promotion_variant_promotion_id_promotion_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "shelfline"."promotion"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."promotion_variant" ADD CONSTRAINT "promotion_variant_variant_id_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "shelfline"."variant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "price_book_org_name_uq" ON "shelfline"."price_book" USING btree ("org_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "promotion_org_name_uq" ON "shelfline"."promotion" USING btree ("org_id",lower("name"));--> statement-breakpoint
-- Books and promotions replicate to the tills. Which ones a given till holds is decided when the entity is loaded (scope by location), so these log without a location.
CREATE FUNCTION "shelfline"."log_pricing_change"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r jsonb; org uuid; kind text := TG_ARGV[0]; eid text; BEGIN
  IF TG_OP = 'DELETE' THEN r := to_jsonb(OLD); ELSE r := to_jsonb(NEW); END IF;
  IF kind = 'price_book_entry' THEN
    SELECT b.org_id INTO org FROM shelfline.price_book b WHERE b.id = (r->>'price_book_id')::uuid; eid := (r->>'price_book_id') || ':' || (r->>'variant_id');
  ELSIF kind = 'price_book' AND TG_TABLE_NAME = 'price_book_location' THEN
    SELECT b.org_id INTO org FROM shelfline.price_book b WHERE b.id = (r->>'price_book_id')::uuid; eid := r->>'price_book_id';
  ELSIF kind = 'promotion' AND TG_TABLE_NAME <> 'promotion' THEN
    SELECT p.org_id INTO org FROM shelfline.promotion p WHERE p.id = (r->>'promotion_id')::uuid; eid := r->>'promotion_id';
  ELSE org := (r->>'org_id')::uuid; eid := r->>'id'; END IF;
  IF org IS NOT NULL THEN INSERT INTO shelfline.change_log (org_id, entity_type, entity_id, op, location_id) VALUES (org, kind, eid, CASE WHEN TG_OP = 'DELETE' AND TG_TABLE_NAME IN ('price_book','promotion') THEN 'delete' WHEN TG_OP = 'DELETE' AND kind = 'price_book_entry' THEN 'delete' ELSE 'upsert' END, NULL); END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER price_book_log AFTER INSERT OR UPDATE OR DELETE ON "shelfline"."price_book" FOR EACH ROW EXECUTE FUNCTION "shelfline"."log_pricing_change"('price_book');
--> statement-breakpoint
CREATE TRIGGER price_book_location_log AFTER INSERT OR UPDATE OR DELETE ON "shelfline"."price_book_location" FOR EACH ROW EXECUTE FUNCTION "shelfline"."log_pricing_change"('price_book');
--> statement-breakpoint
CREATE TRIGGER price_book_entry_log AFTER INSERT OR UPDATE OR DELETE ON "shelfline"."price_book_entry" FOR EACH ROW EXECUTE FUNCTION "shelfline"."log_pricing_change"('price_book_entry');
--> statement-breakpoint
CREATE TRIGGER promotion_log AFTER INSERT OR UPDATE OR DELETE ON "shelfline"."promotion" FOR EACH ROW EXECUTE FUNCTION "shelfline"."log_pricing_change"('promotion');
--> statement-breakpoint
CREATE TRIGGER promotion_variant_log AFTER INSERT OR UPDATE OR DELETE ON "shelfline"."promotion_variant" FOR EACH ROW EXECUTE FUNCTION "shelfline"."log_pricing_change"('promotion');
--> statement-breakpoint
CREATE TRIGGER promotion_location_log AFTER INSERT OR UPDATE OR DELETE ON "shelfline"."promotion_location" FOR EACH ROW EXECUTE FUNCTION "shelfline"."log_pricing_change"('promotion');
