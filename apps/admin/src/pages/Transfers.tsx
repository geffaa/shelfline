import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Minus, Plus, Trash2 } from "lucide-react";
import { Button, Callout, Chip, Segmented, Select, Stepper } from "@shelfline/ui";
import { api, ApiError } from "../lib/api";
import { navigate, useRoute } from "../router";
import { useAuth } from "../state/auth";
import { useLens, useLensLock } from "../state/lens";
import { Empty, ErrorBox, PageHeader, Panel, Skeleton } from "../ui";
import { optText, trChip, VariantPicker, type VariantHit } from "./buy";

interface Row { id: string; number: string; status: string; from: string; to: string; qtySent: number; qtyReceived: number; qtyVariance: number; daysInTransit: number | null; stuck: boolean }
interface Draft { variantId: string; label: string; qty: number; have: number | null }

function NewTransfer({ onDone }: { onDone: (id: string) => void }) {
  const qc = useQueryClient(); const { locations } = useLens(); const { can } = useAuth();
  const places = locations.filter((l) => l.type === "store" || l.type === "warehouse"); const [from, setFrom] = useState<string | null>(null); const [to, setTo] = useState<string | null>(null); const [lines, setLines] = useState<Draft[]>([]); const [err, setErr] = useState<string | null>(null);
  const add = async (v: VariantHit) => {
    if (lines.some((l) => l.variantId === v.id)) return; setLines((ls) => [...ls, { variantId: v.id, label: `${v.title} · ${optText(v.options)} · ${v.sku}`, qty: 1, have: null }]);
    if (from) { const r = await api<{ onHand: number }[]>(`/inventory?variantId=${v.id}&locationId=${from}`); setLines((ls) => ls.map((l) => l.variantId === v.id ? { ...l, have: r[0]?.onHand ?? 0 } : l)); }
  };
  const save = useMutation({
    mutationFn: async (send: boolean) => { const t = await api<{ id: string }>("/transfers", { method: "POST", body: { fromLocationId: from, toLocationId: to, lines: lines.map((l) => ({ variantId: l.variantId, qty: l.qty })) } }); if (send) await api(`/transfers/${t.id}/send`, { method: "POST" }); return t; },
    onSuccess: (t) => { void qc.invalidateQueries({ queryKey: ["transfers"] }); void qc.invalidateQueries({ queryKey: ["inventory"] }); onDone(t.id); },
    onError: (e) => setErr(e instanceof ApiError && e.code === "insufficient_stock" ? `Only ${e.body.onHand} on hand at the sending location for one of the items.` : e instanceof ApiError && e.status === 403 ? "You cannot send stock from that location." : "Could not save the transfer."),
  });
  const ok = !!from && !!to && from !== to && lines.length > 0;
  return (
    <Panel title="New transfer">
      <form className="stack" onSubmit={(e) => { e.preventDefault(); setErr(null); save.mutate(false); }}>
        <div className="grid2">
          <Select label="From" value={from} onChange={(v) => { setFrom(v); setLines((ls) => ls.map((l) => ({ ...l, have: null }))); }} options={places.filter((l) => can("inventory:write", l.id)).map((l) => ({ value: l.id, label: l.name }))} placeholder="Sending location" chevron={<ChevronDown size={16} />} />
          <Select label="To" value={to} onChange={setTo} options={places.filter((l) => l.id !== from).map((l) => ({ value: l.id, label: l.name }))} placeholder="Receiving location" chevron={<ChevronDown size={16} />} />
        </div>
        <VariantPicker onPick={(v) => void add(v)} />
        {lines.length > 0 && <div data-testid="transfer-lines">{lines.map((l, i) => (
          <div className="linebox" key={l.variantId} style={{ gridTemplateColumns: "minmax(0,1fr) auto auto" }}><span>{l.label}{l.have !== null && <><br /><span className={l.have < l.qty ? "neg" : "muted"} style={{ fontSize: 12.5 }}>{l.have} on hand at the sending location</span></>}</span>
            <Stepper label={`Quantity of ${l.label}`} value={l.qty} min={1} max={100000} onChange={(n) => setLines((ls) => ls.map((x, j) => j === i ? { ...x, qty: n } : x))} decrementIcon={<Minus size={16} />} incrementIcon={<Plus size={16} />} />
            <button type="button" className="btn ghost sm" aria-label={`Remove ${l.label}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><Trash2 size={16} /></button></div>))}</div>}
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Sending takes the stock off the sending location straight away. It is held “in transit” until the receiving location counts it in.</p>
        {err && <p className="err" role="alert">{err}</p>}
        <div className="row-flex"><Button onClick={() => onDone("")}>Cancel</Button><span className="grow" /><Button type="submit" disabled={!ok || save.isPending}>Save draft</Button><Button variant="primary" disabled={!ok || save.isPending} onClick={() => { setErr(null); save.mutate(true); }}>Save and send</Button></div>
      </form>
    </Panel>
  );
}

function Receive({ t, onDone }: { t: any; onDone: () => void }) {
  const qc = useQueryClient(); const open = t.lines.filter((l: any) => l.qtySent > l.qtyReceived + l.qtyVariance);
  const [qty, setQty] = useState<Record<string, number>>(() => Object.fromEntries(open.map((l: any) => [l.id, l.qtySent - l.qtyReceived - l.qtyVariance]))); const [rest, setRest] = useState<"keep" | "short">("keep"); const [key] = useState(() => crypto.randomUUID()); const [err, setErr] = useState<string | null>(null); const [done, setDone] = useState<any>(null);
  const missing = open.reduce((a: number, l: any) => a + (l.qtySent - l.qtyReceived - l.qtyVariance - (qty[l.id] ?? 0)), 0);
  const save = useMutation({
    mutationFn: () => api<any>(`/transfers/${t.id}/receive`, { method: "POST", body: { idempotencyKey: key, closeShort: rest === "short", lines: open.map((l: any) => ({ lineId: l.id, qty: qty[l.id] ?? 0 })).filter((l: any) => l.qty > 0) } }),
    onSuccess: (r) => { setDone(r); void qc.invalidateQueries({ queryKey: ["transfer", t.id] }); void qc.invalidateQueries({ queryKey: ["transfers"] }); void qc.invalidateQueries({ queryKey: ["inventory"] }); },
    onError: (e) => setErr(e instanceof ApiError && e.code === "nothing_received" ? "Enter what arrived." : "Could not record the receipt."),
  });
  if (done) return <Callout tone="info"><span><b>Receipt recorded.</b> {done.status === "received" ? "The transfer is complete." : "The rest is still on its way."}{done.variance > 0 && ` ${done.variance} unit${done.variance === 1 ? " was" : "s were"} written off as a shortage.`} <Button size="sm" onClick={onDone}>Done</Button></span></Callout>;
  return (
    <form className="stack" aria-label="Receive transfer" onSubmit={(e) => { e.preventDefault(); setErr(null); save.mutate(); }}>
      <b>Count what arrived</b>
      {open.map((l: any) => <div className="linebox" key={l.id} style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}><span>{l.title} <span className="muted">{optText(l.options)} · {l.qtySent - l.qtyReceived - l.qtyVariance} expected</span></span>
        <Stepper label={`Arrived of ${l.sku}`} value={qty[l.id] ?? 0} min={0} max={l.qtySent - l.qtyReceived - l.qtyVariance} onChange={(n) => setQty((q) => ({ ...q, [l.id]: n }))} decrementIcon={<Minus size={16} />} incrementIcon={<Plus size={16} />} /></div>)}
      {missing > 0 && <><Segmented label="What about the missing units" value={rest} onChange={setRest} options={[{ value: "keep", label: `Still coming (${missing})` }, { value: "short", label: `Lost: write off ${missing}` }]} />
        {rest === "short" && <Callout tone="warn"><span>The {missing} missing unit{missing === 1 ? "" : "s"} will be recorded as a transfer shortage and the transfer closed. This cannot be undone.</span></Callout>}</>}
      {err && <p className="err" role="alert">{err}</p>}
      <div className="row-flex"><Button onClick={onDone}>Cancel</Button><span className="grow" /><Button variant="primary" type="submit" disabled={save.isPending}>Record receipt</Button></div>
    </form>
  );
}

function Detail({ id }: { id: string }) {
  const qc = useQueryClient(); const [mode, setMode] = useState(false); const [err, setErr] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["transfer", id], queryFn: () => api<any>(`/transfers/${id}`) });
  const act = useMutation({ mutationFn: (a: string) => api(`/transfers/${id}/${a}`, { method: "POST" }), onSuccess: () => { setErr(null); void qc.invalidateQueries({ queryKey: ["transfer", id] }); void qc.invalidateQueries({ queryKey: ["transfers"] }); void qc.invalidateQueries({ queryKey: ["inventory"] }); },
    onError: (e) => setErr(e instanceof ApiError && e.code === "insufficient_stock" ? `Not enough stock to send: ${e.body.onHand} on hand, ${e.body.wanted} needed.` : "That is not possible right now.") });
  if (q.isLoading) return <Panel><Skeleton rows={6} /></Panel>; if (q.isError) return <ErrorBox error={q.error} retry={() => q.refetch()} />; const t = q.data!;
  return (
    <section className="panel detail" aria-label={`Transfer ${t.number}`} data-testid="transfer-detail">
      <div className="drawer-head"><div><h2>{t.number}</h2><div className="muted" style={{ fontSize: 13 }}>{t.from} → {t.to}</div></div><span className="row-flex" style={{ gap: 6 }}>{trChip(t.status)}<button className="btn ghost sm" aria-label="Close details" onClick={() => navigate("stock", "transfers")}>✕</button></span></div>
      <div className="pb stack">
        {t.stuck && <Callout tone="warn"><span><b>On the road for more than a week.</b> Check with {t.to}, or close the transfer short if it is lost.</span></Callout>}
        {mode ? <Receive t={t} onDone={() => setMode(false)} /> : <div className="row-flex">
          {t.status === "draft" && t.canSend && <Button variant="primary" onClick={() => act.mutate("send")}>Send now</Button>}
          {["sent", "partial"].includes(t.status) && t.canReceive && <Button variant="primary" onClick={() => setMode(true)}>Receive</Button>}
          {t.status === "draft" && t.canSend && <Button variant="ghost" onClick={() => act.mutate("cancel")}>Cancel</Button>}</div>}
        {err && <p className="err" role="alert">{err}</p>}
        <div className="tbl-wrap"><table className="tbl" data-testid="transfer-line-table"><thead><tr><th>Item</th><th className="n">Sent</th><th className="n">Received</th><th className="n">Short</th></tr></thead>
          <tbody>{t.lines.map((l: any) => <tr key={l.id}><td><b>{l.title}</b><br /><span className="muted" style={{ fontSize: 12.5 }}>{optText(l.options)} · {l.sku}</span></td><td className="n">{l.qtySent}</td><td className="n">{l.qtyReceived}</td><td className="n">{l.qtyVariance > 0 ? <span className="neg">{l.qtyVariance}</span> : "—"}</td></tr>)}</tbody></table></div>
        {t.receipts.length > 0 && <div><b>Receipts</b>{t.receipts.map((r: any) => <div className="lead" key={r.id}><span>{new Date(r.receivedAt).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })}</span><i /><b>{r.closedShort ? <Chip tone="warn">Closed short</Chip> : "received"}</b></div>)}</div>}
      </div>
    </section>
  );
}

const VIEWS = [{ value: "open", label: "In transit" }, { value: "draft", label: "Drafts" }, { value: "done", label: "Done" }, { value: "all", label: "All" }] as const;
export function Transfers() {
  useLensLock(false);
  const { lens, selected } = useLens(); const route = useRoute(); const { canAny } = useAuth(); const [view, setView] = useState<(typeof VIEWS)[number]["value"]>("open"); const [creating, setCreating] = useState(false); const sel = route.id;
  const list = useQuery({ queryKey: ["transfers", lens], queryFn: () => api<Row[]>(`/transfers${lens === "all" ? "" : `?locationId=${lens}`}`) });
  const rows = useMemo(() => (list.data ?? []).filter((r) => view === "all" || (view === "open" ? ["sent", "partial"].includes(r.status) : view === "draft" ? r.status === "draft" : ["received", "cancelled"].includes(r.status))), [list.data, view]);
  return (<>
    <PageHeader title="Transfers" sub={<>{lens === "all" ? "All locations" : selected?.name} · stock moving between places, counted in at the other end</>} actions={canAny("inventory:write") && <Button variant="primary" onClick={() => setCreating(true)}>New transfer</Button>} />
    <div className="filters"><Segmented label="Show" value={view} onChange={setView} options={VIEWS.map((v) => ({ value: v.value, label: v.label }))} /></div>
    {creating && <NewTransfer onDone={(id) => { setCreating(false); if (id) navigate("stock", "transfers", id); }} />}
    <div className={`md${sel ? "" : " single"}`}>
      <Panel flush>{list.isLoading ? <Skeleton rows={5} /> : list.isError ? <ErrorBox error={list.error} retry={() => list.refetch()} /> : rows.length === 0 ? <Empty title="No transfers here">{view === "open" ? "Nothing is on the road." : "Nothing matches."}</Empty> :
        <div className="tbl-wrap"><table className="tbl" data-testid="transfers-table"><thead><tr><th>Transfer</th><th>From</th><th>To</th><th className="n">Units</th><th>Status</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id} className="clickable" tabIndex={0} aria-selected={sel === r.id} onClick={() => navigate("stock", "transfers", r.id)} onKeyDown={(e) => { if (e.key === "Enter") navigate("stock", "transfers", r.id); }}>
            <td><b className="mono">{r.number}</b></td><td>{r.from}</td><td>{r.to}</td><td className="n">{r.qtyReceived} / {r.qtySent}{r.qtyVariance > 0 && <> <span className="neg">(−{r.qtyVariance})</span></>}</td>
            <td>{trChip(r.status)}{r.stuck && <> <Chip tone="danger">{r.daysInTransit} days</Chip></>}</td></tr>)}</tbody></table></div>}
      </Panel>
      {sel && <Detail id={sel} />}
    </div>
  </>);
}
