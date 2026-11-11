CREATE TABLE "shelfline"."customer" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"marketing_consent" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shelfline"."payment" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sale_id" uuid NOT NULL,
	"tender" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"change_minor" integer DEFAULT 0 NOT NULL,
	"reference" text,
	CONSTRAINT "payment_tender_chk" CHECK ("shelfline"."payment"."tender" in ('cash','card','gift_card','store_credit','other'))
);
--> statement-breakpoint
CREATE TABLE "shelfline"."register_session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"opened_by" uuid NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"opening_float_minor" integer NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"counted_close_minor" integer,
	"expected_close_minor" integer,
	"variance_minor" integer,
	"count_breakdown" jsonb,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "register_session_status_chk" CHECK ("shelfline"."register_session"."status" in ('open','closed','force_closed'))
);
--> statement-breakpoint
CREATE TABLE "shelfline"."sale" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"receipt_no" text NOT NULL,
	"session_id" uuid,
	"register_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"cashier_id" uuid NOT NULL,
	"customer_id" uuid,
	"channel" text DEFAULT 'pos' NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"subtotal_minor" integer NOT NULL,
	"discount_minor" integer NOT NULL,
	"tax_minor" integer NOT NULL,
	"total_minor" integer NOT NULL,
	"rounding_minor" integer DEFAULT 0 NOT NULL,
	"payable_minor" integer NOT NULL,
	"tendered_minor" integer NOT NULL,
	"change_minor" integer DEFAULT 0 NOT NULL,
	"price_snapshot" jsonb,
	"client_ts" timestamp with time zone NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"local_date" date NOT NULL,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"device_id" uuid,
	"command_id" uuid,
	CONSTRAINT "sale_register_receipt_uq" UNIQUE("register_id","receipt_no")
);
--> statement-breakpoint
CREATE TABLE "shelfline"."sale_line" (
	"sale_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"variant_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	"unit_price_minor" integer NOT NULL,
	"discount_minor" integer DEFAULT 0 NOT NULL,
	"discount_reason" text,
	"approved_by" uuid,
	"tax_rate_bp" integer NOT NULL,
	"tax_inclusive" boolean NOT NULL,
	"tax_minor" integer NOT NULL,
	"total_minor" integer NOT NULL,
	"unit_cost_minor" integer,
	"attributed_to" uuid NOT NULL,
	"refunded_qty" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "sale_line_pk" UNIQUE("sale_id","line_no"),
	CONSTRAINT "sale_line_qty_chk" CHECK ("shelfline"."sale_line"."qty" > 0)
);
--> statement-breakpoint
ALTER TABLE "shelfline"."location" ADD COLUMN "cashier_discount_limit_bp" integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE "shelfline"."customer" ADD CONSTRAINT "customer_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."payment" ADD CONSTRAINT "payment_sale_id_sale_id_fk" FOREIGN KEY ("sale_id") REFERENCES "shelfline"."sale"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."register_session" ADD CONSTRAINT "register_session_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."register_session" ADD CONSTRAINT "register_session_register_id_register_id_fk" FOREIGN KEY ("register_id") REFERENCES "shelfline"."register"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."register_session" ADD CONSTRAINT "register_session_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "shelfline"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."sale" ADD CONSTRAINT "sale_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."sale" ADD CONSTRAINT "sale_session_id_register_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "shelfline"."register_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."sale" ADD CONSTRAINT "sale_register_id_register_id_fk" FOREIGN KEY ("register_id") REFERENCES "shelfline"."register"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."sale" ADD CONSTRAINT "sale_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "shelfline"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."sale" ADD CONSTRAINT "sale_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "shelfline"."customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."sale_line" ADD CONSTRAINT "sale_line_sale_id_sale_id_fk" FOREIGN KEY ("sale_id") REFERENCES "shelfline"."sale"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."sale_line" ADD CONSTRAINT "sale_line_variant_id_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "shelfline"."variant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_org_email_uq" ON "shelfline"."customer" USING btree ("org_id",lower("email")) WHERE "shelfline"."customer"."email" is not null;--> statement-breakpoint
CREATE INDEX "payment_sale_idx" ON "shelfline"."payment" USING btree ("sale_id");--> statement-breakpoint
CREATE UNIQUE INDEX "register_session_one_open_uq" ON "shelfline"."register_session" USING btree ("register_id") WHERE "shelfline"."register_session"."status" = 'open';--> statement-breakpoint
CREATE INDEX "sale_location_date_idx" ON "shelfline"."sale" USING btree ("location_id","local_date");--> statement-breakpoint
CREATE INDEX "sale_session_idx" ON "shelfline"."sale" USING btree ("session_id");