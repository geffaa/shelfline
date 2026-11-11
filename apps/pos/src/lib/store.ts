import { Capacitor } from "@capacitor/core";
import { DexieStore, SqliteStore, capacitorSqlDb, type CapacitorSqliteConnection, type LocalStore } from "@shelfline/sync-client";

/**
 * Where the till keeps its data. In the browser (the PWA) it is IndexedDB. Inside the iPad app it is SQLite through the Capacitor plugin,
 * the same adapter contract, the same test suite. The native branch has not been run on a real iPad yet (docs/HARDWARE-TESTS.md, V06 and V19).
 */
export async function openLocalStore(name = "shelfline-pos"): Promise<LocalStore> {
  if (!Capacitor.isNativePlatform()) return new DexieStore(name);
  const { CapacitorSQLite, SQLiteConnection } = await import("@capacitor-community/sqlite");
  const conn = new SQLiteConnection(CapacitorSQLite);
  const existing = (await conn.checkConnectionsConsistency()).result && (await conn.isConnection(name, false)).result;
  const db = existing ? await conn.retrieveConnection(name, false) : await conn.createConnection(name, false, "no-encryption", 1, false);
  await db.open();
  return new SqliteStore(capacitorSqlDb(db as unknown as CapacitorSqliteConnection));
}
export const isNativeApp = () => Capacitor.isNativePlatform();
