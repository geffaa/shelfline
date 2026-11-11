-- Every replicated table logs its changes in the same transaction. Entities that belong to one location carry location_id,
-- so a POS only receives its own location's stock, location and registers.
CREATE OR REPLACE FUNCTION shelfline.log_change() RETURNS trigger AS $$
DECLARE
  r jsonb; org uuid; eid text; loc uuid := NULL; kind text := TG_ARGV[0];
BEGIN
  IF TG_OP = 'DELETE' THEN r := to_jsonb(OLD); ELSE r := to_jsonb(NEW); END IF;
  IF kind = 'tax_rate' THEN
    SELECT tc.org_id INTO org FROM shelfline.tax_class tc WHERE tc.id = (r->>'tax_class_id')::uuid;
  ELSE
    org := (r->>'org_id')::uuid;
  END IF;
  IF kind = 'stock_balance' THEN
    eid := (r->>'variant_id') || ':' || (r->>'location_id'); loc := (r->>'location_id')::uuid;
  ELSIF kind = 'location' THEN
    eid := r->>'id'; loc := (r->>'id')::uuid;
  ELSIF kind = 'register' THEN
    eid := r->>'id'; loc := (r->>'location_id')::uuid;
  ELSE
    eid := r->>'id';
  END IF;
  IF org IS NOT NULL THEN
    INSERT INTO shelfline.change_log (org_id, entity_type, entity_id, op, location_id)
    VALUES (org, kind, eid, CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END, loc);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER product_log AFTER INSERT OR UPDATE OR DELETE ON shelfline.product FOR EACH ROW EXECUTE FUNCTION shelfline.log_change('product');
--> statement-breakpoint
CREATE TRIGGER variant_log AFTER INSERT OR UPDATE OR DELETE ON shelfline.variant FOR EACH ROW EXECUTE FUNCTION shelfline.log_change('variant');
--> statement-breakpoint
CREATE TRIGGER category_log AFTER INSERT OR UPDATE OR DELETE ON shelfline.category FOR EACH ROW EXECUTE FUNCTION shelfline.log_change('category');
--> statement-breakpoint
CREATE TRIGGER tax_class_log AFTER INSERT OR UPDATE OR DELETE ON shelfline.tax_class FOR EACH ROW EXECUTE FUNCTION shelfline.log_change('tax_class');
--> statement-breakpoint
CREATE TRIGGER tax_rate_log AFTER INSERT OR UPDATE OR DELETE ON shelfline.tax_rate FOR EACH ROW EXECUTE FUNCTION shelfline.log_change('tax_rate');
--> statement-breakpoint
CREATE TRIGGER stock_balance_log AFTER INSERT OR UPDATE OR DELETE ON shelfline.stock_balance FOR EACH ROW EXECUTE FUNCTION shelfline.log_change('stock_balance');
--> statement-breakpoint
CREATE TRIGGER location_log AFTER INSERT OR UPDATE OR DELETE ON shelfline.location FOR EACH ROW EXECUTE FUNCTION shelfline.log_change('location');
--> statement-breakpoint
CREATE TRIGGER register_log AFTER INSERT OR UPDATE OR DELETE ON shelfline.register FOR EACH ROW EXECUTE FUNCTION shelfline.log_change('register');
