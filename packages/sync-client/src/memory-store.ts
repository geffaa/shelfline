import type { Command, CommandResult, ReplicaItem } from "@shelfline/contracts";
import { uuidv7 } from "./uuid";
import { effectiveStatus, type FlaggedRecord, type LocalStore, type RejectionRecord, type StoreTx } from "./types";

interface State { kv: Map<string, unknown>; outbox: Map<number, Command>; rejections: RejectionRecord[]; flagged: FlaggedRecord[] }
const clone = (s: State): State => ({ kv: new Map(s.kv), outbox: new Map(s.outbox), rejections: [...s.rejections], flagged: [...s.flagged] });
const k = (ns: string, key: string) => `${ns}\u0000${key}`;

/** In-memory adapter: tests and the simulator. Transactions are serialised and all-or-nothing (copy on write). */
export class MemoryStore implements LocalStore {
  private s: State = { kv: new Map(), outbox: new Map(), rejections: [], flagged: [] };
  private lock: Promise<unknown> = Promise.resolve();
  constructor(private now: () => number = Date.now) {}

  async transact<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    const run = async () => {
      const draft = clone(this.s);
      const tx: StoreTx = {
        enqueue: async (c) => {
          const seq = (draft.kv.get(k("meta", "nextSeq")) as number | undefined) ?? 1;
          const cmd: Command = { id: uuidv7(this.now()), seq, type: c.type, payload: c.payload, clientTs: c.clientTs ?? new Date(this.now()).toISOString(), schemaV: c.schemaV, actorId: c.actorId };
          draft.outbox.set(seq, cmd); draft.kv.set(k("meta", "nextSeq"), seq + 1);
          return cmd;
        },
        ack: async (results: CommandResult[], commands: Command[], at: string) => {
          const byId = new Map(commands.map((c) => [c.id, c]));
          for (const r of results) {
            if (r.status === "gap") continue;
            const c = byId.get(r.id); draft.outbox.delete(r.seq);
            if (!c) continue;
            if (effectiveStatus(r) === "rejected") draft.rejections.push({ id: r.id, seq: r.seq, type: c.type, reason: r.reason ?? "unknown", detail: r.result, at, payload: c.payload });
            if (effectiveStatus(r) === "accepted_flagged" && r.flags?.length) draft.flagged.push({ id: r.id, seq: r.seq, type: c.type, flags: r.flags, at });
          }
        },
        applyItems: async (items: ReplicaItem[]) => { for (const i of items) { const key = k(`replica:${i.type}`, i.id); if (i.op === "delete") draft.kv.delete(key); else draft.kv.set(key, i.data); } },
        setMeta: async (key, v) => { draft.kv.set(k("meta", key), v); },
        put: async (ns, key, v) => { draft.kv.set(k(ns, key), structuredClone(v)); },
        del: async (ns, key) => { draft.kv.delete(k(ns, key)); },
        setNextSeq: async (seq) => { draft.kv.set(k("meta", "nextSeq"), seq); },
        getMeta: async (key) => draft.kv.get(k("meta", key)) as string | undefined,
        get: async <T,>(ns: string, key: string) => { const v = draft.kv.get(k(ns, key)); return v === undefined ? undefined : (structuredClone(v) as T); },
      };
      const out = await fn(tx);
      this.s = draft; // commit
      return out;
    };
    const p = this.lock.then(run, run);
    this.lock = p.catch(() => undefined);
    return p;
  }
  async pendingCommands(limit: number) { return [...this.s.outbox.values()].sort((a, b) => a.seq - b.seq).slice(0, limit); }
  async pendingCount() { return this.s.outbox.size; }
  async nextSeq() { return (this.s.kv.get(k("meta", "nextSeq")) as number | undefined) ?? 1; }
  async getMeta(key: string) { return this.s.kv.get(k("meta", key)) as string | undefined; }
  async get<T>(ns: string, key: string) { const v = this.s.kv.get(k(ns, key)); return v === undefined ? undefined : (structuredClone(v) as T); }
  async list<T>(ns: string) { const p = `${ns}\u0000`; return [...this.s.kv.entries()].filter(([x]) => x.startsWith(p)).map(([x, value]) => ({ key: x.slice(p.length), value: structuredClone(value) as T })).sort((a, b) => (a.key < b.key ? -1 : 1)); }
  async rejections() { return [...this.s.rejections]; }
  async flagged() { return [...this.s.flagged]; }
  async close() {}
}
