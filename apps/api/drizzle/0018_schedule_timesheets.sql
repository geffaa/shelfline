CREATE TABLE "shelfline"."shift" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"user_id" uuid,
	"local_date" date NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"role" text,
	"break_minutes" integer DEFAULT 0 NOT NULL,
	"note" text,
	"published_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shift_span_chk" CHECK ("shelfline"."shift"."ends_at" > "shelfline"."shift"."starts_at"),
	CONSTRAINT "shift_break_chk" CHECK ("shelfline"."shift"."break_minutes" between 0 and 480)
);
--> statement-breakpoint
CREATE TABLE "shelfline"."shift_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid,
	"name" text NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"role" text,
	"break_minutes" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shift_template_time_chk" CHECK ("shelfline"."shift_template"."start_time" ~ '^[0-2][0-9]:[0-5][0-9]$' and "shelfline"."shift_template"."end_time" ~ '^[0-2][0-9]:[0-5][0-9]$' and "shelfline"."shift_template"."start_time" <> "shelfline"."shift_template"."end_time")
);
--> statement-breakpoint
CREATE TABLE "shelfline"."staffing_need" (
	"location_id" uuid NOT NULL,
	"weekday" integer NOT NULL,
	"min_staff" integer NOT NULL,
	CONSTRAINT "staffing_need_pk" UNIQUE("location_id","weekday"),
	CONSTRAINT "staffing_need_chk" CHECK ("shelfline"."staffing_need"."weekday" between 0 and 6 and "shelfline"."staffing_need"."min_staff" between 0 and 50)
);
--> statement-breakpoint
CREATE TABLE "shelfline"."timesheet_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"punch_in_id" uuid NOT NULL,
	"punch_out_id" uuid,
	"shift_id" uuid,
	"in_at" timestamp with time zone NOT NULL,
	"out_at" timestamp with time zone,
	"break_minutes" integer DEFAULT 0 NOT NULL,
	"worked_minutes" integer,
	"scheduled_minutes" integer,
	"late_minutes" integer DEFAULT 0 NOT NULL,
	"variance_minutes" integer,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timesheet_in_uq" UNIQUE("user_id","punch_in_id"),
	CONSTRAINT "timesheet_status_chk" CHECK ("shelfline"."timesheet_entry"."status" in ('open','approved'))
);
--> statement-breakpoint
ALTER TABLE "shelfline"."shift" ADD CONSTRAINT "shift_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."shift" ADD CONSTRAINT "shift_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "shelfline"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."shift" ADD CONSTRAINT "shift_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "shelfline"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."shift" ADD CONSTRAINT "shift_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "shelfline"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."shift_template" ADD CONSTRAINT "shift_template_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."shift_template" ADD CONSTRAINT "shift_template_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "shelfline"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."staffing_need" ADD CONSTRAINT "staffing_need_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "shelfline"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."timesheet_entry" ADD CONSTRAINT "timesheet_entry_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."timesheet_entry" ADD CONSTRAINT "timesheet_entry_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "shelfline"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."timesheet_entry" ADD CONSTRAINT "timesheet_entry_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "shelfline"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."timesheet_entry" ADD CONSTRAINT "timesheet_entry_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "shelfline"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shift_loc_date_idx" ON "shelfline"."shift" USING btree ("location_id","local_date");--> statement-breakpoint
CREATE INDEX "shift_user_idx" ON "shelfline"."shift" USING btree ("user_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shift_template_name_uq" ON "shelfline"."shift_template" USING btree ("org_id",lower("name"));--> statement-breakpoint
CREATE INDEX "timesheet_loc_date_idx" ON "shelfline"."timesheet_entry" USING btree ("location_id","local_date");--> statement-breakpoint