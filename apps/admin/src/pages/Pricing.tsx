import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Calendar, ChevronDown, ChevronLeft, ChevronRight, Minus, Plus, Trash2 } from "lucide-react";
import { Button, Chip, DatePicker, Segmented, Select, Stepper, Switch } from "@shelfline/ui";
import { api, ApiError, qs } from "../lib/api";
import { centsText, money, parseMoney, plain } from "../lib/format";
import { navigate, useRoute } from "../router";
import { useAuth } from "../state/auth";
import { useBusinessToday, useLens, useLensLock } from "../state/lens";
import { Empty, ErrorBox, Field, PageHeader, Panel, Skeleton, TextInput } from "../ui";
import { optText, VariantPicker, type VariantHit } from "./buy";

interface Book { id: string; name: string; priority: number; validFrom: string | null; validTo: string | null; status: string; version: number; entries: number; places: string[] }
interface Promo { id: string; name: string; kind: "percent" | "amount_off"; valueBp: number; amountMinor: number; minQty: number; stackable: boolean; validFrom: string | null; validTo: string | null; status: string; variants: number; places: string[] }
const when = (from: string | null, to: string | null) => (!from && !to ? "Always" : `${from ?? "…"} → ${to ?? "…"}`);
/** Active means in force today; a book can also be scheduled for later or have ended. */
const state = (x: { status: string; validFrom: string | null; validTo: string | null }, today: string): { label: string; tone?: "ok" | "info" | "warn" } =>
  x.status !== "active" ? { label: "Archived" } : x.validTo && x.validTo < today ? { label: "Ended" } : x.validFrom && x.validFrom > today ? { label: "Scheduled", tone: "info" } : { label: "Active", tone: "ok" };
const offText = (p: { kind: string; valueBp: number; amountMinor: number }) => (p.kind === "percent" ? `${p.valueBp / 100}% off` : `A$${(p.amountMinor / 100).toFixed(2)} off each`);

/** Which locations: all, or a chosen few. Toggle buttons rather than a native multi-select. */
function Places({ ids, onChange }: { ids: string[]; onChange: (v: string[]) => void }) {
  const { locations } = useLens(); const stores = locations.filter((l) => l.type === "store" || l.type === "warehouse"); const [some, setSome] = useState(ids.length > 0);
  return (<div className="stack"><Switch checked={some} onChange={(v) => { setSome(v); if (!v) onChange([]); }}>Only some locations</Switch>
    {some && <div className="pill-row" role="group" aria-label="Locations">{stores.map((l) => { const on = ids.includes(l.id); return <button type="button" key={l.id} className={`chip${on ? " volt" : ""}`} aria-pressed={on} onClick={() => onChange(on ? ids.filter((x) => x !== l.id) : [...ids, l.id])}>{l.name}</button>; })}</div>}</div>);
}
function Window({ from, to, onChange }: { from: string | null; to: string | null; onChange: (f: string | null, t: string | null) => void }) {
  const today = useBusinessToday(); const [on, setOn] = useState(!!(from || to));
  return (<div className="stack"><Switch checked={on} onChange={(v) => { setOn(v); if (!v) onChange(null, null); else onChange(from ?? today, to); }}>Only between dates</Switch>
    {on && <div className="grid2"><DatePicker label="From" value={from ?? today} onChange={(v) => onChange(v, to && v > to ? v : to)} today={today} icon={<Calendar size={16} />} prevIcon={<ChevronLeft size={16} />} nextIcon={<ChevronRight size={16} />} />
      <DatePicker label="Until (inclusive)" value={to ?? from ?? today} onChange={(v) => onChange(from && v < from ? v : from, v)} today={today} icon={<Calendar size={16} />} prevIcon={<ChevronLeft size={16} />} nextIcon={<ChevronRight size={16} />} /></div>}</div>);
}

