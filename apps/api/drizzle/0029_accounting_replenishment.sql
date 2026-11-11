CREATE TABLE "shelfline"."account_mapping" (
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"code" text NOT NULL,
	"name" text,
	CONSTRAINT "account_mapping_pk" UNIQUE("org_id","key"),
	CONSTRAINT "account_mapping_key_chk" CHECK ("shelfline"."account_mapping"."key" in ('cash','card_clearing','gift_card_liability','store_credit_liability','other_clearing','sales_revenue','gst_collected','rounding','cash_over_short','cogs','inventory','suspense'))
);
--> statement-breakpoint
CREATE TABLE "shelfline"."accounting_export" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"version" integer NOT NULL,
	"method" text NOT NULL,
	"lines" jsonb NOT NULL,
	"reference" text NOT NULL,
	"external_ref" text,
	"exported_by" uuid,
	"exported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_export_version_uq" UNIQUE("org_id","location_id","local_date","version"),
	CONSTRAINT "accounting_export_method_chk" CHECK ("shelfline"."accounting_export"."method" in ('xero','csv'))
);
--> statement-breakpoint
CREATE TABLE "shelfline"."xero_connection" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"access_token_enc" text,
	"refresh_token_enc" text,
	"client_id" text NOT NULL,
	"client_secret_enc" text,
	"expires_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "xero_connection_status_chk" CHECK ("shelfline"."xero_connection"."status" in ('active','disconnected'))
);
--> statement-breakpoint
ALTER TABLE "shelfline"."supplier" ADD COLUMN "lead_time_days" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "shelfline"."account_mapping" ADD CONSTRAINT "account_mapping_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."accounting_export" ADD CONSTRAINT "accounting_export_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."accounting_export" ADD CONSTRAINT "accounting_export_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "shelfline"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."xero_connection" ADD CONSTRAINT "xero_connection_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TRIGGER accounting_export_immutable BEFORE UPDATE OR DELETE ON "shelfline"."accounting_export" FOR EACH ROW EXECUTE FUNCTION "shelfline"."forbid_change"();
