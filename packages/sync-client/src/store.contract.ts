import { describe, expect, it } from "vitest";
import type { Command, CommandResult } from "@shelfline/contracts";
import type { LocalStore } from "./types";

/** The same behavioural suite runs against every LocalStore adapter (memory, IndexedDB; SQLite under Capacitor in P2). */
export function runStoreContract(name: string, make: () => Promise<LocalStore>) {
  const A = "11111111-1111-4111-8111-111111111111";
  const enq = (s: LocalStore, type = "t", payload: unknown = {}) => s.transact((tx) => tx.enqueue({ type, payload, actorId: A, schemaV: 1 }));
  const res = (c: Command, status: CommandResult["status"], extra: Partial<CommandResult> = {}): CommandResult => ({ id: c.id, seq: c.seq, status, ...extra });

  describe(`LocalStore contract: ${name}`, () => {
    it("assigns gapless sequence numbers from 1 and unique sortable ids", async () => {
      const s = await make();
      const cs = [await enq(s), await enq(s), await enq(s)];
      expect(cs.map((c) => c.seq)).toEqual([1, 2, 3]);
      expect(new Set(cs.map((c) => c.id)).size).toBe(3);
      expect(await s.nextSeq()).toBe(4);
      expect((await s.pendingCommands(10)).map((c) => c.seq)).toEqual([1, 2, 3]);
      expect((await s.pendingCommands(2)).map((c) => c.seq)).toEqual([1, 2]);
      await s.close();
    });
    it("a transaction is all-or-nothing: a throw after enqueue leaves no command and no sequence gap", async () => {
      const s = await make();
      await enq(s);
      await expect(s.transact(async (tx) => { await tx.enqueue({ type: "t", payload: {}, actorId: A, schemaV: 1 }); await tx.put("sales", "x", { total: 1 }); throw new Error("boom"); })).rejects.toThrow("boom");
      expect(await s.pendingCount()).toBe(1); expect(await s.nextSeq()).toBe(2); expect(await s.get("sales", "x")).toBeUndefined();
      expect((await enq(s)).seq).toBe(2);
      await s.close();
    });
    it("a business record and its command commit together", async () => {
      const s = await make();
      const c = await s.transact(async (tx) => { await tx.put("sales", "s1", { total: 36805 }); return tx.enqueue({ type: "sale.create", payload: { id: "s1" }, actorId: A, schemaV: 1 }); });
      expect(await s.get("sales", "s1")).toEqual({ total: 36805 }); expect((await s.pendingCommands(5))[0]!.id).toBe(c.id);
      await s.close();
    });
    it("ack removes accepted, duplicate and rejected commands, records rejections and flags, keeps gaps pending", async () => {
      const s = await make();
      const [c1, c2, c3, c4] = [await enq(s, "a"), await enq(s, "b"), await enq(s, "c"), await enq(s, "d")] as [Command, Command, Command, Command];
      await s.transact((tx) => tx.ack([res(c1, "accepted"), res(c2, "rejected", { reason: "forbidden", result: { permission: "x" } }), res(c3, "accepted_flagged", { flags: ["negative_stock"] }), res(c4, "gap")], [c1, c2, c3, c4], "2026-11-04T10:00:00Z"));
      expect((await s.pendingCommands(10)).map((c) => c.seq)).toEqual([4]);
      expect(await s.rejections()).toMatchObject([{ id: c2.id, reason: "forbidden", type: "b" }]);
      expect(await s.flagged()).toMatchObject([{ id: c3.id, flags: ["negative_stock"] }]);
      await s.close();
    });
    it("a duplicate answer carries the original outcome: a lost response must not make a rejection or a flag disappear", async () => {
      const s = await make();
      const [c1, c2, c3] = [await enq(s, "a"), await enq(s, "b"), await enq(s, "c")] as [Command, Command, Command];
      await s.transact((tx) => tx.ack([
        res(c1, "duplicate", { reason: "forbidden", detail: { original: "rejected" } }),
        res(c2, "duplicate", { flags: ["negative_stock"], detail: { original: "accepted_flagged" } }),
        res(c3, "duplicate", { detail: { original: "accepted" } })], [c1, c2, c3], "2026-11-04T10:00:00Z"));
      expect(await s.pendingCount()).toBe(0);
      expect(await s.rejections()).toMatchObject([{ id: c1.id, reason: "forbidden" }]);
      expect(await s.flagged()).toMatchObject([{ id: c2.id, flags: ["negative_stock"] }]);
      await s.close();
    });
    it("applies replica items (upsert, overwrite, delete) and lists them by type", async () => {
      const s = await make();
      await s.transact((tx) => tx.applyItems([{ type: "variant", id: "v1", op: "upsert", data: { sku: "A" } }, { type: "variant", id: "v2", op: "upsert", data: { sku: "B" } }]));
      await s.transact((tx) => tx.applyItems([{ type: "variant", id: "v1", op: "upsert", data: { sku: "A2" } }, { type: "variant", id: "v2", op: "delete" }]));
      expect(await s.list("replica:variant")).toEqual([{ key: "v1", value: { sku: "A2" } }]);
      expect(await s.list("replica:product")).toEqual([]);
      await s.close();
    });
    it("meta values and the next sequence can be set; setNextSeq moves forward the numbering", async () => {
      const s = await make();
      await s.transact(async (tx) => { await tx.setMeta("cursor", "12:34"); await tx.setNextSeq(40); });
      expect(await s.getMeta("cursor")).toBe("12:34"); expect(await s.getMeta("nothing")).toBeUndefined();
      expect((await enq(s)).seq).toBe(40);
      await s.close();
    });
    it("reads inside a transaction see its own writes (a counter read and bumped atomically never repeats a number)", async () => {
      const s = await make();
      const bump = () => s.transact(async (tx) => { const n = Number((await tx.getMeta("receipt")) ?? "0") + 1; await tx.setMeta("receipt", String(n)); await tx.put("sales", String(n), { n }); expect(await tx.get("sales", String(n))).toEqual({ n }); return n; });
      const ns = await Promise.all(Array.from({ length: 12 }, bump));
      expect(ns.sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
      await s.close();
    });
    it("concurrent enqueues never reuse a sequence number", async () => {
      const s = await make();
      const cs = await Promise.all(Array.from({ length: 25 }, () => enq(s)));
      expect(cs.map((c) => c.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
      await s.close();
    });
  });
}