function NewBook({ onDone }: { onDone: (id: string) => void }) {
  const qc = useQueryClient(); const [name, setName] = useState(""); const [prio, setPrio] = useState(50); const [from, setFrom] = useState<string | null>(null); const [to, setTo] = useState<string | null>(null); const [places, setPlaces] = useState<string[]>([]); const [err, setErr] = useState<string | null>(null);
  const save = useMutation({ mutationFn: () => api<{ id: string }>("/price-books", { method: "POST", body: { name: name.trim(), priority: prio, validFrom: from, validTo: to, locationIds: places } }), onSuccess: (b) => { void qc.invalidateQueries({ queryKey: ["books"] }); onDone(b.id); },
    onError: (e) => setErr(e instanceof ApiError && e.code === "name_taken" ? "A price book with that name already exists." : "Could not create the price book.") });
  return (
    <Panel title="New price book">
      <form className="stack" onSubmit={(e) => { e.preventDefault(); setErr(null); save.mutate(); }}>
        <Field id="pb-name" label="Name"><TextInput id="pb-name" value={name} onChange={setName} placeholder="e.g. Spring running sale" autoFocus /></Field>
        <div className="row-flex"><span>Priority</span><Stepper label="Priority" value={prio} min={0} max={1000} onChange={setPrio} decrementIcon={<Minus size={16} />} incrementIcon={<Plus size={16} />} /><span className="muted">When two books price the same item, the higher priority wins.</span></div>
        <Window from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} /><Places ids={places} onChange={setPlaces} />
        {err && <p className="err" role="alert">{err}</p>}
        <div className="row-flex"><Button onClick={() => onDone("")}>Cancel</Button><span className="grow" /><Button variant="primary" type="submit" disabled={!name.trim() || save.isPending}>Create price book</Button></div>
      </form>
    </Panel>
  );
}

function Preview({ bookId }: { bookId: string }) {
  const { locations } = useLens(); const today = useBusinessToday(); const [loc, setLoc] = useState<string | null>(null); const [v, setV] = useState<VariantHit | null>(null); const [on, setOn] = useState(today);
  const r = useQuery({ queryKey: ["preview", v?.id, loc, on, bookId], enabled: !!v && !!loc, queryFn: () => api<any>(`/pricing/preview${qs({ variantId: v!.id, locationId: loc!, onDate: on, qty: 1 })}`) });
  return (
    <div className="stack"><b>What would it sell for?</b>
      <div className="grid2"><Select label="Preview location" value={loc} onChange={setLoc} options={locations.filter((l) => l.type !== "warehouse").map((l) => ({ value: l.id, label: l.name }))} placeholder="Location" chevron={<ChevronDown size={16} />} />
        <DatePicker label="Preview date" value={on} onChange={setOn} today={today} icon={<Calendar size={16} />} prevIcon={<ChevronLeft size={16} />} nextIcon={<ChevronRight size={16} />} /></div>
      <VariantPicker label="Preview a product" onPick={setV} />
      {v && loc && (r.isLoading ? <Skeleton rows={2} /> : r.data && <div data-testid="price-preview"><div className="lead"><span>{v.title} · {v.sku}</span><i /><b>{money(r.data.unitPriceMinor)}</b></div><div className="muted" style={{ fontSize: 12.5 }}>{r.data.priceBookId === bookId ? "This book sets the price." : r.data.priceBookId ? "Another price book wins here." : "No price book applies: the catalogue price."}{r.data.promoDiscountMinor > 0 && ` A promotion takes ${money(r.data.promoDiscountMinor)} off one.`}</div></div>)}
    </div>
  );
}

