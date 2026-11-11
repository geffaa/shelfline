CREATE TABLE "shelfline"."sso_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"issuer" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_enc" text NOT NULL,
	"email_domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_connection_org_uq" UNIQUE("org_id")
);
--> statement-breakpoint
CREATE TABLE "shelfline"."sso_ticket" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shelfline"."sso_connection" ADD CONSTRAINT "sso_connection_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."sso_ticket" ADD CONSTRAINT "sso_ticket_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "shelfline"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelfline"."sso_ticket" ADD CONSTRAINT "sso_ticket_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "shelfline"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint;--> statement-breakpoint
ALTER TABLE "shelfline"."sso_connection" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON "shelfline"."sso_connection" USING (shelfline.org_visible(org_id)) WITH CHECK (shelfline.org_visible(org_id));--> statement-breakpoint
ALTER TABLE "shelfline"."sso_ticket" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON "shelfline"."sso_ticket" USING (shelfline.org_visible(org_id)) WITH CHECK (shelfline.org_visible(org_id));
