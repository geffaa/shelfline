CREATE TABLE "shelfline"."commission_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"location_id" uuid,
	"kind" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" uuid NOT NULL,
	"line_no" integer DEFAULT 0 NOT NULL,
	"rule_id" uuid,
	"base_minor" integer DEFAULT 0 NOT NULL,
	"amount_minor" integer NOT NULL,
	"local_date" date NOT NULL,
	"late" boolean DEFAULT false NOT NULL,
	"reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_entry_source_uq" UNIQUE("source_kind","source_id","line_no","user_id","kind"),
	CONSTRAINT "commission_entry_kind_chk" CHECK ("shelfline"."commission_entry"."kind" in ('earn','clawback','adjust')),
	CONSTRAINT "commission_entry_source_chk" CHECK ("shelfline"."commission_entry"."source_kind" in ('sale','refund','adjust'))
);
--> statement-breakpoint
CREATE TABLE "shelfline"."commission_period" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_period_range_chk" CHECK ("shelfline"."commission_period"."end_date" >= "shelfline"."commission_period"."start_date"),
	CONSTRAINT "commission_period_status_chk" CHECK ("shelfline"."commission_period"."status" in ('open','locked'))
);
--> statement-breakpoint
CREATE TABLE "shelfline"."commission_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_set_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"valid_from" date NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"basis" text NOT NULL,
	"rate_bp" integer NOT NULL,
	"split_mode" text NOT NULL,
	"weights" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_rule_version_uq" UNIQUE("rule_set_id","version"),
	CONSTRAINT "commission_rule_from_uq" UNIQUE("rule_set_id","valid_from"),
	CONSTRAINT "commission_rule_rate_chk" CHECK ("shelfline"."commission_rule"."rate_bp" between 0 and 10000),
	CONSTRAINT "commission_rule_basis_chk" CHECK ("shelfline"."commission_rule"."basis" in ('net_ex_tax','margin')),
	CONSTRAINT "commission_rule_split_chk" CHECK ("shelfline"."commission_rule"."split_mode" in ('seller','equal','weighted','hours_pool'))
);
--> statement-breakpoint
CREATE TABLE "shelfline"."commission_rule_set" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_value" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_rule_set_scope_chk" CHECK ("shelfline"."commission_rule_set"."scope_kind" in ('default','location','category','brand','variant') and (("shelfline"."commission_rule_set"."scope_kind" = 'default') = ("shelfline"."commission_rule_set"."scope_value" is null)))
);
--> statement-breakpoint
CREATE TABLE "shelfline"."commission_statement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"earned_minor" integer NOT NULL,
	"clawback_minor" integer NOT NULL,
	"adjust_minor" integer NOT NULL,
	"net_minor" integer NOT NULL,
	"entries" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_statement_uq" UNIQUE("period_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "shelfline"."commission_entry" ADD CONSTRAINT "commission_entry_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."commission_entry" ADD CONSTRAINT "commission_entry_period_id_commission_period_id_fk" FOREIGN KEY ("period_id") REFERENCES "shelfline"."commission_period"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."commission_entry" ADD CONSTRAINT "commission_entry_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "shelfline"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."commission_entry" ADD CONSTRAINT "commission_entry_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "shelfline"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."commission_entry" ADD CONSTRAINT "commission_entry_rule_id_commission_rule_id_fk" FOREIGN KEY ("rule_id") REFERENCES "shelfline"."commission_rule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."commission_period" ADD CONSTRAINT "commission_period_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."commission_rule" ADD CONSTRAINT "commission_rule_rule_set_id_commission_rule_set_id_fk" FOREIGN KEY ("rule_set_id") REFERENCES "shelfline"."commission_rule_set"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."commission_rule_set" ADD CONSTRAINT "commission_rule_set_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."commission_statement" ADD CONSTRAINT "commission_statement_period_id_commission_period_id_fk" FOREIGN KEY ("period_id") REFERENCES "shelfline"."commission_period"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."commission_statement" ADD CONSTRAINT "commission_statement_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "shelfline"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commission_entry_period_idx" ON "shelfline"."commission_entry" USING btree ("period_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_rule_set_scope_uq" ON "shelfline"."commission_rule_set" USING btree ("org_id","scope_kind",coalesce("scope_value", ''));--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "shelfline"."commission_period" ADD CONSTRAINT "commission_period_no_overlap" EXCLUDE USING gist ("org_id" WITH =, daterange("start_date", "end_date", '[]') WITH &&);
--> statement-breakpoint
CREATE FUNCTION "shelfline"."commission_entry_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text; pid uuid;
BEGIN
  pid := CASE WHEN TG_OP = 'INSERT' THEN NEW.period_id ELSE OLD.period_id END;
  SELECT status INTO st FROM "shelfline"."commission_period" WHERE id = pid;
  IF st <> 'open' THEN RAISE EXCEPTION '% on commission_entry is not allowed: its period is locked', TG_OP; END IF;
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'UPDATE on commission_entry is not allowed: rebuild instead'; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint
CREATE TRIGGER commission_entry_guard BEFORE INSERT OR UPDATE OR DELETE ON "shelfline"."commission_entry" FOR EACH ROW EXECUTE FUNCTION "shelfline"."commission_entry_guard"();
--> statement-breakpoint
CREATE FUNCTION "shelfline"."commission_period_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN IF OLD.status <> 'open' THEN RAISE EXCEPTION 'a locked commission period cannot be deleted'; END IF; RETURN OLD; END IF;
  IF OLD.status <> 'open' THEN RAISE EXCEPTION 'a locked commission period cannot be changed'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER commission_period_guard BEFORE UPDATE OR DELETE ON "shelfline"."commission_period" FOR EACH ROW EXECUTE FUNCTION "shelfline"."commission_period_guard"();
--> statement-breakpoint
CREATE TRIGGER commission_rule_immutable BEFORE UPDATE OR DELETE ON "shelfline"."commission_rule" FOR EACH ROW EXECUTE FUNCTION "shelfline"."forbid_change"();
--> statement-breakpoint
CREATE TRIGGER commission_statement_immutable BEFORE UPDATE OR DELETE ON "shelfline"."commission_statement" FOR EACH ROW EXECUTE FUNCTION "shelfline"."forbid_change"();