function BookDetail({ id }: { id: string }) {
  const qc = useQueryClient(); const today = useBusinessToday(); const { can } = useAuth(); const w = can("pricing:write", null); const [typed, setTyped] = useState<Record<string, string>>({}); const [fresh, setFresh] = useState<Record<string, VariantHit>>({}); const [msg, setMsg] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["book", id], queryFn: () => api<any>(`/price-books/${id}`) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["book", id] }); void qc.invalidateQueries({ queryKey: ["books"] }); };
  const save = useMutation({ mutationFn: (body: { set: { variantId: string; priceMinor: number }[]; remove: string[] }) => api<{ version: number }>(`/price-books/${id}/entries`, { method: "PUT", body }), onSuccess: (r) => { setTyped({}); setFresh({}); setMsg(`Saved. Tills pick up version ${r.version} on their next sync.`); setErr(null); refresh(); }, onError: () => setErr("Could not save the prices.") });
  const patch = useMutation({ mutationFn: (b: object) => api(`/price-books/${id}`, { method: "PATCH", body: b }), onSuccess: refresh });
  if (q.isLoading) return <Panel><Skeleton rows={6} /></Panel>; if (q.isError) return <ErrorBox error={q.error} retry={() => q.refetch()} />; const b = q.data!;
  const dirty = Object.entries(typed).filter(([, v]) => parseMoney(v) !== null).map(([variantId, v]) => ({ variantId, priceMinor: parseMoney(v)! }));
  const add = (v: VariantHit) => { setMsg(null); setFresh((f) => ({ ...f, [v.id]: v })); setTyped((t) => ({ ...t, [v.id]: t[v.id] ?? centsText(v.basePriceMinor) })); };
  const rows = [...b.entries, ...Object.keys(typed).filter((k) => !b.entries.some((e: any) => e.variantId === k)).map((k) => ({ variantId: k, priceMinor: null, new: true, title: fresh[k]?.title, sku: fresh[k]?.sku, options: fresh[k]?.options, basePriceMinor: fresh[k]?.basePriceMinor }))];
  return (
    <section className="panel detail" aria-label={`Price book ${b.name}`} data-testid="book-detail">
      <div className="drawer-head"><div><h2>{b.name}</h2><div className="muted" style={{ fontSize: 13 }}>Priority {b.priority} · {when(b.validFrom, b.validTo)} · {b.locations.length ? b.locations.map((l: any) => l.name).join(", ") : "all locations"} · v{b.version}</div></div>
        <span className="row-flex" style={{ gap: 6 }}><Chip tone={state(b, today).tone}>{state(b, today).label}</Chip><button className="btn ghost sm" aria-label="Close details" onClick={() => navigate("stock", "pricing")}>✕</button></span></div>
      <div className="pb stack">
        {msg && <p role="status" style={{ margin: 0 }}>{msg}</p>}
        {w && <VariantPicker label="Add a price" onPick={add} />}
        {rows.length === 0 ? <Empty title="No prices yet">Add products to give them a price in this book. Anything not listed keeps its normal price.</Empty> :
          <div className="tbl-wrap"><table className="tbl" data-testid="book-entries"><thead><tr><th>Item</th><th className="n">Normal</th><th className="n">In this book</th><th className="n">Off</th><th /></tr></thead>
            <tbody>{rows.map((e: any) => { const v = typed[e.variantId]; const cur = parseMoney(v ?? "") ?? e.priceMinor; const base = e.basePriceMinor ?? null; return (
              <tr key={e.variantId}><td><b>{e.title ?? "New item"}</b><br /><span className="muted" style={{ fontSize: 12.5 }}>{e.sku ? `${optText(e.options)} · ${e.sku}` : e.variantId.slice(0, 8)}</span></td><td className="n">{base !== null ? plain(base) : "—"}</td>
                <td className="n">{w ? <label className="input" style={{ width: 96, marginLeft: "auto" }}><input aria-label={`Price of ${e.sku ?? e.variantId}`} inputMode="decimal" value={v ?? centsText(e.priceMinor)} onChange={(x) => setTyped((t) => ({ ...t, [e.variantId]: x.target.value }))} /></label> : plain(e.priceMinor)}</td>
                <td className="n">{base && cur !== null ? `${Math.round((100 * (base - cur)) / base)}%` : "—"}</td><td className="n">{w && <button type="button" className="btn ghost sm" aria-label={`Remove ${e.sku ?? "item"}`} onClick={() => { if (e.new) setTyped((t) => { const { [e.variantId]: _, ...r } = t; return r; }); else save.mutate({ set: [], remove: [e.variantId] }); }}><Trash2 size={16} /></button>}</td></tr>); })}</tbody></table></div>}
        {err && <p className="err" role="alert">{err}</p>}
        {w && <div className="row-flex"><Button variant="ghost" onClick={() => patch.mutate({ status: b.status === "active" ? "archived" : "active" })}>{b.status === "active" ? "Archive this book" : "Restore"}</Button><span className="grow" /><Button variant="primary" disabled={dirty.length === 0 || save.isPending} onClick={() => save.mutate({ set: dirty, remove: [] })}>Save prices</Button></div>}
        <Preview bookId={id} />
      </div>
    </section>
  );
}

