CREATE TABLE "shelfline"."print_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"printer_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"copy" integer DEFAULT 1 NOT NULL,
	"payload_base64" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	CONSTRAINT "print_job_once_uq" UNIQUE("printer_id","source_type","source_id","kind","copy"),
	CONSTRAINT "print_job_kind_chk" CHECK ("shelfline"."print_job"."kind" in ('receipt','drawer','test')),
	CONSTRAINT "print_job_status_chk" CHECK ("shelfline"."print_job"."status" in ('queued','sending','done','failed'))
);
--> statement-breakpoint
CREATE TABLE "shelfline"."printer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"register_id" uuid,
	"name" text NOT NULL,
	"host" text NOT NULL,
	"port" integer DEFAULT 9100 NOT NULL,
	"columns" integer DEFAULT 42 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_ok_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "printer_location_name_uq" UNIQUE("location_id","name"),
	CONSTRAINT "printer_port_chk" CHECK ("shelfline"."printer"."port" between 1 and 65535),
	CONSTRAINT "printer_columns_chk" CHECK ("shelfline"."printer"."columns" between 24 and 64)
);
--> statement-breakpoint
ALTER TABLE "shelfline"."print_job" ADD CONSTRAINT "print_job_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."print_job" ADD CONSTRAINT "print_job_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "shelfline"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."print_job" ADD CONSTRAINT "print_job_printer_id_printer_id_fk" FOREIGN KEY ("printer_id") REFERENCES "shelfline"."printer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."printer" ADD CONSTRAINT "printer_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."printer" ADD CONSTRAINT "printer_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "shelfline"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."printer" ADD CONSTRAINT "printer_register_id_register_id_fk" FOREIGN KEY ("register_id") REFERENCES "shelfline"."register"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "print_job_queue_idx" ON "shelfline"."print_job" USING btree ("location_id","status","created_at");