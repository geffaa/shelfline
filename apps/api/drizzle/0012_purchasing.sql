CREATE TABLE "shelfline"."bill_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bill_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"po_line_id" uuid,
	"variant_id" uuid,
	"description" text NOT NULL,
	"qty" integer NOT NULL,
	"unit_cost_minor" integer NOT NULL,
	"total_minor" integer NOT NULL,
	CONSTRAINT "bill_line_no_uq" UNIQUE("bill_id","line_no")
);
--> statement-breakpoint
CREATE TABLE "shelfline"."bill_payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"amount_minor" integer NOT NULL,
	"paid_on" date NOT NULL,
	"method" text NOT NULL,
	"reference" text,
	"idempotency_key" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bill_payment_idem_uq" UNIQUE("org_id","idempotency_key"),
	CONSTRAINT "bill_payment_amt_chk" CHECK ("shelfline"."bill_payment"."amount_minor" > 0),
	CONSTRAINT "bill_payment_method_chk" CHECK ("shelfline"."bill_payment"."method" in ('bank_transfer','card','cash','other'))
);
--> statement-breakpoint
CREATE TABLE "shelfline"."bill_receipt_match" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bill_id" uuid NOT NULL,
	"bill_line_id" uuid NOT NULL,
	"po_line_id" uuid NOT NULL,
	"billed_qty" integer NOT NULL,
	"billed_qty_to_date" integer NOT NULL,
	"received_qty" integer NOT NULL,
	"qty_diff" integer NOT NULL,
	"billed_unit_minor" integer NOT NULL,
	"ordered_unit_minor" integer NOT NULL,
	"cost_diff_minor" integer NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "bill_match_line_uq" UNIQUE("bill_line_id"),
	CONSTRAINT "bill_match_status_chk" CHECK ("shelfline"."bill_receipt_match"."status" in ('ok','over_billed','price_variance','both'))
);
--> statement-breakpoint
CREATE TABLE "shelfline"."po_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"po_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"variant_id" uuid NOT NULL,
	"qty_ordered" integer NOT NULL,
	"qty_received" integer DEFAULT 0 NOT NULL,
	"unit_cost_minor" integer NOT NULL,
	CONSTRAINT "po_line_no_uq" UNIQUE("po_id","line_no"),
	CONSTRAINT "po_line_variant_uq" UNIQUE("po_id","variant_id"),
	CONSTRAINT "po_line_qty_chk" CHECK ("shelfline"."po_line"."qty_ordered" > 0 and "shelfline"."po_line"."qty_received" between 0 and "shelfline"."po_line"."qty_ordered"),
	CONSTRAINT "po_line_cost_chk" CHECK ("shelfline"."po_line"."unit_cost_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "shelfline"."purchase_order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"number" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"expected_on" date,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	CONSTRAINT "po_org_number_uq" UNIQUE("org_id","number"),
	CONSTRAINT "po_status_chk" CHECK ("shelfline"."purchase_order"."status" in ('draft','sent','partial','received','closed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "shelfline"."receipt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"po_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"number" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"freight_minor" integer DEFAULT 0 NOT NULL,
	"other_cost_minor" integer DEFAULT 0 NOT NULL,
	"note" text,
	"received_by" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_org_number_uq" UNIQUE("org_id","number"),
	CONSTRAINT "receipt_idem_uq" UNIQUE("org_id","idempotency_key"),
	CONSTRAINT "receipt_cost_chk" CHECK ("shelfline"."receipt"."freight_minor" >= 0 and "shelfline"."receipt"."other_cost_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "shelfline"."receipt_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"po_line_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	"unit_cost_minor" integer NOT NULL,
	"landed_alloc_minor" integer DEFAULT 0 NOT NULL,
	"landed_unit_cost_minor" integer NOT NULL,
	CONSTRAINT "receipt_line_no_uq" UNIQUE("receipt_id","line_no"),
	CONSTRAINT "receipt_line_qty_chk" CHECK ("shelfline"."receipt_line"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "shelfline"."supplier" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"contact_name" text,
	"email" text,
	"phone" text,
	"terms_days" integer DEFAULT 30 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_status_chk" CHECK ("shelfline"."supplier"."status" in ('active','archived')),
	CONSTRAINT "supplier_terms_chk" CHECK ("shelfline"."supplier"."terms_days" between 0 and 365)
);
--> statement-breakpoint
CREATE TABLE "shelfline"."supplier_bill" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"po_id" uuid,
	"number" text NOT NULL,
	"bill_date" date NOT NULL,
	"due_on" date NOT NULL,
	"total_minor" integer NOT NULL,
	"paid_minor" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"hold_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"approved_by" uuid,
	"approved_note" text,
	"approved_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bill_status_chk" CHECK ("shelfline"."supplier_bill"."status" in ('held','open','partially_paid','paid','void')),
	CONSTRAINT "bill_paid_chk" CHECK ("shelfline"."supplier_bill"."paid_minor" between 0 and "shelfline"."supplier_bill"."total_minor")
);
--> statement-breakpoint
ALTER TABLE "shelfline"."bill_line" ADD CONSTRAINT "bill_line_bill_id_supplier_bill_id_fk" FOREIGN KEY ("bill_id") REFERENCES "shelfline"."supplier_bill"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."bill_line" ADD CONSTRAINT "bill_line_po_line_id_po_line_id_fk" FOREIGN KEY ("po_line_id") REFERENCES "shelfline"."po_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."bill_line" ADD CONSTRAINT "bill_line_variant_id_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "shelfline"."variant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."bill_payment" ADD CONSTRAINT "bill_payment_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."bill_payment" ADD CONSTRAINT "bill_payment_bill_id_supplier_bill_id_fk" FOREIGN KEY ("bill_id") REFERENCES "shelfline"."supplier_bill"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."bill_payment" ADD CONSTRAINT "bill_payment_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "shelfline"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."bill_receipt_match" ADD CONSTRAINT "bill_receipt_match_bill_id_supplier_bill_id_fk" FOREIGN KEY ("bill_id") REFERENCES "shelfline"."supplier_bill"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."bill_receipt_match" ADD CONSTRAINT "bill_receipt_match_bill_line_id_bill_line_id_fk" FOREIGN KEY ("bill_line_id") REFERENCES "shelfline"."bill_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."bill_receipt_match" ADD CONSTRAINT "bill_receipt_match_po_line_id_po_line_id_fk" FOREIGN KEY ("po_line_id") REFERENCES "shelfline"."po_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."po_line" ADD CONSTRAINT "po_line_po_id_purchase_order_id_fk" FOREIGN KEY ("po_id") REFERENCES "shelfline"."purchase_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."po_line" ADD CONSTRAINT "po_line_variant_id_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "shelfline"."variant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."purchase_order" ADD CONSTRAINT "purchase_order_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."purchase_order" ADD CONSTRAINT "purchase_order_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "shelfline"."supplier"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."purchase_order" ADD CONSTRAINT "purchase_order_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "shelfline"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."purchase_order" ADD CONSTRAINT "purchase_order_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "shelfline"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."receipt" ADD CONSTRAINT "receipt_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."receipt" ADD CONSTRAINT "receipt_po_id_purchase_order_id_fk" FOREIGN KEY ("po_id") REFERENCES "shelfline"."purchase_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."receipt" ADD CONSTRAINT "receipt_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "shelfline"."supplier"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."receipt" ADD CONSTRAINT "receipt_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "shelfline"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."receipt" ADD CONSTRAINT "receipt_received_by_user_id_fk" FOREIGN KEY ("received_by") REFERENCES "shelfline"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."receipt_line" ADD CONSTRAINT "receipt_line_receipt_id_receipt_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "shelfline"."receipt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."receipt_line" ADD CONSTRAINT "receipt_line_po_line_id_po_line_id_fk" FOREIGN KEY ("po_line_id") REFERENCES "shelfline"."po_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."receipt_line" ADD CONSTRAINT "receipt_line_variant_id_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "shelfline"."variant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."supplier" ADD CONSTRAINT "supplier_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."supplier_bill" ADD CONSTRAINT "supplier_bill_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."supplier_bill" ADD CONSTRAINT "supplier_bill_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "shelfline"."supplier"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."supplier_bill" ADD CONSTRAINT "supplier_bill_po_id_purchase_order_id_fk" FOREIGN KEY ("po_id") REFERENCES "shelfline"."purchase_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."supplier_bill" ADD CONSTRAINT "supplier_bill_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "shelfline"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."supplier_bill" ADD CONSTRAINT "supplier_bill_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "shelfline"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "po_supplier_idx" ON "shelfline"."purchase_order" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "receipt_line_po_idx" ON "shelfline"."receipt_line" USING btree ("po_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_org_name_uq" ON "shelfline"."supplier" USING btree ("org_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "bill_supplier_number_uq" ON "shelfline"."supplier_bill" USING btree ("org_id","supplier_id",lower("number"));--> statement-breakpoint
CREATE INDEX "bill_due_idx" ON "shelfline"."supplier_bill" USING btree ("org_id","due_on");--> statement-breakpoint
CREATE SEQUENCE "shelfline"."po_number_seq";
--> statement-breakpoint
CREATE SEQUENCE "shelfline"."receipt_number_seq";
--> statement-breakpoint
-- Receipts and their lines are facts: no edits, no deletes (corrections are new movements).
CREATE FUNCTION "shelfline"."forbid_change"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% on % is not allowed: it is append-only', TG_OP, TG_TABLE_NAME; END $$;
--> statement-breakpoint
CREATE TRIGGER receipt_immutable BEFORE UPDATE OR DELETE ON "shelfline"."receipt" FOR EACH ROW EXECUTE FUNCTION "shelfline"."forbid_change"();
--> statement-breakpoint
CREATE TRIGGER receipt_line_immutable BEFORE UPDATE OR DELETE ON "shelfline"."receipt_line" FOR EACH ROW EXECUTE FUNCTION "shelfline"."forbid_change"();
--> statement-breakpoint
CREATE TRIGGER bill_payment_immutable BEFORE UPDATE OR DELETE ON "shelfline"."bill_payment" FOR EACH ROW EXECUTE FUNCTION "shelfline"."forbid_change"();
