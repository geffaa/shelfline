import "fake-indexeddb/auto";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { DexieStore } from "./dexie-store";
import { MemoryStore } from "./memory-store";
import { runStoreContract } from "./store.contract";
import { SqliteStore, type SqlDb } from "./sqlite-store";
import { uuidv7 } from "./uuid";

runStoreContract("MemoryStore", async () => new MemoryStore());
let n = 0;
runStoreContract("DexieStore (IndexedDB)", async () => new DexieStore(`t${n++}`, Date.now, { indexedDB: new IDBFactory(), IDBKeyRange }));

/** Node's built-in SQLite, wrapped as the driver the adapter wants. It stands in for the Capacitor plugin: same SQL, same transactions. */
function nodeSqlite(): SqlDb {
  const db = new DatabaseSync(":memory:");
  return { exec: async (s) => { db.exec(s); }, run: async (s, p = []) => { db.prepare(s).run(...p); }, all: async <T,>(s: string, p: (string | number | null)[] = []) => db.prepare(s).all(...p) as T[],
    begin: async () => { db.exec("BEGIN IMMEDIATE"); }, commit: async () => { db.exec("COMMIT"); }, rollback: async () => { db.exec("ROLLBACK"); }, close: async () => { db.close(); } };
}
runStoreContract("SqliteStore (node:sqlite)", async () => new SqliteStore(nodeSqlite()));

describe("uuidv7", () => {
  it("is a valid v7 uuid and sorts by time", () => {
    const a = uuidv7(1_700_000_000_000), b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});
