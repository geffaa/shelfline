import type { Command, CommandResult, ReplicaItem } from "@shelfline/contracts";
import { uuidv7 } from "./uuid";
import { effectiveStatus, type FlaggedRecord, type LocalStore, type RejectionRecord, type StoreTx } from "./types";

/**
 * The little a SQLite driver has to offer. Under Capacitor the driver is `@capacitor-community/sqlite` (see `capacitorSqlDb` below);
 * in tests it is Node's built-in `node:sqlite`. Statements use `?` placeholders; values are strings, numbers or null.
 */
export interface SqlDb {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: (string | number | null)[]): Promise<void>;
  all<T = Record<string, unknown>>(sql: string, params?: (string | number | null)[]): Promise<T[]>;
  begin(): Promise<void>; commit(): Promise<void>; rollback(): Promise<void>;
  close(): Promise<void>;
}
const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY NOT NULL, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY NOT NULL, id TEXT NOT NULL UNIQUE, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rejections (id TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS flagged (id TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL);`;
const SEP = "\u001f";   // not NUL: a driver that treats strings as C strings would cut the key there
const key = (ns: string, k: string) => `${ns}${SEP}${k}`;
const enc = (v: unknown) => JSON.stringify(v === undefined ? null : v);

/** SQLite adapter for the iPad app (P2). Same contract as the other stores (store.contract.ts). Transactions run one at a time and commit or roll back as a whole. */
export class SqliteStore implements LocalStore {
  private lock: Promise<unknown> = Promise.resolve(); private ready: Promise<void>;
  constructor(private db: SqlDb, private now: () => number = Date.now) { this.ready = db.exec(SCHEMA); }

  private async kvGet(db: SqlDb, k: string) { const r = await db.all<{ v: string }>("SELECT v FROM kv WHERE k = ?", [k]); return r.length ? (JSON.parse(r[0]!.v) as unknown) : undefined; }
  private async kvPut(db: SqlDb, k: string, v: unknown) { await db.run("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [k, enc(v)]); }

  transact<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    const run = async () => {
      await this.ready; const d = this.db; await d.begin();
      try {
        const tx: StoreTx = {
          enqueue: async (c) => {
            const seq = ((await this.kvGet(d, key("meta", "nextSeq"))) as number | undefined) ?? 1;
            const cmd: Command = { id: uuidv7(this.now()), seq, type: c.type, payload: c.payload, clientTs: c.clientTs ?? new Date(this.now()).toISOString(), schemaV: c.schemaV, actorId: c.actorId };
            await d.run("INSERT INTO outbox (seq, id, json) VALUES (?, ?, ?)", [seq, cmd.id, enc(cmd)]); await this.kvPut(d, key("meta", "nextSeq"), seq + 1);
            return cmd;
          },
          ack: async (results: CommandResult[], commands: Command[], at: string) => {
            const byId = new Map(commands.map((c) => [c.id, c]));
            for (const r of results) {
              if (r.status === "gap") continue;
              await d.run("DELETE FROM outbox WHERE seq = ?", [r.seq]); const c = byId.get(r.id); if (!c) continue;
              if (effectiveStatus(r) === "rejected") await d.run("INSERT OR REPLACE INTO rejections (id, json) VALUES (?, ?)", [r.id, enc({ id: r.id, seq: r.seq, type: c.type, reason: r.reason ?? "unknown", detail: r.result, at, payload: c.payload } satisfies RejectionRecord)]);
              if (effectiveStatus(r) === "accepted_flagged" && r.flags?.length) await d.run("INSERT OR REPLACE INTO flagged (id, json) VALUES (?, ?)", [r.id, enc({ id: r.id, seq: r.seq, type: c.type, flags: r.flags, at } satisfies FlaggedRecord)]);
            }
          },
          applyItems: async (items: ReplicaItem[]) => { for (const i of items) { const kk = key(`replica:${i.type}`, i.id); if (i.op === "delete") await d.run("DELETE FROM kv WHERE k = ?", [kk]); else await this.kvPut(d, kk, i.data); } },
          setMeta: async (k, v) => { await this.kvPut(d, key("meta", k), v); },
          put: async (ns, k, v) => { await this.kvPut(d, key(ns, k), v); },
          del: async (ns, k) => { await d.run("DELETE FROM kv WHERE k = ?", [key(ns, k)]); },
          setNextSeq: async (seq) => { await this.kvPut(d, key("meta", "nextSeq"), seq); },
          getMeta: async (k) => (await this.kvGet(d, key("meta", k))) as string | undefined,
          get: async <U,>(ns: string, k: string) => (await this.kvGet(d, key(ns, k))) as U | undefined,
        };
        const out = await fn(tx); await d.commit(); return out;
      } catch (e) { await d.rollback().catch(() => undefined); throw e; }
    };
    const p = this.lock.then(run, run); this.lock = p.catch(() => undefined); return p;
  }
  async pendingCommands(limit: number) { await this.ready; return (await this.db.all<{ json: string }>("SELECT json FROM outbox ORDER BY seq LIMIT ?", [limit])).map((r) => JSON.parse(r.json) as Command); }
  async pendingCount() { await this.ready; return Number((await this.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM outbox"))[0]!.n); }
  async nextSeq() { await this.ready; return ((await this.kvGet(this.db, key("meta", "nextSeq"))) as number | undefined) ?? 1; }
  async getMeta(k: string) { await this.ready; return (await this.kvGet(this.db, key("meta", k))) as string | undefined; }
  async get<T>(ns: string, k: string) { await this.ready; return (await this.kvGet(this.db, key(ns, k))) as T | undefined; }
  async list<T>(ns: string) { await this.ready; const p = `${ns}${SEP}`; return (await this.db.all<{ k: string; v: string }>("SELECT k, v FROM kv WHERE substr(k, 1, ?) = ? ORDER BY k", [p.length, p])).map((r) => ({ key: r.k.slice(p.length), value: JSON.parse(r.v) as T })); }
  async rejections() { await this.ready; return (await this.db.all<{ json: string }>("SELECT json FROM rejections")).map((r) => JSON.parse(r.json) as RejectionRecord); }
  async flagged() { await this.ready; return (await this.db.all<{ json: string }>("SELECT json FROM flagged")).map((r) => JSON.parse(r.json) as FlaggedRecord); }
  async close() { await this.ready; await this.db.close(); }
}

/** The shape of the Capacitor SQLite connection we use (`SQLiteDBConnection` from @capacitor-community/sqlite). Not run on a device yet: see docs/HARDWARE-TESTS.md. */
export interface CapacitorSqliteConnection {
  execute(statements: string, transaction?: boolean): Promise<unknown>;
  run(statement: string, values?: unknown[], transaction?: boolean): Promise<unknown>;
  query(statement: string, values?: unknown[]): Promise<{ values?: Record<string, unknown>[] }>;
  beginTransaction(): Promise<unknown>; commitTransaction(): Promise<unknown>; rollbackTransaction(): Promise<unknown>;
  close(): Promise<unknown>;
}
export function capacitorSqlDb(c: CapacitorSqliteConnection): SqlDb {
  return {
    exec: async (sql) => { await c.execute(sql, false); },
    run: async (sql, params) => { await c.run(sql, params ?? [], false); },
    all: async <T,>(sql: string, params?: (string | number | null)[]) => ((await c.query(sql, params ?? [])).values ?? []) as T[],
    begin: async () => { await c.beginTransaction(); }, commit: async () => { await c.commitTransaction(); }, rollback: async () => { await c.rollbackTransaction(); },
    close: async () => { await c.close(); },
  };
}
