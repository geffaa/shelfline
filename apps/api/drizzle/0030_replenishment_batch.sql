CREATE TABLE "shelfline"."replenishment_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"key" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"po_ids" uuid[] NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "replenishment_batch_key_uq" UNIQUE("org_id","key")
);
--> statement-breakpoint
ALTER TABLE "shelfline"."replenishment_batch" ADD CONSTRAINT "replenishment_batch_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."replenishment_batch" ADD CONSTRAINT "replenishment_batch_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "shelfline"."location"("id") ON DELETE no action ON UPDATE no action;