import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Minus, Plus, Search, X } from "lucide-react";
import { Button, Chip, Segmented, Select, Stepper } from "@shelfline/ui";
import { api, ApiError, qs } from "../lib/api";
import { dateTime, flagLabel, money } from "../lib/format";
import { useAuth } from "../state/auth";
import { useLens } from "../state/lens";
import { Empty, ErrorBox, Field, PageHeader, Panel, Skeleton, TextInput } from "../ui";

interface Row { variantId: string; locationId: string; onHand: number; avgCostMinor?: number; sku: string; title: string; options: Record<string, string> }
const KIND: Record<string, string> = { sale: "Sale", refund_return: "Refund returned", receive_po: "Received (PO)", manual_receive: "Received", transfer_out: "Transfer out", transfer_in: "Transfer in", transfer_variance: "Transfer variance", count_adjust: "Count adjustment", manual_adjust: "Adjustment", write_off: "Write-off", opening_balance: "Opening balance", online_reserve: "Online reserve", online_release: "Online release" };
const REASONS = [{ value: "counting_error", label: "Counting error" }, { value: "damaged", label: "Damaged in store" }, { value: "theft_or_shrinkage", label: "Theft or shrinkage" }, { value: "supplier_short_shipment", label: "Supplier short-shipment" }, { value: "found", label: "Found" }, { value: "other", label: "Other" }];
const cents = (s: string): number | null => { const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(s.trim()); return m ? Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0") : null; };

function StockCard({ row, locName, canWrite, onClose }: { row: Row; locName: string; canWrite: boolean; onClose: () => void }) {
  const qc = useQueryClient(); const q = useQuery({ queryKey: ["ledger", row.variantId, row.locationId], queryFn: () => api<any>(`/inventory/${row.variantId}/ledger?locationId=${row.locationId}`) });
  const [mode, setMode] = useState<"none" | "adjust" | "receive">("none"); const [delta, setDelta] = useState(-1); const [reason, setReason] = useState<string | null>(null); const [note, setNote] = useState(""); const [qty, setQty] = useState(1); const [cost, setCost] = useState(""); const [err, setErr] = useState<string | null>(null);
  const done = () => { setMode("none"); setErr(null); void qc.invalidateQueries({ queryKey: ["ledger"] }); void qc.invalidateQueries({ queryKey: ["inventory"] }); };
  const fail = (e: unknown) => setErr(e instanceof ApiError && e.code === "insufficient_stock" ? `Only ${e.body.onHand} on hand: an adjustment cannot take stock below zero.` : "Could not save the change.");
  const adjust = useMutation({ mutationFn: () => api("/inventory/adjust", { method: "POST", body: { locationId: row.locationId, variantId: row.variantId, qtyDelta: delta, reason, note: note || undefined, idempotencyKey: crypto.randomUUID() } }), onSuccess: done, onError: fail });
  const receive = useMutation({ mutationFn: () => api("/inventory/receive", { method: "POST", body: { locationId: row.locationId, idempotencyKey: crypto.randomUUID(), lines: [{ variantId: row.variantId, qty, unitCostMinor: cents(cost) ?? 0 }] } }), onSuccess: done, onError: fail });
  const d = q.data;
  return (
    <section className="panel detail" aria-label="Stock card">
      <div className="drawer-head"><div><h2>Stock card</h2><div className="muted" style={{ fontSize: 13 }}>{row.title} · {Object.values(row.options).join(" · ")} at {locName}</div></div><button className="btn ghost sm" aria-label="Close stock card" onClick={onClose}><X size={16} /></button></div>
      <div className="pb stack">
        <div className="lead total" style={{ borderTop: 0, marginTop: 0, paddingTop: 0 }}><span>On hand</span><i /><b data-testid="on-hand" className={row.onHand < 0 ? "neg" : ""}>{d ? d.onHand : row.onHand}</b></div>
        {canWrite && mode === "none" && <div className="row-flex"><Button variant="primary" onClick={() => { setMode("adjust"); setReason(null); setDelta(-1); }}>Adjust stock at {locName}</Button><Button onClick={() => setMode("receive")}>Receive stock</Button></div>}
        {mode === "adjust" && <form className="stack" onSubmit={(e) => { e.preventDefault(); setErr(null); adjust.mutate(); }}><b>Adjust at {locName}</b>
          <div className="row-flex"><Stepper label="Change in stock" value={delta} min={-9999} max={9999} onChange={setDelta} decrementIcon={<Minus size={16} />} incrementIcon={<Plus size={16} />} /><span className="muted">{delta > 0 ? `adds ${delta}` : delta < 0 ? `removes ${-delta}` : "no change"}</span></div>
          <Select label="Reason" value={reason} onChange={setReason} options={REASONS} placeholder="Reason (required)" chevron={<ChevronDown size={16} />} />
          <Field id="adjnote" label="Note"><TextInput id="adjnote" value={note} onChange={setNote} /></Field>
          {err && <p className="err" role="alert">{err}</p>}<div className="row-flex"><Button onClick={() => setMode("none")}>Cancel</Button><span className="grow" /><Button variant="primary" type="submit" disabled={!reason || delta === 0 || adjust.isPending}>Save adjustment</Button></div></form>}
        {mode === "receive" && <form className="stack" onSubmit={(e) => { e.preventDefault(); setErr(null); receive.mutate(); }}><b>Receive at {locName}</b>
          <div className="row-flex"><Stepper label="Quantity received" value={qty} min={1} max={100000} onChange={setQty} decrementIcon={<Minus size={16} />} incrementIcon={<Plus size={16} />} /><div className="input" style={{ width: 150 }}><input aria-label="Cost per unit" placeholder="Cost each, e.g. 118.40" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} /></div></div>
          {err && <p className="err" role="alert">{err}</p>}<div className="row-flex"><Button onClick={() => setMode("none")}>Cancel</Button><span className="grow" /><Button variant="primary" type="submit" disabled={receive.isPending || cents(cost) === null}>Receive</Button></div></form>}
        {q.isLoading ? <Skeleton rows={5} /> : q.isError ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : d.movements.length === 0 ? <Empty title="No movements yet">Every change to this item's stock will be listed here, newest first.</Empty> :
          <div className="tbl-wrap"><table className="tbl" data-testid="stock-card"><thead><tr><th>When</th><th>Event</th><th className="n">Δ</th><th className="n">Balance</th></tr></thead><tbody>{d.movements.map((m: any) => (
            <tr key={m.id}><td className="mono" style={{ fontSize: 12.5 }}>{dateTime(m.at)}</td><td><Chip tone={m.kind === "count_adjust" || m.kind === "manual_adjust" ? "warn" : m.qtyDelta > 0 ? "info" : undefined}>{KIND[m.kind] ?? m.kind}</Chip> {m.flags.map((f: string) => <Chip key={f} tone="danger">{flagLabel(f)}</Chip>)}<div className="muted" style={{ fontSize: 12.5, whiteSpace: "normal" }}>{[m.reason?.replace(/_/g, " "), m.note, m.unitCostMinor ? `cost ${money(m.unitCostMinor)}` : ""].filter(Boolean).join(" · ")}</div></td>
              <td className="n" style={{ color: m.qtyDelta > 0 ? "var(--ok)" : "var(--danger)", fontWeight: 700 }}>{m.qtyDelta > 0 ? `+${m.qtyDelta}` : `−${-m.qtyDelta}`}</td><td className={`n${m.balance < 0 ? " neg" : ""}`}><b>{m.balance < 0 ? `−${-m.balance}` : m.balance}</b></td></tr>))}</tbody></table></div>}
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>The ledger only grows: nothing here can be edited or deleted. The balance is the sum of the movements.</p>
      </div>
    </section>
  );
}

