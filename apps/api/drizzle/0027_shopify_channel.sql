CREATE TABLE "shelfline"."channel_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text DEFAULT 'shopify' NOT NULL,
	"name" text NOT NULL,
	"shop_domain" text NOT NULL,
	"access_token_enc" text,
	"webhook_secret_enc" text,
	"api_version" text DEFAULT '2025-10' NOT NULL,
	"location_id" uuid NOT NULL,
	"shopify_location_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_push_at" timestamp with time zone,
	"last_error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_connection_shop_uq" UNIQUE("org_id","shop_domain"),
	CONSTRAINT "channel_connection_status_chk" CHECK ("shelfline"."channel_connection"."status" in ('active','paused','disconnected'))
);
--> statement-breakpoint
CREATE TABLE "shelfline"."channel_listing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"shopify_variant_id" text NOT NULL,
	"shopify_inventory_item_id" text NOT NULL,
	"last_pushed_qty" integer,
	"last_pushed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_listing_variant_uq" UNIQUE("connection_id","variant_id"),
	CONSTRAINT "channel_listing_shopify_uq" UNIQUE("connection_id","shopify_variant_id")
);
--> statement-breakpoint
CREATE TABLE "shelfline"."channel_order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"shopify_order_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'imported' NOT NULL,
	"total_minor" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"customer_email" text,
	"lines" jsonb NOT NULL,
	"unmapped" integer DEFAULT 0 NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "channel_order_once_uq" UNIQUE("connection_id","shopify_order_id"),
	CONSTRAINT "channel_order_status_chk" CHECK ("shelfline"."channel_order"."status" in ('imported','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "shelfline"."channel_webhook" (
	"connection_id" uuid NOT NULL,
	"webhook_id" text NOT NULL,
	"topic" text NOT NULL,
	"result" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_webhook_once_uq" UNIQUE("connection_id","webhook_id")
);
--> statement-breakpoint
ALTER TABLE "shelfline"."channel_connection" ADD CONSTRAINT "channel_connection_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."channel_connection" ADD CONSTRAINT "channel_connection_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "shelfline"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."channel_listing" ADD CONSTRAINT "channel_listing_connection_id_channel_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "shelfline"."channel_connection"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."channel_listing" ADD CONSTRAINT "channel_listing_variant_id_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "shelfline"."variant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."channel_order" ADD CONSTRAINT "channel_order_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."channel_order" ADD CONSTRAINT "channel_order_connection_id_channel_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "shelfline"."channel_connection"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."channel_webhook" ADD CONSTRAINT "channel_webhook_connection_id_channel_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "shelfline"."channel_connection"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION "shelfline"."channel_order_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'an imported channel order cannot be deleted'; END IF;
  IF (NEW.org_id, NEW.connection_id, NEW.shopify_order_id, NEW.name, NEW.total_minor, NEW.lines, NEW.imported_at) IS DISTINCT FROM (OLD.org_id, OLD.connection_id, OLD.shopify_order_id, OLD.name, OLD.total_minor, OLD.lines, OLD.imported_at) THEN RAISE EXCEPTION 'an imported channel order cannot be rewritten'; END IF;
  IF OLD.status = 'cancelled' AND NEW.status <> 'cancelled' THEN RAISE EXCEPTION 'a cancelled channel order stays cancelled'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER channel_order_guard BEFORE UPDATE OR DELETE ON "shelfline"."channel_order" FOR EACH ROW EXECUTE FUNCTION "shelfline"."channel_order_guard"();
--> statement-breakpoint
CREATE TRIGGER channel_webhook_immutable BEFORE UPDATE OR DELETE ON "shelfline"."channel_webhook" FOR EACH ROW EXECUTE FUNCTION "shelfline"."forbid_change"();
