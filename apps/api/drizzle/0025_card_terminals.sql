CREATE TABLE "shelfline"."card_payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"register_id" uuid,
	"reader_id" uuid NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"provider" text NOT NULL,
	"provider_ref" text,
	"failure" text,
	"brand" text,
	"last4" text,
	"requested_by" uuid,
	"idempotency_key" uuid NOT NULL,
	"sale_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "card_payment_key_uq" UNIQUE("org_id","idempotency_key"),
	CONSTRAINT "card_payment_amount_chk" CHECK ("shelfline"."card_payment"."amount_minor" > 0),
	CONSTRAINT "card_payment_status_chk" CHECK ("shelfline"."card_payment"."status" in ('processing','succeeded','failed','canceled'))
);
--> statement-breakpoint
CREATE TABLE "shelfline"."card_reader" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"register_id" uuid,
	"name" text NOT NULL,
	"provider_reader_id" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_reader_location_name_uq" UNIQUE("location_id","name")
);
--> statement-breakpoint
ALTER TABLE "shelfline"."card_payment" ADD CONSTRAINT "card_payment_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."card_payment" ADD CONSTRAINT "card_payment_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "shelfline"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."card_payment" ADD CONSTRAINT "card_payment_reader_id_card_reader_id_fk" FOREIGN KEY ("reader_id") REFERENCES "shelfline"."card_reader"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."card_reader" ADD CONSTRAINT "card_reader_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."card_reader" ADD CONSTRAINT "card_reader_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "shelfline"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."card_reader" ADD CONSTRAINT "card_reader_register_id_register_id_fk" FOREIGN KEY ("register_id") REFERENCES "shelfline"."register"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "card_payment_sale_idx" ON "shelfline"."card_payment" USING btree ("sale_id");--> statement-breakpoint
CREATE FUNCTION "shelfline"."card_payment_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'a card payment cannot be deleted'; END IF;
  IF (NEW.org_id, NEW.location_id, NEW.reader_id, NEW.amount_minor, NEW.currency, NEW.provider, NEW.idempotency_key, NEW.created_at) IS DISTINCT FROM (OLD.org_id, OLD.location_id, OLD.reader_id, OLD.amount_minor, OLD.currency, OLD.provider, OLD.idempotency_key, OLD.created_at) THEN RAISE EXCEPTION 'what was asked of the card terminal cannot be changed'; END IF;
  IF OLD.status <> 'processing' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.provider_ref IS DISTINCT FROM OLD.provider_ref) THEN RAISE EXCEPTION 'a finished card payment cannot change'; END IF;
  IF OLD.sale_id IS NOT NULL AND NEW.sale_id IS DISTINCT FROM OLD.sale_id THEN RAISE EXCEPTION 'a card payment belongs to one sale'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER card_payment_guard BEFORE UPDATE OR DELETE ON "shelfline"."card_payment" FOR EACH ROW EXECUTE FUNCTION "shelfline"."card_payment_guard"();