export function Inventory() {
  const { lens, locations, selected } = useLens(); const { can, canAny } = useAuth(); const [q, setQ] = useState(""); const [view, setView] = useState<"all" | "low">("all"); const [sel, setSel] = useState<{ v: string; l: string } | null>(null);
  const list = useQuery({ queryKey: ["inventory", q], queryFn: () => api<Row[]>(`/inventory${qs({ q })}`) });
  const cols = useMemo(() => (lens === "all" ? locations : locations.filter((l) => l.id === lens)), [lens, locations]);
  const grouped = useMemo(() => { const m = new Map<string, { head: Row; by: Map<string, Row> }>(); for (const r of list.data ?? []) { const g = m.get(r.variantId) ?? { head: r, by: new Map() }; g.by.set(r.locationId, r); m.set(r.variantId, g); } return [...m.values()].sort((a, b) => a.head.title.localeCompare(b.head.title) || a.head.sku.localeCompare(b.head.sku)); }, [list.data]);
  const visible = grouped.filter((g) => view === "all" || cols.some((c) => (g.by.get(c.id)?.onHand ?? 0) <= 2));
  const selRow = sel ? grouped.find((g) => g.head.variantId === sel.v)?.by.get(sel.l) : undefined; const locName = (id: string) => locations.find((l) => l.id === id)?.name ?? "";
  return (<>
    <PageHeader title="Inventory" sub={<>{lens === "all" ? "Every location" : selected?.name} · stock is the sum of its ledger</>} />
    <div className="filters"><label className="input" style={{ minWidth: 280 }}><Search size={16} /><input aria-label="Search inventory" placeholder="Title, SKU or barcode" value={q} onChange={(e) => setQ(e.target.value)} /></label><Segmented label="Show" value={view} onChange={setView} options={[{ value: "all", label: "All items" }, { value: "low", label: "Low or out" }]} /></div>
    <div className={`md${selRow ? "" : " single"}`}>
      <Panel flush>{list.isLoading ? <Skeleton rows={6} /> : list.isError ? <ErrorBox error={list.error} retry={() => list.refetch()} /> : visible.length === 0 ? <Empty title={view === "low" ? "Nothing is low" : "No stock recorded"}>{view === "low" ? "Items with 2 or fewer on hand in the chosen locations appear here." : "Receive stock into a location to start its ledger."}</Empty> :
        <div className="tbl-wrap"><table className="tbl" data-testid="stock-matrix"><thead><tr><th>Variant</th>{cols.map((c) => <th className="n" key={c.id}>{c.name}</th>)}{cols.length > 1 && <th className="n">On hand</th>}</tr></thead>
          <tbody>{visible.map((g) => { const total = cols.reduce((a, c) => a + (g.by.get(c.id)?.onHand ?? 0), 0); return <tr key={g.head.variantId}>
            <td><b>{g.head.title}</b><br /><span className="muted">{Object.values(g.head.options).join(" · ")} · <span className="mono">{g.head.sku}</span></span></td>
            {cols.map((c) => { const r = g.by.get(c.id); const n = r?.onHand; return <td className="n" key={c.id}>{r ? <button type="button" aria-label={`${g.head.sku} at ${c.name}: ${n} on hand. Open stock card`} className={n! < 0 ? "neg" : ""} style={{ font: "inherit", padding: "4px 8px", borderRadius: 6, outline: sel?.v === g.head.variantId && sel.l === c.id ? "2px solid var(--ink)" : n! < 0 ? "2px solid var(--danger)" : undefined, outlineOffset: 1 }} onClick={() => setSel({ v: g.head.variantId, l: c.id })}>{n! < 0 ? `−${-n!}` : n}</button> : <span className="muted">0</span>}</td>; })}
            {cols.length > 1 && <td className="n"><b>{total}</b></td>}</tr>; })}</tbody></table></div>}</Panel>
      {selRow && sel && <StockCard key={`${sel.v}${sel.l}`} row={selRow} locName={locName(sel.l)} canWrite={can("inventory:write", sel.l)} onClose={() => setSel(null)} />}
    </div>
    <span hidden>{String(canAny("inventory:write"))}</span>
  </>);
}
