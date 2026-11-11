CREATE TABLE "shelfline"."stock_balance" (
	"org_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"on_hand" integer DEFAULT 0 NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"incoming" integer DEFAULT 0 NOT NULL,
	"avg_cost_minor" integer,
	"version" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "stock_balance_pk" UNIQUE("variant_id","location_id")
);
--> statement-breakpoint
CREATE TABLE "shelfline"."stock_movement" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"qty_delta" integer NOT NULL,
	"kind" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"line_no" integer DEFAULT 0 NOT NULL,
	"unit_cost_minor" integer,
	"reason" text,
	"note" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"local_date" date NOT NULL,
	"device_id" uuid,
	"actor_id" uuid,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "stock_movement_source_uq" UNIQUE("org_id","source_type","source_id","line_no","kind"),
	CONSTRAINT "stock_movement_nonzero_chk" CHECK ("shelfline"."stock_movement"."qty_delta" <> 0),
	CONSTRAINT "stock_movement_kind_chk" CHECK ("shelfline"."stock_movement"."kind" in ('sale','refund_return','receive_po','manual_receive','transfer_out','transfer_in','transfer_variance','count_adjust','manual_adjust','write_off','online_reserve','online_release','opening_balance'))
);
--> statement-breakpoint
ALTER TABLE "shelfline"."stock_balance" ADD CONSTRAINT "stock_balance_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."stock_balance" ADD CONSTRAINT "stock_balance_variant_id_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "shelfline"."variant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."stock_balance" ADD CONSTRAINT "stock_balance_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "shelfline"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."stock_movement" ADD CONSTRAINT "stock_movement_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."stock_movement" ADD CONSTRAINT "stock_movement_variant_id_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "shelfline"."variant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."stock_movement" ADD CONSTRAINT "stock_movement_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "shelfline"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_movement_card_idx" ON "shelfline"."stock_movement" USING btree ("variant_id","location_id","id");