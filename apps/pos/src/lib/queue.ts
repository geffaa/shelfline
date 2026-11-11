import { SCHEMA_V, type Command } from "@shelfline/contracts";
import type { LocalStore } from "@shelfline/sync-client";
import type { LocalSale } from "./sales";

export interface QueueItem { id: string; seq: number; type: string; label: string; detail: string; amountMinor?: number; at: string }
const L: Record<string, string> = { "sale.create": "Sale", "refund.create": "Refund", "cash.move": "Cash entry", "session.open": "Open register", "session.close": "Close register", "customer.create": "New customer", "punch.record": "Clock punch", "stock.adjust": "Stock adjustment" };

/** A plain-language line for each waiting command, so a manager can see what is stuck without reading JSON. */
export function describe(c: Command): QueueItem {
  const p = (c.payload ?? {}) as Record<string, any>;
  const base = { id: c.id, seq: c.seq, type: c.type, label: L[c.type] ?? c.type, at: c.clientTs };
  switch (c.type) {
    case "sale.create": return { ...base, detail: `${p.receiptNo ?? ""} · ${(p.lines ?? []).reduce((a: number, l: { qty: number }) => a + l.qty, 0)} items`, amountMinor: p.totals?.payableMinor };
    case "refund.create": return { ...base, detail: `${(p.lines ?? []).length} line${(p.lines ?? []).length === 1 ? "" : "s"} · ${p.tender}`, amountMinor: p.totalMinor };
    case "cash.move": return { ...base, detail: `${String(p.kind).replace(/_/g, " ")}${p.reason ? ` · ${p.reason}` : ""}`, amountMinor: p.amountMinor || undefined };
    case "session.open": return { ...base, detail: "float counted", amountMinor: p.openingFloatMinor };
    case "session.close": return { ...base, detail: "count handed in", amountMinor: p.countedMinor };
    case "customer.create": return { ...base, detail: String(p.name ?? "") };
    case "punch.record": return { ...base, detail: `clock ${p.kind}` };
    default: return { ...base, detail: "" };
  }
}
export const queueItems = async (store: LocalStore, limit = 200) => (await store.pendingCommands(limit)).map(describe);

export interface QueueExport { format: "shelfline-queue"; version: 1; exportedAt: string; schemaV: number; server: string; commands: Command[]; sales: LocalSale[] }
/** Everything not yet acknowledged, as a file a technician can hand to `import-queue` if the iPad's storage is in doubt. */
export async function exportQueue(store: LocalStore, server: string, now = new Date()): Promise<QueueExport> {
  const commands = await store.pendingCommands(1_000_000); const ids = new Set(commands.filter((c) => c.type === "sale.create").map((c) => (c.payload as { saleId: string }).saleId));
  const sales = (await store.list<LocalSale>("sales")).map((x) => x.value).filter((s) => ids.has(s.id));
  return { format: "shelfline-queue", version: 1, exportedAt: now.toISOString(), schemaV: SCHEMA_V, server, commands, sales };
}
export function download(name: string, json: unknown) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(json, null, 2)], { type: "application/json" })); a.download = name; a.click(); URL.revokeObjectURL(a.href);
}
