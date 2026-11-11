import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Calendar, ChevronDown, ChevronLeft, ChevronRight, Minus, Plus, Search, Trash2 } from "lucide-react";
import { Button, Callout, DatePicker, Segmented, Select, Stepper } from "@shelfline/ui";
import { api, ApiError, qs } from "../lib/api";
import { centsText, money, parseMoney, plain } from "../lib/format";
import { href, navigate, useRoute } from "../router";
import { useAuth } from "../state/auth";
import { useBusinessToday, useLens, useLensLock } from "../state/lens";
import { Empty, ErrorBox, Field, PageHeader, Panel, Skeleton, TextInput } from "../ui";
import { billChip, optText, poChip, VariantPicker, type VariantHit } from "./buy";

interface Row { id: string; number: string; status: string; expectedOn: string | null; supplier: string; location: string; qtyOrdered: number; qtyReceived: number; valueMinor: number }
interface DraftLine { variantId: string; label: string; qty: number; cost: string }
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => ymd(new Date(Date.parse(s + "T00:00:00Z") + n * 86_400_000));

function NewOrder({ onDone }: { onDone: (id: string) => void }) {
  const qc = useQueryClient(); const { locations } = useLens(); const today = useBusinessToday();
  const sups = useQuery({ queryKey: ["suppliers", "", "active"], queryFn: () => api<{ id: string; name: string }[]>("/suppliers?status=active") });
  const [sup, setSup] = useState<string | null>(null); const [loc, setLoc] = useState<string | null>(null); const [due, setDue] = useState(addDays(today, 14)); const [lines, setLines] = useState<DraftLine[]>([]); const [err, setErr] = useState<string | null>(null);
  const places = locations.filter((l) => l.type === "store" || l.type === "warehouse");
  const valid = lines.length > 0 && lines.every((l) => l.qty > 0 && parseMoney(l.cost) !== null); const total = lines.reduce((a, l) => a + l.qty * (parseMoney(l.cost) ?? 0), 0);
  const add = (v: VariantHit) => setLines((ls) => ls.some((l) => l.variantId === v.id) ? ls : [...ls, { variantId: v.id, label: `${v.title} · ${optText(v.options)} · ${v.sku}`, qty: 1, cost: centsText(Math.round(v.basePriceMinor * 0.5)) }]);
  const save = useMutation({
    mutationFn: async (send: boolean) => { const po = await api<{ id: string }>("/purchase-orders", { method: "POST", body: { supplierId: sup, locationId: loc, expectedOn: due, lines: lines.map((l) => ({ variantId: l.variantId, qty: l.qty, unitCostMinor: parseMoney(l.cost)! })) } }); if (send) await api(`/purchase-orders/${po.id}/send`, { method: "POST" }); return po; },
    onSuccess: (po) => { void qc.invalidateQueries({ queryKey: ["pos"] }); onDone(po.id); }, onError: (e) => setErr(e instanceof ApiError ? `The order was refused (${e.code ?? e.status}).` : "Could not save the order."),
  });
  return (
    <Panel title="New purchase order">
      <form className="stack" onSubmit={(e) => { e.preventDefault(); setErr(null); save.mutate(false); }}>
        <div className="grid2">
          <Select label="Supplier" value={sup} onChange={setSup} options={(sups.data ?? []).map((s) => ({ value: s.id, label: s.name }))} placeholder="Choose a supplier" chevron={<ChevronDown size={16} />} />
          <Select label="Deliver to" value={loc} onChange={setLoc} options={places.map((l) => ({ value: l.id, label: l.name }))} placeholder="Choose a location" chevron={<ChevronDown size={16} />} />
          <DatePicker label="Expected on" value={due} onChange={setDue} today={today} min={today} icon={<Calendar size={16} />} prevIcon={<ChevronLeft size={16} />} nextIcon={<ChevronRight size={16} />} />
        </div>
        <VariantPicker onPick={add} />
        {lines.length === 0 ? <p className="muted" style={{ margin: 0 }}>Search for a product to add it. Costs start at half the shelf price; set the supplier's price.</p> : <div data-testid="po-lines">{lines.map((l, i) => (
          <div className="linebox" key={l.variantId}><span>{l.label}</span>
            <Stepper label={`Quantity of ${l.label}`} value={l.qty} min={1} max={100000} onChange={(n) => setLines((ls) => ls.map((x, j) => j === i ? { ...x, qty: n } : x))} decrementIcon={<Minus size={16} />} incrementIcon={<Plus size={16} />} />
            <label className="input" style={{ width: 120 }}><input aria-label={`Unit cost of ${l.label}`} inputMode="decimal" value={l.cost} onChange={(e) => setLines((ls) => ls.map((x, j) => j === i ? { ...x, cost: e.target.value } : x))} /></label>
            <button type="button" className="btn ghost sm" aria-label={`Remove ${l.label}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><Trash2 size={16} /></button></div>))}</div>}
        <div className="lead total"><span>Order value (ex freight)</span><i /><b>{money(total)}</b></div>
        {err && <p className="err" role="alert">{err}</p>}
        <div className="row-flex"><Button onClick={() => onDone("")}>Cancel</Button><span className="grow" /><Button type="submit" disabled={!sup || !loc || !valid || save.isPending}>Save draft</Button><Button variant="primary" disabled={!sup || !loc || !valid || save.isPending} onClick={() => { setErr(null); save.mutate(true); }}>Save and send</Button></div>
      </form>
    </Panel>
  );
}

function Receive({ po, onDone }: { po: any; onDone: () => void }) {
  const qc = useQueryClient(); const open = po.lines.filter((l: any) => l.qtyOrdered > l.qtyReceived);
  const [qty, setQty] = useState<Record<string, number>>(() => Object.fromEntries(open.map((l: any) => [l.id, l.qtyOrdered - l.qtyReceived]))); const [freight, setFreight] = useState(""); const [other, setOther] = useState(""); const [err, setErr] = useState<string | null>(null); const [done, setDone] = useState<any>(null);
  const [key] = useState(() => crypto.randomUUID());
  const f = freight.trim() === "" ? 0 : parseMoney(freight), o = other.trim() === "" ? 0 : parseMoney(other); const lines = open.filter((l: any) => (qty[l.id] ?? 0) > 0);
  const save = useMutation({
    mutationFn: () => api<any>(`/purchase-orders/${po.id}/receive`, { method: "POST", body: { idempotencyKey: key, lines: lines.map((l: any) => ({ poLineId: l.id, qty: qty[l.id] })), freightMinor: f, otherCostMinor: o } }),
    onSuccess: (r) => { setDone(r); void qc.invalidateQueries({ queryKey: ["po", po.id] }); void qc.invalidateQueries({ queryKey: ["pos"] }); void qc.invalidateQueries({ queryKey: ["inventory"] }); void qc.invalidateQueries({ queryKey: ["bills"] }); },
    onError: (e) => setErr(e instanceof ApiError && e.code === "over_receipt" ? "More than is still open on a line." : "Could not record the delivery."),
  });
  if (done) return <Callout tone="info"><span><b>{done.number} recorded.</b> Stock is up and the order is {done.status === "received" ? "fully received" : "part received"}.{done.landed?.some((x: any) => x.allocMinor > 0) && " Freight was added to the unit costs."}{done.billsReleased?.length > 0 && ` ${done.billsReleased.length} held bill${done.billsReleased.length === 1 ? " now matches and is released" : "s now match and are released"}.`} <Button size="sm" onClick={onDone}>Done</Button></span></Callout>;
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); setErr(null); save.mutate(); }} aria-label="Receive goods">
      <b>Receive goods</b>
      {open.map((l: any) => <div className="linebox" key={l.id} style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}><span>{l.title} <span className="muted">{optText(l.options)} · {l.qtyOrdered - l.qtyReceived} open</span></span>
        <Stepper label={`Received of ${l.sku}`} value={qty[l.id] ?? 0} min={0} max={l.qtyOrdered - l.qtyReceived} onChange={(n) => setQty((q) => ({ ...q, [l.id]: n }))} decrementIcon={<Minus size={16} />} incrementIcon={<Plus size={16} />} /></div>)}
      <div className="grid2"><Field id="rc-freight" label="Freight (A$)" hint="Spread over the lines by value"><TextInput id="rc-freight" inputMode="decimal" value={freight} onChange={setFreight} placeholder="0.00" /></Field><Field id="rc-other" label="Other costs (A$)" hint="Duty, handling"><TextInput id="rc-other" inputMode="decimal" value={other} onChange={setOther} placeholder="0.00" /></Field></div>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="row-flex"><Button onClick={onDone}>Cancel</Button><span className="grow" /><Button variant="primary" type="submit" disabled={lines.length === 0 || f === null || o === null || save.isPending}>Record delivery</Button></div>
    </form>
  );
}

function Detail({ id }: { id: string }) {
  const qc = useQueryClient(); const { can } = useAuth(); const [mode, setMode] = useState<"none" | "receive">("none"); const [err, setErr] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["po", id], queryFn: () => api<any>(`/purchase-orders/${id}`) });
  const act = useMutation({ mutationFn: (a: string) => api(`/purchase-orders/${id}/${a}`, { method: "POST" }), onSuccess: () => { setErr(null); void qc.invalidateQueries({ queryKey: ["po", id] }); void qc.invalidateQueries({ queryKey: ["pos"] }); }, onError: (e) => setErr(e instanceof ApiError && e.code === "po_has_receipts" ? "Goods have already arrived on this order, so it cannot be cancelled. Close it instead." : "That is not possible in the order's current state.") });
  if (q.isLoading) return <Panel><Skeleton rows={8} /></Panel>; if (q.isError) return <ErrorBox error={q.error} retry={() => q.refetch()} />; const po = q.data!;
  const w = can("purchase:write", null); const canReceive = can("inventory:write", po.locationId) && ["sent", "partial"].includes(po.status);
  const value = po.lines.reduce((a: number, l: any) => a + l.qtyOrdered * l.unitCostMinor, 0);
  return (
    <section className="panel detail" aria-label={`Purchase order ${po.number}`} data-testid="po-detail">
      <div className="drawer-head"><div><h2>{po.number}</h2><div className="muted" style={{ fontSize: 13 }}>{po.supplier} → {po.location}{po.expectedOn ? ` · expected ${po.expectedOn}` : ""}</div></div><span className="row-flex" style={{ gap: 6 }}>{poChip(po.status)}<button className="btn ghost sm" aria-label="Close details" onClick={() => navigate("stock", "purchase-orders")}>✕</button></span></div>
      <div className="pb stack">
        {mode === "receive" ? <Receive po={po} onDone={() => setMode("none")} /> : <div className="row-flex">
          {canReceive && <Button variant="primary" onClick={() => setMode("receive")}>Receive goods</Button>}
          {w && po.status === "draft" && <Button variant={canReceive ? "secondary" : "primary"} onClick={() => act.mutate("send")}>Send to supplier</Button>}
          {w && po.status === "partial" && <Button onClick={() => act.mutate("close")}>Close, no more coming</Button>}
          {w && ["draft", "sent", "partial"].includes(po.status) && <Button variant="ghost" onClick={() => act.mutate("cancel")}>Cancel order</Button>}</div>}
        {err && <p className="err" role="alert">{err}</p>}
        <div className="tbl-wrap"><table className="tbl" data-testid="po-line-table"><thead><tr><th>Item</th><th className="n">Ordered</th><th className="n">Received</th><th className="n">Open</th><th className="n">Cost</th></tr></thead>
          <tbody>{po.lines.map((l: any) => <tr key={l.id}><td><b>{l.title}</b><br /><span className="muted" style={{ fontSize: 12.5 }}>{optText(l.options)} · {l.sku}</span></td><td className="n">{l.qtyOrdered}</td><td className="n">{l.qtyReceived}</td><td className="n"><b>{l.qtyOrdered - l.qtyReceived}</b></td><td className="n">{plain(l.unitCostMinor)}</td></tr>)}</tbody></table></div>
        <div className="lead total"><span>Order value</span><i /><b>{money(value)}</b></div>
        {po.receipts.length > 0 && <div><b>Deliveries</b>{po.receipts.map((r: any) => <div className="lead" key={r.id}><span>{r.number} · {new Date(r.receivedAt).toLocaleDateString("en-AU", { day: "numeric", month: "short" })} · {r.lines.reduce((a: number, x: any) => a + x.qty, 0)} units</span><i /><b>{r.freightMinor + r.otherCostMinor > 0 ? `+${plain(r.freightMinor + r.otherCostMinor)} landed` : "no extra cost"}</b></div>)}</div>}
        {po.bills.length > 0 && <div><b>Bills</b>{po.bills.map((b: any) => <div className="lead" key={b.id}><span><a href={href("money", "bills", b.id)}>{b.number}</a> {billChip(b.status)}</span><i /><b>{plain(b.totalMinor)}</b></div>)}</div>}
        {po.note && <p className="muted" style={{ margin: 0 }}>{po.note}</p>}
      </div>
    </section>
  );
}

const VIEWS = [{ value: "all", label: "All" }, { value: "draft", label: "Drafts" }, { value: "open", label: "Open" }, { value: "received", label: "Received" }] as const;
export function PurchaseOrders() {
  useLensLock(true);
  const route = useRoute(); const { can } = useAuth(); const [q, setQ] = useState(""); const [view, setView] = useState<(typeof VIEWS)[number]["value"]>("open"); const [creating, setCreating] = useState(false); const sel = route.id;
  const list = useQuery({ queryKey: ["pos", q], queryFn: () => api<Row[]>(`/purchase-orders${qs({ q })}`) });
  const rows = useMemo(() => (list.data ?? []).filter((r) => view === "all" || (view === "open" ? ["sent", "partial"].includes(r.status) : r.status === view)), [list.data, view]);
  return (<>
    <PageHeader title="Purchase orders" sub="Ordered, part received, received. Stock goes up only when goods are received." actions={can("purchase:write", null) && <Button variant="primary" onClick={() => setCreating(true)}>New order</Button>} />
    <div className="filters"><label className="input" style={{ minWidth: 260 }}><Search size={16} /><input aria-label="Search orders" placeholder="PO number or supplier" value={q} onChange={(e) => setQ(e.target.value)} /></label><Segmented label="Show" value={view} onChange={setView} options={VIEWS.map((v) => ({ value: v.value, label: v.label }))} /></div>
    {creating && <NewOrder onDone={(id) => { setCreating(false); if (id) navigate("stock", "purchase-orders", id); }} />}
    <div className={`md${sel ? "" : " single"}`}>
      <Panel flush>{list.isLoading ? <Skeleton rows={6} /> : list.isError ? <ErrorBox error={list.error} retry={() => list.refetch()} /> : rows.length === 0 ? <Empty title="No orders here">{view === "open" ? "Nothing is waiting for delivery." : "Nothing matches."}</Empty> :
        <div className="tbl-wrap"><table className="tbl" data-testid="po-table"><thead><tr><th>Order</th><th>Supplier</th><th>Deliver to</th><th>Expected</th><th>Received</th><th className="n">Value</th><th>Status</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id} className="clickable" tabIndex={0} aria-selected={sel === r.id} onClick={() => navigate("stock", "purchase-orders", r.id)} onKeyDown={(e) => { if (e.key === "Enter") navigate("stock", "purchase-orders", r.id); }}>
            <td><b className="mono">{r.number}</b></td><td>{r.supplier}</td><td>{r.location}</td><td>{r.expectedOn ?? <span className="muted">—</span>}</td>
            <td><span className="progress" aria-hidden><i style={{ width: `${r.qtyOrdered ? Math.round((100 * r.qtyReceived) / r.qtyOrdered) : 0}%` }} /></span>{r.qtyReceived} / {r.qtyOrdered}</td><td className="n">{plain(r.valueMinor)}</td><td>{poChip(r.status)}</td></tr>)}</tbody></table></div>}
      </Panel>
      {sel && <Detail id={sel} />}
    </div>
  </>);
}
