import pg from "pg";
import { runMigrations } from "../src/db/migrate";

const ADMIN = "postgres://shelfline:shelfline@localhost:54340/postgres";
const TEST = "postgres://shelfline:shelfline@localhost:54340/shelfline_test";

export default async function setup() {
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  const { rowCount } = await admin.query("select 1 from pg_database where datname = 'shelfline_test'");
  if (!rowCount) await admin.query("create database shelfline_test");
  await admin.end();
  const c = new pg.Client({ connectionString: TEST });
  await c.connect();
  await c.query("drop schema if exists shelfline cascade; drop schema if exists drizzle cascade;");
  await c.end();
  await runMigrations(TEST);
}
