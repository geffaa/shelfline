CREATE TABLE "shelfline"."balance_entry" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"account_type" text NOT NULL,
	"account_id" uuid NOT NULL,
	"delta_minor" integer NOT NULL,
	"kind" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"line_no" integer DEFAULT 0 NOT NULL,
	"location_id" uuid,
	"device_id" uuid,
	"actor_id" uuid,
	"note" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "balance_entry_source_uq" UNIQUE("org_id","source_type","source_id","line_no","kind"),
	CONSTRAINT "balance_entry_type_chk" CHECK ("shelfline"."balance_entry"."account_type" in ('gift_card','store_credit')),
	CONSTRAINT "balance_entry_kind_chk" CHECK ("shelfline"."balance_entry"."kind" in ('issue','topup','redeem','refund_credit','adjust')),
	CONSTRAINT "balance_entry_nonzero_chk" CHECK ("shelfline"."balance_entry"."delta_minor" <> 0)
);
--> statement-breakpoint
CREATE TABLE "shelfline"."gift_card" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"code_last4" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"customer_id" uuid,
	"expires_on" date,
	"note" text,
	"issued_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gift_card_code_uq" UNIQUE("org_id","code_hash"),
	CONSTRAINT "gift_card_status_chk" CHECK ("shelfline"."gift_card"."status" in ('active','void'))
);
--> statement-breakpoint
ALTER TABLE "shelfline"."location" ADD COLUMN "gift_card_offline" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shelfline"."location" ADD COLUMN "gift_card_offline_cap_minor" integer DEFAULT 5000 NOT NULL;--> statement-breakpoint
ALTER TABLE "shelfline"."balance_entry" ADD CONSTRAINT "balance_entry_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."gift_card" ADD CONSTRAINT "gift_card_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."gift_card" ADD CONSTRAINT "gift_card_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "shelfline"."customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."gift_card" ADD CONSTRAINT "gift_card_issued_by_user_id_fk" FOREIGN KEY ("issued_by") REFERENCES "shelfline"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "balance_entry_account_idx" ON "shelfline"."balance_entry" USING btree ("account_type","account_id","id");--> statement-breakpoint
CREATE TRIGGER balance_entry_immutable BEFORE UPDATE OR DELETE ON "shelfline"."balance_entry" FOR EACH ROW EXECUTE FUNCTION "shelfline"."forbid_change"();
