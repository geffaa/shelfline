CREATE TABLE "shelfline"."email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"to_email" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "shelfline"."portal_login_code" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shelfline"."report_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"grantee_user_id" uuid NOT NULL,
	"report_keys" text[] NOT NULL,
	"location_ids" uuid[],
	"range_kind" text NOT NULL,
	"range_from" date,
	"range_to" date,
	"rolling_days" integer,
	"hidden_columns" text[] DEFAULT '{}'::text[] NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_grant_range_chk" CHECK (("shelfline"."report_grant"."range_kind" = 'fixed' and "shelfline"."report_grant"."range_from" is not null and "shelfline"."report_grant"."range_to" is not null and "shelfline"."report_grant"."range_to" >= "shelfline"."report_grant"."range_from" and "shelfline"."report_grant"."rolling_days" is null) or ("shelfline"."report_grant"."range_kind" = 'rolling' and "shelfline"."report_grant"."rolling_days" between 1 and 366 and "shelfline"."report_grant"."range_from" is null and "shelfline"."report_grant"."range_to" is null)),
	CONSTRAINT "report_grant_keys_chk" CHECK (cardinality("shelfline"."report_grant"."report_keys") > 0)
);
--> statement-breakpoint
CREATE TABLE "shelfline"."report_view_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"report_key" text NOT NULL,
	"format" text NOT NULL,
	"requested" jsonb NOT NULL,
	"served" jsonb NOT NULL,
	"row_count" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shelfline"."user" ADD COLUMN "portal_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shelfline"."email_outbox" ADD CONSTRAINT "email_outbox_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."portal_login_code" ADD CONSTRAINT "portal_login_code_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "shelfline"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."report_grant" ADD CONSTRAINT "report_grant_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."report_grant" ADD CONSTRAINT "report_grant_grantee_user_id_user_id_fk" FOREIGN KEY ("grantee_user_id") REFERENCES "shelfline"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."report_view_log" ADD CONSTRAINT "report_view_log_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."report_view_log" ADD CONSTRAINT "report_view_log_grant_id_report_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "shelfline"."report_grant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_outbox_to_idx" ON "shelfline"."email_outbox" USING btree ("to_email","created_at");--> statement-breakpoint
CREATE INDEX "portal_login_code_user_idx" ON "shelfline"."portal_login_code" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "report_grant_user_idx" ON "shelfline"."report_grant" USING btree ("grantee_user_id");--> statement-breakpoint
CREATE INDEX "report_view_grant_idx" ON "shelfline"."report_view_log" USING btree ("grant_id","at");--> statement-breakpoint
CREATE TRIGGER report_view_log_immutable BEFORE UPDATE OR DELETE ON "shelfline"."report_view_log" FOR EACH ROW EXECUTE FUNCTION "shelfline"."forbid_change"();
--> statement-breakpoint
CREATE FUNCTION "shelfline"."report_grant_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'a report grant cannot be deleted: revoke it'; END IF;
  IF OLD.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'a revoked report grant cannot be changed'; END IF;
  IF (NEW.org_id, NEW.grantee_user_id, NEW.report_keys, NEW.location_ids, NEW.range_kind, NEW.range_from, NEW.range_to, NEW.rolling_days, NEW.hidden_columns, NEW.expires_at, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.org_id, OLD.grantee_user_id, OLD.report_keys, OLD.location_ids, OLD.range_kind, OLD.range_from, OLD.range_to, OLD.rolling_days, OLD.hidden_columns, OLD.expires_at, OLD.created_by, OLD.created_at)
  THEN RAISE EXCEPTION 'a report grant cannot be edited: revoke it and make a new one'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER report_grant_guard BEFORE UPDATE OR DELETE ON "shelfline"."report_grant" FOR EACH ROW EXECUTE FUNCTION "shelfline"."report_grant_guard"();
