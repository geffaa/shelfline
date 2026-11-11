ALTER TABLE "shelfline"."sale_line" ADD COLUMN "price_book_id" uuid;--> statement-breakpoint
ALTER TABLE "shelfline"."sale_line" ADD COLUMN "promo_discount_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shelfline"."sale_line" ADD COLUMN "promotion_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;