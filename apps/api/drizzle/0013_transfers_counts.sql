CREATE TABLE "shelfline"."stock_count" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"number" text NOT NULL,
	"mode" text NOT NULL,
	"blind" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'counting' NOT NULL,
	"note" text,
	"category_id" uuid,
	"snapshot_at" timestamp with time zone DEFAULT now() NOT NULL,
	"snapshot_movement_id" bigint NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"committed_at" timestamp with time zone,
	"committed_by" uuid,
	CONSTRAINT "stock_count_org_number_uq" UNIQUE("org_id","number"),
	CONSTRAINT "stock_count_mode_chk" CHECK ("shelfline"."stock_count"."mode" in ('full','cycle')),
	CONSTRAINT "stock_count_status_chk" CHECK ("shelfline"."stock_count"."status" in ('counting','review','committed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "shelfline"."stock_count_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"count_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"expected_at_snapshot" integer NOT NULL,
	"counted_qty" integer,
	"unexpected" boolean DEFAULT false NOT NULL,
	"counted_by" uuid,
	"counted_at" timestamp with time zone,
	CONSTRAINT "stock_count_line_uq" UNIQUE("count_id","variant_id"),
	CONSTRAINT "stock_count_line_qty_chk" CHECK ("shelfline"."stock_count_line"."counted_qty" is null or "shelfline"."stock_count_line"."counted_qty" >= 0)
);
--> statement-breakpoint
CREATE TABLE "shelfline"."transfer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"number" text NOT NULL,
	"from_location_id" uuid NOT NULL,
	"to_location_id" uuid NOT NULL,
	"transit_location_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"sent_by" uuid,
	"closed_at" timestamp with time zone,
	CONSTRAINT "transfer_org_number_uq" UNIQUE("org_id","number"),
	CONSTRAINT "transfer_status_chk" CHECK ("shelfline"."transfer"."status" in ('draft','sent','partial','received','cancelled')),
	CONSTRAINT "transfer_places_chk" CHECK ("shelfline"."transfer"."from_location_id" <> "shelfline"."transfer"."to_location_id")
);
--> statement-breakpoint
CREATE TABLE "shelfline"."transfer_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transfer_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"variant_id" uuid NOT NULL,
	"qty_sent" integer NOT NULL,
	"qty_received" integer DEFAULT 0 NOT NULL,
	"qty_variance" integer DEFAULT 0 NOT NULL,
	"unit_cost_minor" integer,
	CONSTRAINT "transfer_line_no_uq" UNIQUE("transfer_id","line_no"),
	CONSTRAINT "transfer_line_variant_uq" UNIQUE("transfer_id","variant_id"),
	CONSTRAINT "transfer_line_qty_chk" CHECK ("shelfline"."transfer_line"."qty_sent" > 0 and "shelfline"."transfer_line"."qty_received" >= 0 and "shelfline"."transfer_line"."qty_variance" >= 0 and "shelfline"."transfer_line"."qty_received" + "shelfline"."transfer_line"."qty_variance" <= "shelfline"."transfer_line"."qty_sent")
);
--> statement-breakpoint
CREATE TABLE "shelfline"."transfer_receipt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"transfer_id" uuid NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"closed_short" boolean DEFAULT false NOT NULL,
	"note" text,
	"received_by" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfer_receipt_idem_uq" UNIQUE("org_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "shelfline"."transfer_receipt_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_id" uuid NOT NULL,
	"transfer_line_id" uuid NOT NULL,
	"qty_received" integer NOT NULL,
	"qty_variance" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "transfer_receipt_line_uq" UNIQUE("receipt_id","transfer_line_id")
);
--> statement-breakpoint
ALTER TABLE "shelfline"."stock_count" ADD CONSTRAINT "stock_count_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."stock_count" ADD CONSTRAINT "stock_count_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "shelfline"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."stock_count" ADD CONSTRAINT "stock_count_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "shelfline"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."stock_count" ADD CONSTRAINT "stock_count_committed_by_user_id_fk" FOREIGN KEY ("committed_by") REFERENCES "shelfline"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."stock_count_line" ADD CONSTRAINT "stock_count_line_count_id_stock_count_id_fk" FOREIGN KEY ("count_id") REFERENCES "shelfline"."stock_count"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."stock_count_line" ADD CONSTRAINT "stock_count_line_variant_id_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "shelfline"."variant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."stock_count_line" ADD CONSTRAINT "stock_count_line_counted_by_user_id_fk" FOREIGN KEY ("counted_by") REFERENCES "shelfline"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."transfer" ADD CONSTRAINT "transfer_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."transfer" ADD CONSTRAINT "transfer_from_location_id_location_id_fk" FOREIGN KEY ("from_location_id") REFERENCES "shelfline"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."transfer" ADD CONSTRAINT "transfer_to_location_id_location_id_fk" FOREIGN KEY ("to_location_id") REFERENCES "shelfline"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."transfer" ADD CONSTRAINT "transfer_transit_location_id_location_id_fk" FOREIGN KEY ("transit_location_id") REFERENCES "shelfline"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."transfer" ADD CONSTRAINT "transfer_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "shelfline"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."transfer" ADD CONSTRAINT "transfer_sent_by_user_id_fk" FOREIGN KEY ("sent_by") REFERENCES "shelfline"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."transfer_line" ADD CONSTRAINT "transfer_line_transfer_id_transfer_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "shelfline"."transfer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."transfer_line" ADD CONSTRAINT "transfer_line_variant_id_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "shelfline"."variant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."transfer_receipt" ADD CONSTRAINT "transfer_receipt_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."transfer_receipt" ADD CONSTRAINT "transfer_receipt_transfer_id_transfer_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "shelfline"."transfer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."transfer_receipt" ADD CONSTRAINT "transfer_receipt_received_by_user_id_fk" FOREIGN KEY ("received_by") REFERENCES "shelfline"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."transfer_receipt_line" ADD CONSTRAINT "transfer_receipt_line_receipt_id_transfer_receipt_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "shelfline"."transfer_receipt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."transfer_receipt_line" ADD CONSTRAINT "transfer_receipt_line_transfer_line_id_transfer_line_id_fk" FOREIGN KEY ("transfer_line_id") REFERENCES "shelfline"."transfer_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_count_loc_idx" ON "shelfline"."stock_count" USING btree ("org_id","location_id");--> statement-breakpoint
CREATE INDEX "transfer_status_idx" ON "shelfline"."transfer" USING btree ("org_id","status");--> statement-breakpoint
CREATE SEQUENCE "shelfline"."transfer_number_seq";
--> statement-breakpoint
CREATE SEQUENCE "shelfline"."count_number_seq";
--> statement-breakpoint
CREATE TRIGGER transfer_receipt_immutable BEFORE UPDATE OR DELETE ON "shelfline"."transfer_receipt" FOR EACH ROW EXECUTE FUNCTION "shelfline"."forbid_change"();
--> statement-breakpoint
CREATE TRIGGER transfer_receipt_line_immutable BEFORE UPDATE OR DELETE ON "shelfline"."transfer_receipt_line" FOR EACH ROW EXECUTE FUNCTION "shelfline"."forbid_change"();
