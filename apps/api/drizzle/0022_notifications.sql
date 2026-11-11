CREATE TABLE "shelfline"."notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"event_kind" text NOT NULL,
	"event_ref" text NOT NULL,
	"location_id" uuid,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"status" text DEFAULT 'delivered' NOT NULL,
	"email_status" text DEFAULT 'none' NOT NULL,
	"held_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	CONSTRAINT "notification_once_uq" UNIQUE("rule_id","user_id","event_ref"),
	CONSTRAINT "notification_status_chk" CHECK ("shelfline"."notification"."status" in ('delivered','held')),
	CONSTRAINT "notification_email_chk" CHECK ("shelfline"."notification"."email_status" in ('none','sent','held','digest','digested')),
	CONSTRAINT "notification_severity_chk" CHECK ("shelfline"."notification"."severity" in ('info','warning','critical'))
);
--> statement-breakpoint
CREATE TABLE "shelfline"."notification_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"event_kind" text NOT NULL,
	"location_ids" uuid[],
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recipient_user_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"recipient_roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"channels" text[] DEFAULT '{in_app}'::text[] NOT NULL,
	"quiet_start" text,
	"quiet_end" text,
	"critical" boolean DEFAULT false NOT NULL,
	"digest" boolean DEFAULT false NOT NULL,
	"digest_at" text DEFAULT '18:00' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_rule_kind_chk" CHECK ("shelfline"."notification_rule"."event_kind" in ('punch_in','punch_out','late_arrival','register_open','register_close','no_sale','cash_variance','large_refund')),
	CONSTRAINT "notification_rule_channels_chk" CHECK ("shelfline"."notification_rule"."channels" <@ array['in_app','email']::text[] and cardinality("shelfline"."notification_rule"."channels") > 0)
);
--> statement-breakpoint
ALTER TABLE "shelfline"."notification" ADD CONSTRAINT "notification_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."notification" ADD CONSTRAINT "notification_rule_id_notification_rule_id_fk" FOREIGN KEY ("rule_id") REFERENCES "shelfline"."notification_rule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."notification" ADD CONSTRAINT "notification_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "shelfline"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."notification" ADD CONSTRAINT "notification_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "shelfline"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."notification_rule" ADD CONSTRAINT "notification_rule_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_user_idx" ON "shelfline"."notification" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notification_rule_org_idx" ON "shelfline"."notification_rule" USING btree ("org_id","event_kind");