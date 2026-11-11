import { useCallback, useEffect, useMemo, useState } from "react";
import { Minus, Plus, ScanBarcode, WifiOff } from "lucide-react";
import { Button, Callout, Chip, Segmented, Stepper } from "@shelfline/ui";
import { ApiError, apiCall, OfflineError } from "../lib/api";
import { useApp } from "../state/app";

interface TLine { id: string; sku: string; title: string; options: Record<string, string>; qtySent: number; qtyReceived: number; qtyVariance: number }
interface Inbound { id: string; number: string; from: string; status: string; qtySent: number; qtyReceived: number }
interface CLine { variantId: string; sku: string; title: string; options: Record<string, string>; counted: number | null; unexpected: boolean }
const opt = (o: Record<string, string>) => Object.values(o ?? {}).join(" · ");

function useCall() {
  const { device, auth } = useApp();
  return useCallback(<T,>(path: string, method: "GET" | "POST" | "PUT" = "GET", body?: unknown) => apiCall<T>(device!.apiUrl, auth!.token, path, method, body), [device, auth]);
}
const Offline = () => <Callout tone="warn" icon={<WifiOff size={18} />}>Receiving and counting act on the server's stock directly, so they need a connection. Selling carries on offline.</Callout>;

function Receive() {
  const { auth } = useApp(); const call = useCall(); const [list, setList] = useState<Inbound[] | null>(null); const [offline, setOffline] = useState(false); const [sel, setSel] = useState<any>(null);
  const [qty, setQty] = useState<Record<string, number>>({}); const [rest, setRest] = useState<"keep" | "short">("keep"); const [msg, setMsg] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null); const [key, setKey] = useState(() => crypto.randomUUID());
  const load = useCallback(async () => { try { const r = await call<(Inbound & { toId: string })[]>(`/transfers?locationId=${auth!.locationId}`); setList(r.filter((t) => t.toId === auth!.locationId && ["sent", "partial"].includes(t.status))); setOffline(false); } catch (e) { if (e instanceof OfflineError) setOffline(true); else setList([]); } }, [call, auth]);
  useEffect(() => { void load(); }, [load]);
  const open = async (id: string) => { setErr(null); setMsg(null); try { const t = await call<any>(`/transfers/${id}`); setSel(t); setKey(crypto.randomUUID()); setRest("keep"); setQty(Object.fromEntries(t.lines.map((l: TLine) => [l.id, l.qtySent - l.qtyReceived - l.qtyVariance]))); } catch { setOffline(true); } };
  const lines: TLine[] = (sel?.lines ?? []).filter((l: TLine) => l.qtySent > l.qtyReceived + l.qtyVariance); const missing = lines.reduce((a, l) => a + (l.qtySent - l.qtyReceived - l.qtyVariance - (qty[l.id] ?? 0)), 0);
  const record = async () => {
    setErr(null);
    try { const r = await call<{ status: string; variance: number }>(`/transfers/${sel.id}/receive`, "POST", { idempotencyKey: key, closeShort: rest === "short", lines: lines.map((l) => ({ lineId: l.id, qty: qty[l.id] ?? 0 })).filter((l) => l.qty > 0) });
      setMsg(`${sel.number}: ${r.status === "received" ? "complete" : "part received"}${r.variance ? `, ${r.variance} written off` : ""}.`); setSel(null); void load();
    } catch (e) { if (e instanceof OfflineError) setOffline(true); else setErr(e instanceof ApiError && e.status === 403 ? "You are not allowed to receive stock here." : "Could not record the receipt."); }
  };
  if (sel) return (
    <div className="stack" style={{ maxWidth: 640 }}>
      <div className="row-flex"><h2 style={{ margin: 0 }}>{sel.number}</h2><Chip tone="info">from {sel.from}</Chip><span className="grow" /><Button onClick={() => setSel(null)}>Back</Button></div>
      <p className="muted" style={{ margin: 0 }}>Count what is in the box, then enter it.</p>
      {lines.map((l) => <div className="panel" key={l.id}><div className="pb row-flex"><span className="grow"><b>{l.title}</b><br /><span className="muted">{opt(l.options)} · {l.sku} · {l.qtySent - l.qtyReceived - l.qtyVariance} expected</span></span>
        <Stepper label={`Arrived of ${l.sku}`} value={qty[l.id] ?? 0} min={0} max={l.qtySent - l.qtyReceived - l.qtyVariance} onChange={(n) => setQty((q) => ({ ...q, [l.id]: n }))} decrementIcon={<Minus size={18} />} incrementIcon={<Plus size={18} />} /></div></div>)}
      {missing > 0 && <Segmented label="Missing units" value={rest} onChange={setRest} options={[{ value: "keep", label: `Still coming (${missing})` }, { value: "short", label: `Lost: write off ${missing}` }]} />}
      {rest === "short" && missing > 0 && <Callout tone="warn">The {missing} missing unit{missing === 1 ? "" : "s"} will be written off and the transfer closed.</Callout>}
      {err && <p className="err" role="alert">{err}</p>}
      <Button variant="primary" size="lg" onClick={() => void record()}>Record receipt</Button>
    </div>
  );
  return (
    <div className="stack" style={{ maxWidth: 640 }}>
      {offline && <Offline />}{msg && <Callout tone="info">{msg}</Callout>}
      {list === null ? <p className="muted">Loading…</p> : list.length === 0 && !offline ? <p className="muted">Nothing is on its way to this store.</p> : list.map((t) => (
        <button type="button" key={t.id} className="panel" style={{ textAlign: "left", cursor: "pointer" }} onClick={() => void open(t.id)} aria-label={`Open transfer ${t.number}`}><div className="pb row-flex"><span className="grow"><b>{t.number}</b> <span className="muted">from {t.from}</span></span><Chip tone={t.status === "partial" ? "warn" : "info"}>{t.qtySent - t.qtyReceived} units to come</Chip></div></button>))}
    </div>
  );
}

