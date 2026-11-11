import { describe, expect, it } from "vitest";
import { MemoryStore } from "./memory-store";
import { SyncEngine } from "./engine";
import type { StatusResponse, Transport } from "./types";

const status = (expectedSeq: number): StatusResponse => ({ deviceId: "d", lastSeq: expectedSeq - 1, expectedSeq, clockSkewMs: 0, serverTime: new Date().toISOString(), schemaV: 1, minSchemaV: 1 });
const transport = (expectedSeq: number): Transport => ({ status: async () => status(expectedSeq), push: async () => { throw new Error("unused"); }, pull: async () => { throw new Error("unused"); }, snapshot: async () => { throw new Error("unused"); } });

describe("sequence recovery", () => {
  it("a newly paired iPad adopts the server's sequence without raising an alarm, once", async () => {
    const s = new MemoryStore(); await s.transact((tx) => tx.setMeta("freshPair", "1"));
    const e = new SyncEngine(s, transport(5031), () => new Date()); await e.reconcileSequence();
    expect(await s.nextSeq()).toBe(5031); expect(e.state.seqDivergence).toBe(false); expect(e.state.serverStatus?.expectedSeq).toBe(5031);
    await s.transact((tx) => tx.setMeta("recoveredSeqAt", "")); await new SyncEngine(s, transport(9000), () => new Date()).reconcileSequence();   // a later wipe is no longer excused
    const wiped = new MemoryStore(); const e2 = new SyncEngine(wiped, transport(9000), () => new Date()); await e2.reconcileSequence(); expect(e2.state.seqDivergence).toBe(true);
  });
  it("storage that was cleared after the first sync is flagged for a person", async () => {
    const s = new MemoryStore(); const e = new SyncEngine(s, transport(12), () => new Date()); await e.reconcileSequence();
    expect(await s.nextSeq()).toBe(12); expect(e.state.seqDivergence).toBe(true);
  });
  it("pairing a device that is in step with the server just clears the marker", async () => {
    const s = new MemoryStore(); await s.transact((tx) => tx.setMeta("freshPair", "1")); const e = new SyncEngine(s, transport(1), () => new Date()); await e.reconcileSequence();
    expect(e.state.seqDivergence).toBeFalsy(); expect(await s.getMeta("freshPair")).toBe("");
  });
});