function NewPromo({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient(); const [name, setName] = useState(""); const [kind, setKind] = useState<"percent" | "amount_off">("percent"); const [val, setVal] = useState("10"); const [minQty, setMinQty] = useState(1); const [stack, setStack] = useState(false); const [from, setFrom] = useState<string | null>(null); const [to, setTo] = useState<string | null>(null);
  const [places, setPlaces] = useState<string[]>([]); const [vs, setVs] = useState<VariantHit[]>([]); const [err, setErr] = useState<string | null>(null);
  const amount = kind === "percent" ? (/^\d{1,3}(\.\d{1,2})?$/.test(val) ? Math.round(Number(val) * 100) : null) : parseMoney(val); const ok = !!name.trim() && amount !== null && amount > 0 && (kind === "amount_off" || amount <= 10000);
  const save = useMutation({ mutationFn: () => api("/promotions", { method: "POST", body: { name: name.trim(), kind, valueBp: kind === "percent" ? amount : 0, amountMinor: kind === "amount_off" ? amount : 0, minQty, stackable: stack, validFrom: from, validTo: to, variantIds: vs.map((v) => v.id), locationIds: places } }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["promos"] }); onDone(); },
    onError: (e) => setErr(e instanceof ApiError && e.code === "name_taken" ? "A promotion with that name already exists." : "Could not create the promotion.") });
  return (
    <Panel title="New promotion">
      <form className="stack" onSubmit={(e) => { e.preventDefault(); setErr(null); save.mutate(); }}>
        <Field id="pr-name" label="Name"><TextInput id="pr-name" value={name} onChange={setName} placeholder="e.g. 10% off tees" autoFocus /></Field>
        <div className="grid2"><Segmented label="Takes off" value={kind} onChange={(k) => { setKind(k); setVal(k === "percent" ? "10" : "5.00"); }} options={[{ value: "percent", label: "A percentage" }, { value: "amount_off", label: "An amount per item" }]} />
          <Field id="pr-val" label={kind === "percent" ? "Percent off" : "Amount off each (A$)"}><TextInput id="pr-val" inputMode="decimal" value={val} onChange={setVal} /></Field></div>
        <div className="row-flex"><span>Minimum quantity</span><Stepper label="Minimum quantity" value={minQty} min={1} max={999} onChange={setMinQty} decrementIcon={<Minus size={16} />} incrementIcon={<Plus size={16} />} /></div>
        <Switch checked={stack} onChange={setStack}>Stackable: adds to the best other promotion instead of competing with it</Switch>
        <b>Applies to</b>{vs.length === 0 && <p className="muted" style={{ margin: 0 }}>Every item. Add products to limit it.</p>}
        <VariantPicker label="Limit to a product" onPick={(v) => setVs((l) => (l.some((x) => x.id === v.id) ? l : [...l, v]))} />
        {vs.length > 0 && <div className="pill-row">{vs.map((v) => <button type="button" key={v.id} className="chip" aria-label={`Remove ${v.sku}`} onClick={() => setVs((l) => l.filter((x) => x.id !== v.id))}>{v.title} {optText(v.options)} ✕</button>)}</div>}
        <Window from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} /><Places ids={places} onChange={setPlaces} />
        {err && <p className="err" role="alert">{err}</p>}
        <div className="row-flex"><Button onClick={onDone}>Cancel</Button><span className="grow" /><Button variant="primary" type="submit" disabled={!ok || save.isPending}>Create promotion</Button></div>
      </form>
    </Panel>
  );
}

