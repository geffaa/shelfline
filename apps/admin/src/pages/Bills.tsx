import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Calendar, ChevronDown, ChevronLeft, ChevronRight, Minus, Plus, Search } from "lucide-react";
import { Button, Callout, Chip, DatePicker, Segmented, Select, Stepper } from "@shelfline/ui";
import { api, ApiError, qs } from "../lib/api";
import { centsText, money, parseMoney, plain } from "../lib/format";
import { href, navigate, useRoute } from "../router";
import { useAuth } from "../state/auth";
import { useBusinessToday, useLensLock } from "../state/lens";
import { Empty, ErrorBox, Field, PageHeader, Panel, Skeleton, TextInput } from "../ui";
import { billChip, HOLD_TEXT, METHODS, optText } from "./buy";

interface Row { id: string; number: string; status: string; billDate: string; dueOn: string; totalMinor: number; paidMinor: number; holdReasons: string[]; poNumber: string | null; supplier: string; overdue: boolean }
const BUCKETS = [["current", "Not due"], ["d1_30", "1–30"], ["d31_60", "31–60"], ["d61_90", "61–90"], ["d90plus", "90+"]] as const;
const addDays = (s: string, n: number) => new Date(Date.parse(s + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);

function Aging({ today }: { today: string }) {
  const q = useQuery({ queryKey: ["bills", "aging", today], queryFn: () => api<any>(`/bills/aging${qs({ asOf: today })}`) });
  if (q.isLoading) return <Panel title="Owed to suppliers"><Skeleton rows={3} /></Panel>; if (q.isError) return <ErrorBox error={q.error} retry={() => q.refetch()} />; const a = q.data!;
  return (
    <Panel title="Owed to suppliers" right={<span className="muted">days past due · as of {a.asOf}</span>} flush>
      {a.rows.length === 0 ? <Empty title="Nothing owed">Bills that are not fully paid appear here by how late they are.</Empty> :
        <div className="tbl-wrap"><table className="tbl" data-testid="aging-table"><thead><tr><th>Supplier</th>{BUCKETS.map(([, l]) => <th className="n" key={l}>{l}</th>)}<th className="n">Total</th><th className="n">On hold</th></tr></thead>
          <tbody>{a.rows.map((r: any) => <tr key={r.supplierId}><td><b>{r.supplier}</b></td>{BUCKETS.map(([k]) => <td className={`n${r[k] && (k === "d61_90" || k === "d90plus") ? " neg" : ""}`} key={k}>{r[k] ? plain(r[k]) : "—"}</td>)}<td className="n"><b>{plain(r.total)}</b></td><td className="n">{r.held ? plain(r.held) : "—"}</td></tr>)}
            <tr><td><b>All suppliers</b></td>{BUCKETS.map(([k]) => <td className="n" key={k}><b>{a.totals[k] ? plain(a.totals[k]) : "—"}</b></td>)}<td className="n"><b>{plain(a.totals.total)}</b></td><td className="n"><b>{a.totals.held ? plain(a.totals.held) : "—"}</b></td></tr></tbody></table></div>}
    </Panel>
  );
}

interface BillLine { key: string; poLineId?: string; variantId?: string; label: string; qty: number; cost: string; ordered?: number; received?: number }
function NewBill({ today, onDone }: { today: string; onDone: (id: string) => void }) {
  const qc = useQueryClient(); const sups = useQuery({ queryKey: ["suppliers", "", "active"], queryFn: () => api<any[]>("/suppliers?status=active") });
  const [sup, setSup] = useState<string | null>(null); const [poId, setPoId] = useState<string | null>(null); const [num, setNum] = useState(""); const [date, setDate] = useState(today); const [lines, setLines] = useState<BillLine[]>([]); const [extraLabel, setExtraLabel] = useState("Freight"); const [extra, setExtra] = useState(""); const [err, setErr] = useState<string | null>(null);
  const pos = useQuery({ queryKey: ["pos-for-bill", sup], enabled: !!sup, queryFn: () => api<any[]>(`/purchase-orders${qs({ supplierId: sup })}`) });
  const pick = async (id: string) => { setPoId(id); const po = await api<any>(`/purchase-orders/${id}`); setLines(po.lines.map((l: any) => ({ key: l.id, poLineId: l.id, variantId: l.variantId, label: `${l.title} · ${optText(l.options)} · ${l.sku}`, qty: Math.max(1, l.qtyReceived), cost: centsText(l.unitCostMinor), ordered: l.qtyOrdered, received: l.qtyReceived }))); };
  const ex = extra.trim() === "" ? 0 : parseMoney(extra); const total = lines.reduce((a, l) => a + l.qty * (parseMoney(l.cost) ?? 0), 0) + (ex ?? 0);
  const save = useMutation({
    mutationFn: () => api<any>("/bills", { method: "POST", body: { supplierId: sup, poId, number: num.trim(), billDate: date, lines: [...lines.map((l) => ({ poLineId: l.poLineId, variantId: l.variantId, description: l.label, qty: l.qty, unitCostMinor: parseMoney(l.cost)! })), ...(ex ? [{ description: extraLabel.trim() || "Other", qty: 1, unitCostMinor: ex }] : [])] } }),
    onSuccess: (b) => { void qc.invalidateQueries({ queryKey: ["bills"] }); void qc.invalidateQueries({ queryKey: ["po"] }); onDone(b.id); },
    onError: (e) => setErr(e instanceof ApiError && e.code === "bill_number_taken" ? "This supplier already has a bill with that number." : "Could not save the bill. Check the amounts."),
  });
  const ok = !!sup && num.trim() !== "" && total > 0 && ex !== null && lines.every((l) => parseMoney(l.cost) !== null);
  return (
    <Panel title="Enter a supplier bill">
      <form className="stack" onSubmit={(e) => { e.preventDefault(); setErr(null); save.mutate(); }}>
        <div className="grid2">
          <Select label="Supplier" value={sup} onChange={(v) => { setSup(v); setPoId(null); setLines([]); }} options={(sups.data ?? []).map((s) => ({ value: s.id, label: s.name }))} placeholder="Choose a supplier" chevron={<ChevronDown size={16} />} />
          <Select label="Against order" value={poId} onChange={(v) => void pick(v)} options={(pos.data ?? []).filter((p) => ["sent", "partial", "received", "closed"].includes(p.status)).map((p) => ({ value: p.id, label: `${p.number} · ${p.qtyReceived}/${p.qtyOrdered} received` }))} placeholder={sup ? "Choose an order (optional)" : "Choose a supplier first"} chevron={<ChevronDown size={16} />} />
          <Field id="bill-no" label="Supplier's invoice number"><TextInput id="bill-no" value={num} onChange={setNum} /></Field>
          <DatePicker label="Bill date" value={date} onChange={setDate} today={today} max={addDays(today, 1)} icon={<Calendar size={16} />} prevIcon={<ChevronLeft size={16} />} nextIcon={<ChevronRight size={16} />} />
        </div>
        {lines.length > 0 && <div data-testid="bill-lines">{lines.map((l, i) => (
          <div className="linebox" key={l.key} style={{ gridTemplateColumns: "minmax(0,1fr) auto auto" }}><span>{l.label}<br /><span className="muted" style={{ fontSize: 12.5 }}>{l.received} of {l.ordered} received</span></span>
            <Stepper label={`Billed quantity of ${l.label}`} value={l.qty} min={1} max={100000} onChange={(n) => setLines((ls) => ls.map((x, j) => j === i ? { ...x, qty: n } : x))} decrementIcon={<Minus size={16} />} incrementIcon={<Plus size={16} />} />
            <label className="input" style={{ width: 110 }}><input aria-label={`Billed unit price of ${l.label}`} inputMode="decimal" value={l.cost} onChange={(e) => setLines((ls) => ls.map((x, j) => j === i ? { ...x, cost: e.target.value } : x))} /></label></div>))}</div>}
        <div className="grid2"><Field id="bill-xl" label="Other charge"><TextInput id="bill-xl" value={extraLabel} onChange={setExtraLabel} /></Field><Field id="bill-xa" label="Amount (A$)"><TextInput id="bill-xa" inputMode="decimal" value={extra} onChange={setExtra} placeholder="0.00" /></Field></div>
        <div className="lead total"><span>Bill total</span><i /><b>{money(total)}</b></div>
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>A bill that claims more than has been received, or a different price from the order, is put on hold until the goods arrive or finance approves it.</p>
        {err && <p className="err" role="alert">{err}</p>}
        <div className="row-flex"><Button onClick={() => onDone("")}>Cancel</Button><span className="grow" /><Button variant="primary" type="submit" disabled={!ok || save.isPending}>Save bill</Button></div>
      </form>
    </Panel>
  );
}

function PayForm({ b, today }: { b: any; today: string }) {
  const qc = useQueryClient(); const owed = b.totalMinor - b.paidMinor; const [amt, setAmt] = useState(centsText(owed)); const [date, setDate] = useState(today); const [method, setMethod] = useState<string | null>("bank_transfer"); const [ref, setRef] = useState(""); const [key] = useState(() => crypto.randomUUID()); const [err, setErr] = useState<string | null>(null);
  const a = parseMoney(amt);
  const pay = useMutation({ mutationFn: () => api("/bills/" + b.id + "/payments", { method: "POST", body: { amountMinor: a, paidOn: date, method, reference: ref.trim() || undefined, idempotencyKey: key } }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["bills"] }); void qc.invalidateQueries({ queryKey: ["bill", b.id] }); },
    onError: (e) => setErr(e instanceof ApiError && e.code === "overpayment" ? `Only ${money(e.body.owedMinor)} is owed on this bill.` : e instanceof ApiError && e.code === "bill_held" ? "This bill is on hold." : "Could not record the payment.") });
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); setErr(null); pay.mutate(); }} aria-label="Record a payment"><b>Record a payment</b>
      <div className="grid2"><Field id="pay-amt" label="Amount (A$)"><TextInput id="pay-amt" inputMode="decimal" value={amt} onChange={setAmt} /></Field>
        <DatePicker label="Paid on" value={date} onChange={setDate} today={today} max={today} icon={<Calendar size={16} />} prevIcon={<ChevronLeft size={16} />} nextIcon={<ChevronRight size={16} />} />
        <Select label="Method" value={method} onChange={setMethod} options={METHODS} chevron={<ChevronDown size={16} />} /><Field id="pay-ref" label="Reference"><TextInput id="pay-ref" value={ref} onChange={setRef} placeholder="EFT number" /></Field></div>
      {err && <p className="err" role="alert">{err}</p>}<div className="row-flex"><span className="grow" /><Button variant="primary" type="submit" disabled={!a || a > owed || !method || pay.isPending}>Pay {a ? money(a) : ""}</Button></div>
    </form>
  );
}

