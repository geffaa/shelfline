CREATE TABLE "shelfline"."campaign" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"segment_id" uuid,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"audience" jsonb,
	"sent_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_status_chk" CHECK ("shelfline"."campaign"."status" in ('draft','sending','sent','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "shelfline"."consent_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"channel" text DEFAULT 'email' NOT NULL,
	"granted" boolean NOT NULL,
	"source" text NOT NULL,
	"actor_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shelfline"."flow" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flow_kind_uq" UNIQUE("org_id","kind"),
	CONSTRAINT "flow_kind_chk" CHECK ("shelfline"."flow"."kind" in ('win_back','birthday','post_purchase'))
);
--> statement-breakpoint
CREATE TABLE "shelfline"."loyalty_entry" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"points" integer NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"note" text,
	"actor_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_entry_once_uq" UNIQUE("org_id","customer_id","kind","source_type","source_id"),
	CONSTRAINT "loyalty_entry_kind_chk" CHECK ("shelfline"."loyalty_entry"."kind" in ('earn','clawback','redeem','adjust','bonus')),
	CONSTRAINT "loyalty_entry_sign_chk" CHECK ("shelfline"."loyalty_entry"."points" <> 0 and ("shelfline"."loyalty_entry"."kind" not in ('earn','bonus') or "shelfline"."loyalty_entry"."points" > 0) and ("shelfline"."loyalty_entry"."kind" not in ('clawback','redeem') or "shelfline"."loyalty_entry"."points" < 0))
);
--> statement-breakpoint
CREATE TABLE "shelfline"."loyalty_program" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"points_per_dollar" integer DEFAULT 1 NOT NULL,
	"tiers" jsonb DEFAULT '[{"name":"Member","min":0,"multBp":10000},{"name":"Silver","min":500,"multBp":12500},{"name":"Gold","min":1500,"multBp":15000}]'::jsonb NOT NULL,
	"redeem_points" integer DEFAULT 100 NOT NULL,
	"redeem_value_minor" integer DEFAULT 500 NOT NULL,
	"birthday_bonus" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "loyalty_program_chk" CHECK ("shelfline"."loyalty_program"."points_per_dollar" between 0 and 100 and "shelfline"."loyalty_program"."redeem_points" between 1 and 100000 and "shelfline"."loyalty_program"."redeem_value_minor" between 0 and 1000000 and "shelfline"."loyalty_program"."birthday_bonus" between 0 and 10000)
);
--> statement-breakpoint
CREATE TABLE "shelfline"."marketing_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"campaign_id" uuid,
	"flow_id" uuid,
	"flow_key" text,
	"customer_id" uuid NOT NULL,
	"email" text,
	"subject" text NOT NULL,
	"status" text NOT NULL,
	"skip_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketing_message_status_chk" CHECK ("shelfline"."marketing_message"."status" in ('sent','skipped'))
);
--> statement-breakpoint
CREATE TABLE "shelfline"."marketing_setting" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"min_gap_days" integer DEFAULT 7 NOT NULL,
	CONSTRAINT "marketing_gap_chk" CHECK ("shelfline"."marketing_setting"."min_gap_days" between 0 and 90)
);
--> statement-breakpoint
CREATE TABLE "shelfline"."segment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"rules" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shelfline"."customer" ADD COLUMN "birth_month" integer;--> statement-breakpoint
ALTER TABLE "shelfline"."customer" ADD COLUMN "birth_day" integer;--> statement-breakpoint
ALTER TABLE "shelfline"."campaign" ADD CONSTRAINT "campaign_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."campaign" ADD CONSTRAINT "campaign_segment_id_segment_id_fk" FOREIGN KEY ("segment_id") REFERENCES "shelfline"."segment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."consent_event" ADD CONSTRAINT "consent_event_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."consent_event" ADD CONSTRAINT "consent_event_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "shelfline"."customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."flow" ADD CONSTRAINT "flow_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."loyalty_entry" ADD CONSTRAINT "loyalty_entry_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."loyalty_entry" ADD CONSTRAINT "loyalty_entry_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "shelfline"."customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."loyalty_program" ADD CONSTRAINT "loyalty_program_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."marketing_message" ADD CONSTRAINT "marketing_message_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."marketing_message" ADD CONSTRAINT "marketing_message_campaign_id_campaign_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "shelfline"."campaign"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."marketing_message" ADD CONSTRAINT "marketing_message_flow_id_flow_id_fk" FOREIGN KEY ("flow_id") REFERENCES "shelfline"."flow"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."marketing_message" ADD CONSTRAINT "marketing_message_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "shelfline"."customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."marketing_setting" ADD CONSTRAINT "marketing_setting_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."segment" ADD CONSTRAINT "segment_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consent_event_customer_idx" ON "shelfline"."consent_event" USING btree ("customer_id","at");--> statement-breakpoint
CREATE INDEX "loyalty_entry_customer_idx" ON "shelfline"."loyalty_entry" USING btree ("customer_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "marketing_message_campaign_uq" ON "shelfline"."marketing_message" USING btree ("campaign_id","customer_id") WHERE "shelfline"."marketing_message"."campaign_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "marketing_message_flow_uq" ON "shelfline"."marketing_message" USING btree ("flow_id","customer_id","flow_key") WHERE "shelfline"."marketing_message"."flow_id" is not null;--> statement-breakpoint
CREATE INDEX "marketing_message_customer_idx" ON "shelfline"."marketing_message" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "segment_name_uq" ON "shelfline"."segment" USING btree ("org_id",lower("name"));--> statement-breakpoint
ALTER TABLE "shelfline"."customer" ADD CONSTRAINT "customer_birthday_chk" CHECK (("shelfline"."customer"."birth_month" is null and "shelfline"."customer"."birth_day" is null) or ("shelfline"."customer"."birth_month" between 1 and 12 and "shelfline"."customer"."birth_day" between 1 and 31));--> statement-breakpoint
CREATE TRIGGER consent_event_immutable BEFORE UPDATE OR DELETE ON "shelfline"."consent_event" FOR EACH ROW EXECUTE FUNCTION "shelfline"."forbid_change"();
--> statement-breakpoint
CREATE TRIGGER loyalty_entry_immutable BEFORE UPDATE OR DELETE ON "shelfline"."loyalty_entry" FOR EACH ROW EXECUTE FUNCTION "shelfline"."forbid_change"();
--> statement-breakpoint
CREATE TRIGGER marketing_message_immutable BEFORE UPDATE OR DELETE ON "shelfline"."marketing_message" FOR EACH ROW EXECUTE FUNCTION "shelfline"."forbid_change"();
