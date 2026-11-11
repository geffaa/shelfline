import Dexie, { type Table } from "dexie";
import type { Command, CommandResult, ReplicaItem } from "@shelfline/contracts";
import { uuidv7 } from "./uuid";
import { effectiveStatus, type FlaggedRecord, type LocalStore, type RejectionRecord, type StoreTx } from "./types";

interface Kv { k: string; v: unknown }
class PosDb extends Dexie {
  kv!: Table<Kv, string>; outbox!: Table<Command, number>; rejections!: Table<RejectionRecord, string>; flagged!: Table<FlaggedRecord, string>;
  constructor(name: string, idb?: { indexedDB: IDBFactory; IDBKeyRange: typeof IDBKeyRange }) {
    super(name, idb);
    this.version(1).stores({ kv: "k", outbox: "seq, id", rejections: "id", flagged: "id" });
  }
}
const key = (ns: string, k: string) => `${ns}\u0000${k}`;

/** IndexedDB adapter for the PWA. Same contract as MemoryStore (see store.contract.ts). Dexie transactions are all-or-nothing. */
export class DexieStore implements LocalStore {
  private db: PosDb;
  constructor(name = "shelfline-pos", private now: () => number = Date.now, idb?: { indexedDB: IDBFactory; IDBKeyRange: typeof IDBKeyRange }) { this.db = new PosDb(name, idb); }

  transact<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    const d = this.db;
    return d.transaction("rw", [d.kv, d.outbox, d.rejections, d.flagged], async () => {
      const tx: StoreTx = {
        enqueue: async (c) => {
          const seq = ((await d.kv.get(key("meta", "nextSeq")))?.v as number | undefined) ?? 1;
          const cmd: Command = { id: uuidv7(this.now()), seq, type: c.type, payload: c.payload, clientTs: c.clientTs ?? new Date(this.now()).toISOString(), schemaV: c.schemaV, actorId: c.actorId };
          await d.outbox.put(cmd); await d.kv.put({ k: key("meta", "nextSeq"), v: seq + 1 });
          return cmd;
        },
        ack: async (results: CommandResult[], commands: Command[], at: string) => {
          const byId = new Map(commands.map((c) => [c.id, c]));
          for (const r of results) {
            if (r.status === "gap") continue;
            await d.outbox.delete(r.seq);
            const c = byId.get(r.id); if (!c) continue;
            if (effectiveStatus(r) === "rejected") await d.rejections.put({ id: r.id, seq: r.seq, type: c.type, reason: r.reason ?? "unknown", detail: r.result, at, payload: c.payload });
            if (effectiveStatus(r) === "accepted_flagged" && r.flags?.length) await d.flagged.put({ id: r.id, seq: r.seq, type: c.type, flags: r.flags, at });
          }
        },
        applyItems: async (items: ReplicaItem[]) => { for (const i of items) { const kk = key(`replica:${i.type}`, i.id); if (i.op === "delete") await d.kv.delete(kk); else await d.kv.put({ k: kk, v: i.data }); } },
        setMeta: async (k, v) => { await d.kv.put({ k: key("meta", k), v }); },
        put: async (ns, k, v) => { await d.kv.put({ k: key(ns, k), v }); },
        del: async (ns, k) => { await d.kv.delete(key(ns, k)); },
        setNextSeq: async (seq) => { await d.kv.put({ k: key("meta", "nextSeq"), v: seq }); },
        getMeta: async (k) => (await d.kv.get(key("meta", k)))?.v as string | undefined,
        get: async <T,>(ns: string, k: string) => (await d.kv.get(key(ns, k)))?.v as T | undefined,
      };
      return fn(tx);
    });
  }
  pendingCommands(limit: number) { return this.db.outbox.orderBy("seq").limit(limit).toArray(); }
  pendingCount() { return this.db.outbox.count(); }
  async nextSeq() { return ((await this.db.kv.get(key("meta", "nextSeq")))?.v as number | undefined) ?? 1; }
  async getMeta(k: string) { return (await this.db.kv.get(key("meta", k)))?.v as string | undefined; }
  async get<T>(ns: string, k: string) { return (await this.db.kv.get(key(ns, k)))?.v as T | undefined; }
  async list<T>(ns: string) { const p = `${ns}\u0000`; return (await this.db.kv.where("k").startsWith(p).toArray()).map((r) => ({ key: r.k.slice(p.length), value: r.v as T })).sort((a, b) => (a.key < b.key ? -1 : 1)); }
  rejections() { return this.db.rejections.toArray(); }
  flagged() { return this.db.flagged.toArray(); }
  async close() { this.db.close(); }
  async destroy() { await Dexie.delete(this.db.name); }
}
