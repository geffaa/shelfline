-- Tell connected admin screens that something changed (payload carries ids only, never amounts or names).
CREATE OR REPLACE FUNCTION shelfline.notify_event() RETURNS trigger AS $$
DECLARE r jsonb := to_jsonb(NEW); loc uuid := NULL;
BEGIN
  IF TG_ARGV[0] = 'exception' THEN
    SELECT d.location_id INTO loc FROM shelfline.device d WHERE d.id = (r->>'device_id')::uuid;
  ELSE
    loc := (r->>'location_id')::uuid;
  END IF;
  PERFORM pg_notify('shelfline_events', json_build_object('org', r->>'org_id', 'loc', loc, 'kind', TG_ARGV[0], 'id', r->>'id')::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER sale_event AFTER INSERT ON shelfline.sale FOR EACH ROW EXECUTE FUNCTION shelfline.notify_event('sale');
--> statement-breakpoint
CREATE TRIGGER refund_event AFTER INSERT ON shelfline.refund FOR EACH ROW EXECUTE FUNCTION shelfline.notify_event('refund');
--> statement-breakpoint
CREATE TRIGGER cash_event AFTER INSERT ON shelfline.cash_movement FOR EACH ROW EXECUTE FUNCTION shelfline.notify_event('cash');
--> statement-breakpoint
CREATE TRIGGER session_event AFTER INSERT OR UPDATE ON shelfline.register_session FOR EACH ROW EXECUTE FUNCTION shelfline.notify_event('session');
--> statement-breakpoint
CREATE TRIGGER punch_event AFTER INSERT ON shelfline.punch FOR EACH ROW EXECUTE FUNCTION shelfline.notify_event('punch');
--> statement-breakpoint
CREATE TRIGGER exception_event AFTER INSERT OR UPDATE ON shelfline.sync_exception FOR EACH ROW EXECUTE FUNCTION shelfline.notify_event('exception');