function Detail({ id, today }: { id: string; today: string }) {
  const qc = useQueryClient(); const { can } = useAuth(); const [note, setNote] = useState(""); const [err, setErr] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["bill", id], queryFn: () => api<any>(`/bills/${id}`) });
  const refresh = () => { setErr(null); void qc.invalidateQueries({ queryKey: ["bills"] }); void qc.invalidateQueries({ queryKey: ["bill", id] }); };
  const approve = useMutation({ mutationFn: () => api(`/bills/${id}/approve`, { method: "POST", body: { note: note.trim() } }), onSuccess: () => { setNote(""); refresh(); }, onError: () => setErr("Could not approve. Give a reason of at least three characters.") });
  const rematch = useMutation({ mutationFn: () => api<{ released: boolean }>(`/bills/${id}/rematch`, { method: "POST" }), onSuccess: (r) => { refresh(); if (!r.released) setErr("Still more billed than received, or the price still differs."); } });
  const voidIt = useMutation({ mutationFn: () => api(`/bills/${id}/void`, { method: "POST" }), onSuccess: refresh, onError: () => setErr("A bill with payments cannot be voided.") });
  if (q.isLoading) return <Panel><Skeleton rows={8} /></Panel>; if (q.isError) return <ErrorBox error={q.error} retry={() => q.refetch()} />; const b = q.data!; const owed = b.totalMinor - b.paidMinor;
  return (
    <section className="panel detail" aria-label={`Bill ${b.number}`} data-testid="bill-detail">
      <div className="drawer-head"><div><h2>{b.number}</h2><div className="muted" style={{ fontSize: 13 }}>{b.supplier} · billed {b.billDate} · due {b.dueOn}</div></div><span className="row-flex" style={{ gap: 6 }}>{billChip(b.status)}<button className="btn ghost sm" aria-label="Close details" onClick={() => navigate("money", "bills")}>✕</button></span></div>
      <div className="pb stack">
        {b.status === "held" && <Callout tone="warn"><span><b>On hold: not payable yet.</b> This bill is {b.holdReasons.map((r: string) => HOLD_TEXT[r] ?? r).join(" and ")}.{b.poNumber && <> Order <a href={href("stock", "purchase-orders", b.poId)}>{b.poNumber}</a>.</>}<br />It is released by itself when the goods arrive, or finance can approve it with a reason.</span></Callout>}
        {b.approvedNote && <p className="muted" style={{ margin: 0 }}>Approved with differences: “{b.approvedNote}”</p>}
        <div className="tbl-wrap"><table className="tbl" data-testid="bill-line-table"><thead><tr><th>Item</th><th className="n">Billed</th><th className="n">Received</th><th className="n">Price</th><th className="n">Total</th></tr></thead>
          <tbody>{b.lines.map((l: any) => <tr key={l.id}><td>{l.title ? <><b>{l.title}</b><br /><span className="muted" style={{ fontSize: 12.5 }}>{l.sku}</span></> : l.description}</td><td className="n">{l.qty}</td>
            <td className="n">{l.match ? <span className={l.match.qtyDiff > 0 ? "neg" : ""}>{l.match.receivedQty}{l.match.qtyDiff > 0 && <> (−{l.match.qtyDiff})</>}</span> : <span className="muted">—</span>}</td>
            <td className="n">{plain(l.unitCostMinor)}{l.match && l.match.costDiffMinor !== 0 && <> <Chip tone="warn">{l.match.costDiffMinor > 0 ? "+" : "−"}{plain(Math.abs(l.match.costDiffMinor))}</Chip></>}</td><td className="n">{plain(l.totalMinor)}</td></tr>)}</tbody></table></div>
        <div className="lead total"><span>Total</span><i /><b>{money(b.totalMinor)}</b></div>
        <div className="lead"><span>Paid</span><i /><b>{money(b.paidMinor)}</b></div><div className="lead"><span>Still owed</span><i /><b data-testid="bill-owed">{money(owed)}</b></div>
        {err && <p className="err" role="alert">{err}</p>}
        {b.status === "held" && can("bill:write", null) && <div className="row-flex"><Button onClick={() => rematch.mutate()} disabled={rematch.isPending}>Check again against deliveries</Button></div>}
        {b.status === "held" && can("bill:approve", null) && <form className="stack" onSubmit={(e) => { e.preventDefault(); approve.mutate(); }} aria-label="Approve with differences"><b>Approve with differences</b>
          <Field id="appr" label="Reason" hint="Kept with the bill and in the audit log"><TextInput id="appr" value={note} onChange={setNote} placeholder="e.g. Price rise agreed by phone" /></Field><div className="row-flex"><span className="grow" /><Button variant="primary" type="submit" disabled={note.trim().length < 3 || approve.isPending}>Approve for payment</Button></div></form>}
        {["open", "partially_paid"].includes(b.status) && can("bill:write", null) && <PayForm key={b.paidMinor} b={b} today={today} />}
        {b.payments.length > 0 && <div><b>Payments</b>{b.payments.map((p: any) => <div className="lead" key={p.id}><span>{p.paidOn} · {METHODS.find((m) => m.value === p.method)?.label}{p.reference ? ` · ${p.reference}` : ""}</span><i /><b>{plain(p.amountMinor)}</b></div>)}</div>}
        {b.paidMinor === 0 && b.status !== "void" && can("bill:write", null) && <div className="row-flex"><Button variant="ghost" onClick={() => voidIt.mutate()}>Void this bill</Button></div>}
      </div>
    </section>
  );
}

