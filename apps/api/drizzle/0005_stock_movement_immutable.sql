-- The ledger is append-only: stock changes by adding movements, never by editing or deleting them.
CREATE OR REPLACE FUNCTION shelfline.stock_movement_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'shelfline.stock_movement is append-only (% blocked)', TG_OP USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER stock_movement_no_update BEFORE UPDATE OR DELETE ON shelfline.stock_movement
  FOR EACH ROW EXECUTE FUNCTION shelfline.stock_movement_immutable();