function Count() {
  const { auth, catalogue } = useApp(); const call = useCall(); const [list, setList] = useState<{ id: string; number: string; mode: string; lines: number; counted: number }[] | null>(null); const [offline, setOffline] = useState(false);
  const [sel, setSel] = useState<any>(null); const [local, setLocal] = useState<Record<string, number>>({}); const [scan, setScan] = useState(""); const [note, setNote] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => { try { setList(await call(`/stock-counts?locationId=${auth!.locationId}&status=counting`)); setOffline(false); } catch (e) { if (e instanceof OfflineError) setOffline(true); else setList([]); } }, [call, auth]);
  useEffect(() => { void load(); }, [load]);
  const open = async (id: string) => { try { const c = await call<any>(`/stock-counts/${id}`); setSel(c); setLocal(Object.fromEntries(c.lines.filter((l: CLine) => l.counted !== null).map((l: CLine) => [l.variantId, l.counted]))); setNote(null); setErr(null); } catch { setOffline(true); } };
  const names = useMemo(() => new Map<string, { sku: string; title: string; options: Record<string, string> }>((sel?.lines ?? []).map((l: CLine) => [l.variantId, l])), [sel]);
  const add = (code: string) => {
    const v = catalogue?.byCode(code); if (!v) { setNote(`“${code}” is not a product here.`); return; }
    if (!names.has(v.id)) names.set(v.id, { sku: v.sku, title: v.title, options: { label: v.optionsLabel } });
    setLocal((l) => ({ ...l, [v.id]: (l[v.id] ?? 0) + 1 })); setNote(`${v.title} ${v.optionsLabel}`); setScan("");
  };
  const save = async (submit: boolean) => {
    setErr(null);
    try { const lines = Object.entries(local).map(([variantId, countedQty]) => ({ variantId, countedQty })); if (lines.length) await call(`/stock-counts/${sel.id}/lines`, "PUT", { lines }); if (submit) await call(`/stock-counts/${sel.id}/submit`, "POST");
      setNote(submit ? "Submitted for review. A manager commits the adjustments in the back office." : "Counts saved."); if (submit) { setSel(null); void load(); } else await open(sel.id);
    } catch (e) { if (e instanceof OfflineError) setOffline(true); else setErr("Could not save the count."); }
  };
  if (sel) { const rows = [...Object.keys(local)].map((id) => ({ ...names.get(id)!, id })); return (
    <div className="stack" style={{ maxWidth: 680 }}>
      <div className="row-flex"><h2 style={{ margin: 0 }}>{sel.number}</h2><Chip>{sel.blind ? "blind" : "open"}</Chip><span className="grow" /><Button onClick={() => { setSel(null); void load(); }}>Back</Button></div>
      <form className="row-flex" onSubmit={(e) => { e.preventDefault(); if (scan.trim()) add(scan.trim()); }}><label className="input grow"><ScanBarcode size={18} /><input aria-label="Scan to count" placeholder="Scan an item, each scan adds one" value={scan} onChange={(e) => setScan(e.target.value)} autoFocus /></label><Button type="submit">Add</Button></form>
      {note && <p className="muted" style={{ margin: 0 }} role="status">{note}</p>}{offline && <Offline />}
      <div data-testid="count-lines">{rows.length === 0 ? <p className="muted">Nothing counted yet.</p> : rows.map((r) => <div className="panel" key={r.id}><div className="pb row-flex"><span className="grow"><b>{r.title}</b><br /><span className="muted">{opt(r.options)} · {r.sku}</span></span>
        <Stepper label={`Counted ${r.sku}`} value={local[r.id] ?? 0} min={0} max={100000} onChange={(n) => setLocal((l) => ({ ...l, [r.id]: n }))} decrementIcon={<Minus size={18} />} incrementIcon={<Plus size={18} />} /></div></div>)}</div>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="row-flex"><Button onClick={() => void save(false)} disabled={rows.length === 0}>Save</Button><Button variant="primary" size="lg" onClick={() => void save(true)}>Submit count</Button></div>
    </div>); }
  return (
    <div className="stack" style={{ maxWidth: 640 }}>
      {offline && <Offline />}{note && <Callout tone="info">{note}</Callout>}
      {list === null ? <p className="muted">Loading…</p> : list.length === 0 && !offline ? <p className="muted">No count is open for this store. A manager starts one in the back office.</p> : list.map((c) => (
        <button type="button" key={c.id} className="panel" style={{ textAlign: "left", cursor: "pointer" }} onClick={() => void open(c.id)} aria-label={`Open count ${c.number}`}><div className="pb row-flex"><span className="grow"><b>{c.number}</b> <span className="muted">{c.mode === "full" ? "full count" : "cycle count"}</span></span><Chip tone="info">{c.counted} / {c.lines} counted</Chip></div></button>))}
    </div>
  );
}

export function StockScreen() {
  const [tab, setTab] = useState<"receive" | "count">("receive");
  return (
    <section className="pos-main" style={{ gridRow: "2 / 3", gridColumn: "2 / 4", overflow: "auto", display: "block" }} aria-label="Stock on the floor">
      <div className="stack"><div className="row-flex"><h1 style={{ margin: 0, fontSize: 26 }}>Stock</h1><span className="grow" /><Segmented label="Stock task" value={tab} onChange={setTab} options={[{ value: "receive", label: "Receive transfer" }, { value: "count", label: "Count" }]} /></div>
        {tab === "receive" ? <Receive /> : <Count />}</div>
    </section>
  );
}
