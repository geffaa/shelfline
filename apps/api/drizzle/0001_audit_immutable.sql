-- audit_log is append-only: no UPDATE, DELETE or TRUNCATE-by-row, even for the application role.
CREATE OR REPLACE FUNCTION shelfline.audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'shelfline.audit_log is append-only (% blocked)', TG_OP USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON shelfline.audit_log
  FOR EACH ROW EXECUTE FUNCTION shelfline.audit_log_immutable();
