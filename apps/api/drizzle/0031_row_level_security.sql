-- M24: the database itself refuses to show one organisation another's rows.
-- The application connects as `shelfline_app`, which is not a superuser and does not bypass row-level security. Each request
-- (and each transaction inside it) tells Postgres which organisation it acts for with `app.org_id`; background work and the
-- unauthenticated entry points (sign-in, webhooks, the public shop) run in `app.system` mode, which is set by the application, not by the caller.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shelfline_app') THEN
    CREATE ROLE shelfline_app LOGIN PASSWORD 'shelfline_app' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION shelfline.org_visible(o uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.system', true) = 'on' OR o = nullif(current_setting('app.org_id', true), '')::uuid
$$;--> statement-breakpoint
GRANT USAGE ON SCHEMA shelfline TO shelfline_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA shelfline TO shelfline_app;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA shelfline TO shelfline_app;--> statement-breakpoint
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA shelfline TO shelfline_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA shelfline GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO shelfline_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA shelfline GRANT USAGE, SELECT ON SEQUENCES TO shelfline_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA shelfline GRANT EXECUTE ON FUNCTIONS TO shelfline_app;--> statement-breakpoint
DO $$ DECLARE t record; BEGIN
  FOR t IN SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables x ON x.table_schema = c.table_schema AND x.table_name = c.table_name AND x.table_type = 'BASE TABLE' WHERE c.table_schema = 'shelfline' AND c.column_name = 'org_id' LOOP
    EXECUTE format('ALTER TABLE shelfline.%I ENABLE ROW LEVEL SECURITY', t.table_name);
    EXECUTE format('CREATE POLICY org_isolation ON shelfline.%I USING (shelfline.org_visible(org_id)) WITH CHECK (shelfline.org_visible(org_id))', t.table_name);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE shelfline.org ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON shelfline.org USING (shelfline.org_visible(id)) WITH CHECK (shelfline.org_visible(id));