const VIEWS = [{ value: "all", label: "All" }, { value: "held", label: "On hold" }, { value: "unpaid", label: "Unpaid" }, { value: "overdue", label: "Overdue" }, { value: "paid", label: "Paid" }] as const;
export function Bills() {
  useLensLock(true);
  const route = useRoute(); const { can } = useAuth(); const today = useBusinessToday(); const [q, setQ] = useState(""); const [view, setView] = useState<(typeof VIEWS)[number]["value"]>("unpaid"); const [creating, setCreating] = useState(false); const sel = route.id;
  const list = useQuery({ queryKey: ["bills", "list", q, today], queryFn: () => api<Row[]>(`/bills${qs({ q, asOf: today })}`) });
  const rows = useMemo(() => (list.data ?? []).filter((r) => r.status !== "void" && (view === "all" || (view === "held" ? r.status === "held" : view === "unpaid" ? r.status !== "paid" : view === "overdue" ? r.overdue : r.status === "paid"))), [list.data, view]);
  return (<>
    <PageHeader title="Bills & payments" sub="Supplier bills matched against what was ordered and received" actions={can("bill:write", null) && <Button variant="primary" onClick={() => setCreating(true)}>Enter a bill</Button>} />
    <Aging today={today} />
    {creating && <NewBill today={today} onDone={(id) => { setCreating(false); setView("all"); if (id) navigate("money", "bills", id); }} />}
    <div className="filters"><label className="input" style={{ minWidth: 260 }}><Search size={16} /><input aria-label="Search bills" placeholder="Invoice number or supplier" value={q} onChange={(e) => setQ(e.target.value)} /></label><Segmented label="Show" value={view} onChange={setView} options={VIEWS.map((v) => ({ value: v.value, label: v.label }))} /></div>
    <div className={`md${sel ? "" : " single"}`}>
      <Panel flush>{list.isLoading ? <Skeleton rows={6} /> : list.isError ? <ErrorBox error={list.error} retry={() => list.refetch()} /> : rows.length === 0 ? <Empty title="No bills here">{view === "held" ? "Nothing is on hold." : view === "overdue" ? "Nothing is overdue." : "Nothing matches."}</Empty> :
        <div className="tbl-wrap"><table className="tbl" data-testid="bills-table"><thead><tr><th>Invoice</th><th>Supplier</th><th>Due</th><th className="n">Total</th><th className="n">Owed</th><th>Status</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id} className="clickable" tabIndex={0} aria-selected={sel === r.id} onClick={() => navigate("money", "bills", r.id)} onKeyDown={(e) => { if (e.key === "Enter") navigate("money", "bills", r.id); }}>
            <td><b className="mono">{r.number}</b>{r.poNumber && <><br /><span className="muted" style={{ fontSize: 12.5 }}>{r.poNumber}</span></>}</td><td>{r.supplier}</td><td>{r.dueOn}{r.overdue && <> <Chip tone="danger">Overdue</Chip></>}</td><td className="n">{plain(r.totalMinor)}</td><td className="n"><b>{plain(r.totalMinor - r.paidMinor)}</b></td><td>{billChip(r.status)}</td></tr>)}</tbody></table></div>}
      </Panel>
      {sel && <Detail id={sel} today={today} />}
    </div>
  </>);
}
