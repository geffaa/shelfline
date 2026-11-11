ALTER TABLE "shelfline"."refund" DROP CONSTRAINT "refund_tender_chk";--> statement-breakpoint
ALTER TABLE "shelfline"."refund" ADD CONSTRAINT "refund_tender_chk" CHECK ("shelfline"."refund"."tender" in ('cash','card','other','store_credit'));
