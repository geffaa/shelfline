import { INITIAL_CURSOR, SCHEMA_V, type Command } from "@shelfline/contracts";
import { AuthError, NetworkError, type LocalStore, type StatusResponse, type Transport } from "./types";

export interface EngineState { lastPushAt?: string; lastPullAt?: string; lastError?: string; seqDivergence?: boolean; serverStatus?: StatusResponse }
export interface PushOutcome { sent: number; accepted: number; flagged: number; rejected: number; duplicates: number; gap: boolean; halted: boolean }

/**
 * Push the outbox in device order, then pull the replica. Safe to call at any time and any number of times: a lost response just
 * means the same commands are sent again and the server answers `duplicate`. Network errors propagate to the caller (who schedules the retry).
 */
export class SyncEngine {
  state: EngineState = {};
  constructor(private store: LocalStore, private transport: Transport, private now: () => Date = () => new Date(), private batchSize = 50) {}

  /** Adopt the server's sequence if local storage was lost (the unsent commands are gone, but new ones must not be refused as reused). */
  async reconcileSequence(): Promise<void> {
    const st = await this.transport.status();
    this.state.serverStatus = st;
    const local = await this.store.nextSeq();
    const pending = await this.store.pendingCount();
    // Pairing an iPad declares it has nothing unsent, so adopting the server's number is expected then; any later wipe of local storage is flagged.
    const fresh = (await this.store.getMeta("freshPair")) === "1";
    if (st.expectedSeq > local && pending === 0) {
      await this.store.transact(async (tx) => { await tx.setNextSeq(st.expectedSeq); await tx.setMeta("recoveredSeqAt", this.now().toISOString()); await tx.setMeta("freshPair", ""); });
      this.state.seqDivergence = !fresh;
    } else if (fresh) await this.store.transact(async (tx) => { await tx.setMeta("freshPair", ""); });
  }

  async pushAll(): Promise<PushOutcome> {
    const out: PushOutcome = { sent: 0, accepted: 0, flagged: 0, rejected: 0, duplicates: 0, gap: false, halted: false };
    for (;;) {
      const batch: Command[] = await this.store.pendingCommands(this.batchSize);
      if (batch.length === 0) return out;
      const queued = Math.max(0, (await this.store.pendingCount()) - batch.length);
      const resp = await this.transport.push({ deviceNow: this.now().toISOString(), commands: batch, queued });
      out.sent += batch.length;
      const at = this.now().toISOString();
      await this.store.transact((tx) => tx.ack(resp.results, batch, at));
      for (const r of resp.results) {
        if (r.status === "accepted") out.accepted++; else if (r.status === "accepted_flagged") out.flagged++;
        else if (r.status === "rejected") out.rejected++; else if (r.status === "duplicate") out.duplicates++; else if (r.status === "gap") out.gap = true;
      }
      this.state.lastPushAt = at;
      if (resp.halted) { out.halted = true; return out; }
      if (out.gap) { this.state.seqDivergence = true; return out; } // we hold a command above a number the server never received: needs a person
      if (resp.results.length === 0) return out;
    }
  }

  /** First run downloads a snapshot (cursor taken before the data); afterwards only changes since the stored cursor. */
  async pullAll(): Promise<{ items: number }> {
    let total = 0;
    let cursor = await this.store.getMeta("cursor");
    if (!cursor) {
      let after = (await this.store.getMeta("snapshotNext")) ?? null;
      let snapCursor = await this.store.getMeta("snapshotCursor");
      for (;;) {
        const page = await this.transport.snapshot(after);
        const sc = snapCursor ?? page.cursor ?? INITIAL_CURSOR;
        await this.store.transact(async (tx) => {
          await tx.applyItems(page.items);
          await tx.setMeta("snapshotCursor", sc);
          if (page.next) await tx.setMeta("snapshotNext", page.next);
          else { await tx.setMeta("cursor", sc); }
        });
        total += page.items.length; snapCursor = sc; after = page.next;
        if (!page.next) break;
      }
      cursor = snapCursor;
    }
    for (;;) {
      const r = await this.transport.pull(cursor!);
      await this.store.transact(async (tx) => { await tx.applyItems(r.items); await tx.setMeta("cursor", r.cursor); });
      total += r.items.length; cursor = r.cursor;
      if (!r.hasMore) break;
    }
    this.state.lastPullAt = this.now().toISOString();
    return { items: total };
  }

  /** push then pull. Returns false (and records the error) on a network failure; auth errors are rethrown so the UI can ask for a PIN. */
  async syncOnce(): Promise<boolean> {
    try { await this.pushAll(); await this.pullAll(); this.state.lastError = undefined; return true; }
    catch (e) { if (e instanceof AuthError) throw e; this.state.lastError = e instanceof NetworkError ? "offline" : String(e); return false; }
  }
}
export const CURRENT_SCHEMA_V = SCHEMA_V;
