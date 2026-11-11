CREATE SCHEMA "shelfline";
--> statement-breakpoint
CREATE TABLE "shelfline"."audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"actor_id" uuid,
	"actor_kind" text DEFAULT 'user' NOT NULL,
	"action" text NOT NULL,
	"subject_type" text,
	"subject_id" text,
	"before" jsonb,
	"after" jsonb,
	"detail" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"device_id" uuid
);
--> statement-breakpoint
CREATE TABLE "shelfline"."device" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"location_id" uuid NOT NULL,
	"register_id" uuid,
	"name" text NOT NULL,
	"serial" text,
	"key_hash" text NOT NULL,
	"last_seen_at" timestamp with time zone,
	"clock_skew_ms" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_kind_chk" CHECK ("shelfline"."device"."kind" in ('pos','bridge','terminal','printer')),
	CONSTRAINT "device_status_chk" CHECK ("shelfline"."device"."status" in ('active','revoked'))
);
--> statement-breakpoint
CREATE TABLE "shelfline"."location" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"timezone" text NOT NULL,
	"day_cutoff" time DEFAULT '04:00' NOT NULL,
	"tax_region" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "location_org_code_uq" UNIQUE("org_id","code"),
	CONSTRAINT "location_type_chk" CHECK ("shelfline"."location"."type" in ('store','warehouse','transit','virtual')),
	CONSTRAINT "location_status_chk" CHECK ("shelfline"."location"."status" in ('active','inactive'))
);
--> statement-breakpoint
CREATE TABLE "shelfline"."org" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"currency" char(3) NOT NULL,
	"timezone_default" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shelfline"."register" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "register_org_code_uq" UNIQUE("org_id","code"),
	CONSTRAINT "register_status_chk" CHECK ("shelfline"."register"."status" in ('active','inactive'))
);
--> statement-breakpoint
CREATE TABLE "shelfline"."role" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"system" boolean DEFAULT false NOT NULL,
	CONSTRAINT "role_org_key_uq" UNIQUE("org_id","key")
);
--> statement-breakpoint
CREATE TABLE "shelfline"."role_permission" (
	"role_id" uuid NOT NULL,
	"permission" text NOT NULL,
	CONSTRAINT "role_permission_uq" UNIQUE("role_id","permission")
);
--> statement-breakpoint
CREATE TABLE "shelfline"."staff_profile" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"employee_code" text NOT NULL,
	"pin_hash" text,
	"pin_attempts" integer DEFAULT 0 NOT NULL,
	"pin_locked_until" timestamp with time zone,
	"terminal_person_code" text,
	"hired_on" date,
	"ended_on" date,
	CONSTRAINT "staff_org_code_uq" UNIQUE("org_id","employee_code")
);
--> statement-breakpoint
CREATE TABLE "shelfline"."user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text,
	"totp_secret_enc" text,
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_status_chk" CHECK ("shelfline"."user"."status" in ('active','disabled'))
);
--> statement-breakpoint
CREATE TABLE "shelfline"."user_assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"location_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_assignment_uq" UNIQUE NULLS NOT DISTINCT("user_id","role_id","location_id")
);
--> statement-breakpoint
ALTER TABLE "shelfline"."device" ADD CONSTRAINT "device_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."device" ADD CONSTRAINT "device_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "shelfline"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."device" ADD CONSTRAINT "device_register_id_register_id_fk" FOREIGN KEY ("register_id") REFERENCES "shelfline"."register"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."location" ADD CONSTRAINT "location_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."register" ADD CONSTRAINT "register_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."register" ADD CONSTRAINT "register_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "shelfline"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."role" ADD CONSTRAINT "role_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."role_permission" ADD CONSTRAINT "role_permission_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "shelfline"."role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."staff_profile" ADD CONSTRAINT "staff_profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "shelfline"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."staff_profile" ADD CONSTRAINT "staff_profile_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."user" ADD CONSTRAINT "user_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."user_assignment" ADD CONSTRAINT "user_assignment_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "shelfline"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."user_assignment" ADD CONSTRAINT "user_assignment_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "shelfline"."role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."user_assignment" ADD CONSTRAINT "user_assignment_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "shelfline"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_org_at_idx" ON "shelfline"."audit_log" USING btree ("org_id","at");--> statement-breakpoint
CREATE INDEX "audit_action_idx" ON "shelfline"."audit_log" USING btree ("org_id","action");--> statement-breakpoint
CREATE UNIQUE INDEX "device_key_hash_uq" ON "shelfline"."device" USING btree ("key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "user_org_email_uq" ON "shelfline"."user" USING btree ("org_id",lower("email"));--> statement-breakpoint
CREATE INDEX "user_assignment_user_idx" ON "shelfline"."user_assignment" USING btree ("user_id");