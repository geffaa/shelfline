-- No two rates for the same tax class and region may be effective on the same day.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE shelfline.tax_rate ADD CONSTRAINT tax_rate_no_overlap
  EXCLUDE USING gist (tax_class_id WITH =, (coalesce(region, '')) WITH =, daterange(valid_from, valid_to, '[)') WITH &&);
