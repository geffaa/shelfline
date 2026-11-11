import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { fileURLToPath } from "node:url";
import path from "node:path";

export async function runMigrations(url: string) {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle") });
  } finally { await pool.end(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = process.env.DATABASE_URL ?? "postgres://shelfline:shelfline@localhost:54340/shelfline";
  runMigrations(url).then(() => console.log("migrated")).catch((e) => { console.error(e); process.exit(1); });
}
