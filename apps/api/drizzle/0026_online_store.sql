CREATE TABLE "shelfline"."online_order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"number" text NOT NULL,
	"location_id" uuid NOT NULL,
	"status" text DEFAULT 'placed' NOT NULL,
	"customer_email" text NOT NULL,
	"customer_name" text NOT NULL,
	"customer_phone" text,
	"pickup_code_hash" text NOT NULL,
	"access_token_hash" text NOT NULL,
	"subtotal_minor" integer NOT NULL,
	"tax_minor" integer NOT NULL,
	"total_minor" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ready_at" timestamp with time zone,
	"collected_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"sale_id" uuid,
	CONSTRAINT "online_order_number_uq" UNIQUE("org_id","number"),
	CONSTRAINT "online_order_status_chk" CHECK ("shelfline"."online_order"."status" in ('placed','ready','collected','cancelled','expired'))
);
--> statement-breakpoint
CREATE TABLE "shelfline"."online_order_line" (
	"order_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"variant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"options_label" text DEFAULT '' NOT NULL,
	"qty" integer NOT NULL,
	"unit_price_minor" integer NOT NULL,
	"total_minor" integer NOT NULL,
	"tax_minor" integer NOT NULL,
	CONSTRAINT "online_order_line_pk" UNIQUE("order_id","line_no"),
	CONSTRAINT "online_order_line_qty_chk" CHECK ("shelfline"."online_order_line"."qty" > 0)
);
--> statement-breakpoint
ALTER TABLE "shelfline"."location" ADD COLUMN "pickup_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shelfline"."online_order" ADD CONSTRAINT "online_order_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."online_order" ADD CONSTRAINT "online_order_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "shelfline"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."online_order_line" ADD CONSTRAINT "online_order_line_order_id_online_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "shelfline"."online_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."online_order_line" ADD CONSTRAINT "online_order_line_variant_id_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "shelfline"."variant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "online_order_loc_idx" ON "shelfline"."online_order" USING btree ("location_id","status","placed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "online_order_code_uq" ON "shelfline"."online_order" USING btree ("location_id","pickup_code_hash") WHERE "shelfline"."online_order"."status" in ('placed','ready');--> statement-breakpoint
CREATE SEQUENCE "shelfline"."online_order_seq" START 1;
--> statement-breakpoint
CREATE FUNCTION "shelfline"."online_order_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'an online order cannot be deleted'; END IF;
  IF (NEW.org_id, NEW.number, NEW.location_id, NEW.customer_email, NEW.pickup_code_hash, NEW.total_minor, NEW.placed_at) IS DISTINCT FROM (OLD.org_id, OLD.number, OLD.location_id, OLD.customer_email, OLD.pickup_code_hash, OLD.total_minor, OLD.placed_at) THEN RAISE EXCEPTION 'an online order cannot be rewritten'; END IF;
  IF OLD.status IN ('collected', 'cancelled', 'expired') AND NEW.status IS DISTINCT FROM OLD.status THEN RAISE EXCEPTION 'a finished online order cannot change status'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER online_order_guard BEFORE UPDATE OR DELETE ON "shelfline"."online_order" FOR EACH ROW EXECUTE FUNCTION "shelfline"."online_order_guard"();
--> statement-breakpoint
CREATE TRIGGER online_order_line_immutable BEFORE UPDATE OR DELETE ON "shelfline"."online_order_line" FOR EACH ROW EXECUTE FUNCTION "shelfline"."forbid_change"();
