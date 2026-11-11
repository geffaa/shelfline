CREATE TABLE "shelfline"."change_log" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"txid" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	"org_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"op" text NOT NULL,
	"location_id" uuid,
	CONSTRAINT "change_log_op_chk" CHECK ("shelfline"."change_log"."op" in ('upsert','delete'))
);
--> statement-breakpoint
CREATE TABLE "shelfline"."sync_command_receipt" (
	"command_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"device_seq" bigint NOT NULL,
	"type" text NOT NULL,
	"actor_id" uuid,
	"status" text NOT NULL,
	"reason" text,
	"result" jsonb,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"client_ts" timestamp with time zone,
	"effective_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_receipt_device_seq_uq" UNIQUE("device_id","device_seq"),
	CONSTRAINT "sync_receipt_status_chk" CHECK ("shelfline"."sync_command_receipt"."status" in ('accepted','accepted_flagged','rejected'))
);
--> statement-breakpoint
CREATE TABLE "shelfline"."sync_exception" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref_type" text,
	"ref_id" text,
	"device_id" uuid,
	"command_id" uuid,
	"detail" jsonb,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "sync_exception_status_chk" CHECK ("shelfline"."sync_exception"."status" in ('open','resolved'))
);
--> statement-breakpoint
ALTER TABLE "shelfline"."device" ADD COLUMN "last_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shelfline"."sync_command_receipt" ADD CONSTRAINT "sync_command_receipt_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "shelfline"."device"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "change_log_order_idx" ON "shelfline"."change_log" USING btree ("org_id","txid","seq");--> statement-breakpoint
CREATE INDEX "sync_exception_open_idx" ON "shelfline"."sync_exception" USING btree ("org_id","status");