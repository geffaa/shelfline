CREATE TABLE "shelfline"."bridge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"pairing_code_hash" text,
	"pairing_expires_at" timestamp with time zone,
	"paired_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"last_batch_size" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bridge_status_chk" CHECK ("shelfline"."bridge"."status" in ('pending','active','revoked'))
);
--> statement-breakpoint
CREATE TABLE "shelfline"."terminal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"serial" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "terminal_org_serial_uq" UNIQUE("org_id","serial"),
	CONSTRAINT "terminal_status_chk" CHECK ("shelfline"."terminal"."status" in ('active','revoked'))
);
--> statement-breakpoint
CREATE TABLE "shelfline"."terminal_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"bridge_id" uuid,
	"serial" text NOT NULL,
	"person_code" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"verify" text NOT NULL,
	"state" text,
	"status" text NOT NULL,
	"reason" text,
	"punch_id" uuid,
	"user_id" uuid,
	"location_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "terminal_event_uq" UNIQUE("org_id","serial","person_code","ts"),
	CONSTRAINT "terminal_event_status_chk" CHECK ("shelfline"."terminal_event"."status" in ('accepted','needs_review','dismissed')),
	CONSTRAINT "terminal_event_verify_chk" CHECK ("shelfline"."terminal_event"."verify" in ('fingerprint','face','card','password','other'))
);
--> statement-breakpoint
ALTER TABLE "shelfline"."bridge" ADD CONSTRAINT "bridge_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."bridge" ADD CONSTRAINT "bridge_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "shelfline"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."terminal" ADD CONSTRAINT "terminal_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."terminal" ADD CONSTRAINT "terminal_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "shelfline"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."terminal_event" ADD CONSTRAINT "terminal_event_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."terminal_event" ADD CONSTRAINT "terminal_event_bridge_id_bridge_id_fk" FOREIGN KEY ("bridge_id") REFERENCES "shelfline"."bridge"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bridge_org_idx" ON "shelfline"."bridge" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "terminal_event_status_idx" ON "shelfline"."terminal_event" USING btree ("org_id","status");