export function Pricing() {
  useLensLock(true);
  const route = useRoute(); const { can } = useAuth(); const w = can("pricing:write", null); const qc = useQueryClient(); const [tab, setTab] = useState<"books" | "promos">(route.id ? "books" : "books"); const [creating, setCreating] = useState(false); const sel = route.id;
  const books = useQuery({ queryKey: ["books"], queryFn: () => api<Book[]>("/price-books") }); const promos = useQuery({ queryKey: ["promos"], queryFn: () => api<Promo[]>("/promotions"), enabled: tab === "promos" });
  const toggle = useMutation({ mutationFn: (p: Promo) => api(`/promotions/${p.id}`, { method: "PATCH", body: { status: p.status === "active" ? "archived" : "active" } }), onSuccess: () => qc.invalidateQueries({ queryKey: ["promos"] }) });
  const today = useBusinessToday(); const bookRows = useMemo(() => books.data ?? [], [books.data]);
  return (<>
    <PageHeader title="Pricing" sub="What sells for how much, where and when. Tills price offline from the last synced books." actions={w && <Button variant="primary" onClick={() => setCreating(true)}>{tab === "books" ? "New price book" : "New promotion"}</Button>} />
    <div className="filters"><Segmented label="Pricing" value={tab} onChange={(t) => { setTab(t); setCreating(false); if (sel) navigate("stock", "pricing"); }} options={[{ value: "books", label: "Price books" }, { value: "promos", label: "Promotions" }]} /></div>
    {creating && tab === "books" && <NewBook onDone={(id) => { setCreating(false); if (id) navigate("stock", "pricing", id); }} />}
    {creating && tab === "promos" && <NewPromo onDone={() => setCreating(false)} />}
    {tab === "books" ? (
      <div className={`md${sel ? "" : " single"}`}>
        <Panel flush>{books.isLoading ? <Skeleton rows={4} /> : books.isError ? <ErrorBox error={books.error} retry={() => books.refetch()} /> : bookRows.length === 0 ? <Empty title="No price books">A price book gives items a different price for a place and a time. Create one to run a sale.</Empty> :
          <div className="tbl-wrap"><table className="tbl" data-testid="books-table"><thead><tr><th>Price book</th><th className="n">Priority</th><th>When</th><th>Where</th><th className="n">Items</th><th>Status</th></tr></thead>
            <tbody>{bookRows.map((r) => <tr key={r.id} className="clickable" tabIndex={0} aria-selected={sel === r.id} onClick={() => navigate("stock", "pricing", r.id)} onKeyDown={(e) => { if (e.key === "Enter") navigate("stock", "pricing", r.id); }}>
              <td><b>{r.name}</b></td><td className="n">{r.priority}</td><td>{when(r.validFrom, r.validTo)}</td><td>{r.places.length ? r.places.join(", ") : "All locations"}</td><td className="n">{r.entries}</td><td><Chip tone={state(r, today).tone}>{state(r, today).label}</Chip></td></tr>)}</tbody></table></div>}</Panel>
        {sel && <BookDetail id={sel} />}
      </div>) : (
      <Panel flush>{promos.isLoading ? <Skeleton rows={4} /> : promos.isError ? <ErrorBox error={promos.error} retry={() => promos.refetch()} /> : (promos.data ?? []).length === 0 ? <Empty title="No promotions">Take a percentage or an amount off items, for a time.</Empty> :
        <div className="tbl-wrap"><table className="tbl" data-testid="promos-table"><thead><tr><th>Promotion</th><th>Takes off</th><th>Items</th><th className="n">Min qty</th><th>When</th><th>Where</th><th>Status</th><th /></tr></thead>
          <tbody>{promos.data!.map((p) => <tr key={p.id}><td><b>{p.name}</b>{p.stackable && <> <Chip tone="info">Stackable</Chip></>}</td><td>{offText(p)}</td><td>{p.variants ? `${p.variants} item${p.variants === 1 ? "" : "s"}` : "Every item"}</td><td className="n">{p.minQty}</td><td>{when(p.validFrom, p.validTo)}</td><td>{p.places.length ? p.places.join(", ") : "All locations"}</td>
            <td><Chip tone={state(p, today).tone}>{state(p, today).label}</Chip></td><td className="n">{w && <Button size="sm" variant="ghost" onClick={() => toggle.mutate(p)}>{p.status === "active" ? "Archive" : "Restore"}</Button>}</td></tr>)}</tbody></table></div>}</Panel>)}
  </>);
}
