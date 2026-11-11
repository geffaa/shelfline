CREATE TABLE "shelfline"."cash_movement" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"session_id" uuid,
	"register_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"reason" text,
	"actor_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"local_date" date NOT NULL,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"device_id" uuid,
	"command_id" uuid,
	CONSTRAINT "cash_movement_kind_chk" CHECK ("shelfline"."cash_movement"."kind" in ('pay_in','pay_out','drop','float_add','no_sale')),
	CONSTRAINT "cash_movement_amount_chk" CHECK ("shelfline"."cash_movement"."amount_minor" >= 0 and ("shelfline"."cash_movement"."kind" <> 'no_sale' or "shelfline"."cash_movement"."amount_minor" = 0))
);
--> statement-breakpoint
CREATE TABLE "shelfline"."punch" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"method" text NOT NULL,
	"source_device_id" uuid,
	"client_ts" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"clock_skew_ms" integer,
	"status" text DEFAULT 'accepted' NOT NULL,
	"supersedes_id" uuid,
	CONSTRAINT "punch_kind_chk" CHECK ("shelfline"."punch"."kind" in ('in','out')),
	CONSTRAINT "punch_status_chk" CHECK ("shelfline"."punch"."status" in ('accepted','needs_review'))
);
--> statement-breakpoint
CREATE TABLE "shelfline"."refund" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"session_id" uuid,
	"register_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"tender" text NOT NULL,
	"reason" text NOT NULL,
	"total_minor" integer NOT NULL,
	"tax_minor" integer NOT NULL,
	"approved_by" uuid,
	"actor_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"local_date" date NOT NULL,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"device_id" uuid,
	"command_id" uuid,
	CONSTRAINT "refund_tender_chk" CHECK ("shelfline"."refund"."tender" in ('cash','card','other'))
);
--> statement-breakpoint
CREATE TABLE "shelfline"."refund_line" (
	"refund_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"sale_line_no" integer NOT NULL,
	"variant_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	"amount_minor" integer NOT NULL,
	"tax_minor" integer NOT NULL,
	"restock" boolean NOT NULL,
	CONSTRAINT "refund_line_pk" UNIQUE("refund_id","line_no")
);
--> statement-breakpoint
ALTER TABLE "shelfline"."location" ADD COLUMN "cashier_refund_limit_minor" integer DEFAULT 20000 NOT NULL;--> statement-breakpoint
ALTER TABLE "shelfline"."location" ADD COLUMN "cash_variance_limit_minor" integer DEFAULT 500 NOT NULL;--> statement-breakpoint
ALTER TABLE "shelfline"."register_session" ADD COLUMN "reviewed_by" uuid;--> statement-breakpoint
ALTER TABLE "shelfline"."register_session" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shelfline"."register_session" ADD COLUMN "review_note" text;--> statement-breakpoint
ALTER TABLE "shelfline"."sale_line" ADD COLUMN "refunded_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shelfline"."sale_line" ADD COLUMN "refunded_tax_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shelfline"."cash_movement" ADD CONSTRAINT "cash_movement_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."cash_movement" ADD CONSTRAINT "cash_movement_session_id_register_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "shelfline"."register_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."cash_movement" ADD CONSTRAINT "cash_movement_register_id_register_id_fk" FOREIGN KEY ("register_id") REFERENCES "shelfline"."register"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."cash_movement" ADD CONSTRAINT "cash_movement_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "shelfline"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."punch" ADD CONSTRAINT "punch_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."punch" ADD CONSTRAINT "punch_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "shelfline"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."refund" ADD CONSTRAINT "refund_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."refund" ADD CONSTRAINT "refund_sale_id_sale_id_fk" FOREIGN KEY ("sale_id") REFERENCES "shelfline"."sale"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."refund" ADD CONSTRAINT "refund_session_id_register_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "shelfline"."register_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."refund" ADD CONSTRAINT "refund_register_id_register_id_fk" FOREIGN KEY ("register_id") REFERENCES "shelfline"."register"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."refund" ADD CONSTRAINT "refund_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "shelfline"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."refund_line" ADD CONSTRAINT "refund_line_refund_id_refund_id_fk" FOREIGN KEY ("refund_id") REFERENCES "shelfline"."refund"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."refund_line" ADD CONSTRAINT "refund_line_variant_id_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "shelfline"."variant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_movement_session_idx" ON "shelfline"."cash_movement" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "cash_movement_loc_date_idx" ON "shelfline"."cash_movement" USING btree ("location_id","local_date");--> statement-breakpoint
CREATE INDEX "punch_user_idx" ON "shelfline"."punch" USING btree ("user_id","client_ts");--> statement-breakpoint
CREATE INDEX "refund_sale_idx" ON "shelfline"."refund" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "refund_session_idx" ON "shelfline"."refund" USING btree ("session_id");