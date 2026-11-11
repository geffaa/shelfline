CREATE TABLE "shelfline"."eod_report_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"schedule_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"figures" jsonb NOT NULL,
	"checksum" text NOT NULL,
	"notes" text[] DEFAULT '{}'::text[] NOT NULL,
	"delivered" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eod_run_version_uq" UNIQUE("schedule_id","local_date","version"),
	CONSTRAINT "eod_run_status_chk" CHECK ("shelfline"."eod_report_run"."status" in ('provisional','final','amended'))
);
--> statement-breakpoint
CREATE TABLE "shelfline"."eod_schedule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"location_ids" uuid[],
	"send_at_local" text NOT NULL,
	"days_of_week" integer[] NOT NULL,
	"timezone" text NOT NULL,
	"methods" text[] NOT NULL,
	"recipients" text[] DEFAULT '{}'::text[] NOT NULL,
	"webhook_url" text,
	"webhook_secret" text,
	"format" text DEFAULT 'pdf' NOT NULL,
	"only_when_closed" boolean DEFAULT true NOT NULL,
	"max_wait_minutes" integer DEFAULT 120 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eod_schedule_time_chk" CHECK ("shelfline"."eod_schedule"."send_at_local" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
	CONSTRAINT "eod_schedule_format_chk" CHECK ("shelfline"."eod_schedule"."format" in ('pdf','csv','inline')),
	CONSTRAINT "eod_schedule_methods_chk" CHECK ("shelfline"."eod_schedule"."methods" <@ array['email','webhook']::text[] and cardinality("shelfline"."eod_schedule"."methods") > 0),
	CONSTRAINT "eod_schedule_days_chk" CHECK ("shelfline"."eod_schedule"."days_of_week" <@ array[0,1,2,3,4,5,6] and cardinality("shelfline"."eod_schedule"."days_of_week") > 0)
);
--> statement-breakpoint
CREATE TABLE "shelfline"."scheduled_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"schedule_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_job_once_uq" UNIQUE("kind","schedule_id","local_date"),
	CONSTRAINT "scheduled_job_status_chk" CHECK ("shelfline"."scheduled_job"."status" in ('pending','running','waiting','done','cancelled'))
);
--> statement-breakpoint
ALTER TABLE "shelfline"."device" ADD COLUMN "queued_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shelfline"."device" ADD COLUMN "queued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shelfline"."email_outbox" ADD COLUMN "attachment_name" text;--> statement-breakpoint
ALTER TABLE "shelfline"."email_outbox" ADD COLUMN "attachment_type" text;--> statement-breakpoint
ALTER TABLE "shelfline"."email_outbox" ADD COLUMN "attachment_base64" text;--> statement-breakpoint
ALTER TABLE "shelfline"."eod_report_run" ADD CONSTRAINT "eod_report_run_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."eod_report_run" ADD CONSTRAINT "eod_report_run_schedule_id_eod_schedule_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "shelfline"."eod_schedule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."eod_schedule" ADD CONSTRAINT "eod_schedule_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."scheduled_job" ADD CONSTRAINT "scheduled_job_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scheduled_job_due_idx" ON "shelfline"."scheduled_job" USING btree ("status","run_at");--> statement-breakpoint
CREATE TRIGGER eod_report_run_immutable BEFORE UPDATE OR DELETE ON "shelfline"."eod_report_run" FOR EACH ROW EXECUTE FUNCTION "shelfline"."forbid_change"();
--> statement-breakpoint
-- The report run table is append-only, with two narrow exceptions written as functions the worker calls: record who it was delivered to, and settle a provisional version into final.
DROP TRIGGER eod_report_run_immutable ON "shelfline"."eod_report_run";
--> statement-breakpoint
CREATE FUNCTION "shelfline"."eod_report_run_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'an end-of-day report run cannot be deleted'; END IF;
  IF (NEW.figures, NEW.checksum, NEW.version, NEW.local_date, NEW.schedule_id, NEW.notes, NEW.generated_at) IS DISTINCT FROM (OLD.figures, OLD.checksum, OLD.version, OLD.local_date, OLD.schedule_id, OLD.notes, OLD.generated_at) THEN RAISE EXCEPTION 'the figures of a report run cannot be changed: make a new version'; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'provisional' AND NEW.status = 'final') THEN RAISE EXCEPTION 'a report run can only settle from provisional to final'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER eod_report_run_guard BEFORE UPDATE OR DELETE ON "shelfline"."eod_report_run" FOR EACH ROW EXECUTE FUNCTION "shelfline"."eod_report_run_guard"();
--> statement-breakpoint
CREATE FUNCTION "shelfline"."eod_delivered"(run uuid, d jsonb) RETURNS void LANGUAGE sql AS $$ UPDATE "shelfline"."eod_report_run" SET delivered = d WHERE id = run $$;
--> statement-breakpoint
CREATE FUNCTION "shelfline"."eod_settle"(run uuid) RETURNS void LANGUAGE sql AS $$ UPDATE "shelfline"."eod_report_run" SET status = 'final' WHERE id = run AND status = 'provisional' $$;
