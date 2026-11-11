import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { Button, Callout, Chip, Segmented, Select, Switch } from "@shelfline/ui";
import { api, ApiError } from "../lib/api";
import { navigate, useRoute } from "../router";
import { useAuth } from "../state/auth";
import { useLens, useLensLock } from "../state/lens";
import { Empty, ErrorBox, PageHeader, Panel, Skeleton } from "../ui";
import { countChip, optText, VariantPicker } from "./buy";

interface Row { id: string; number: string; mode: string; blind: boolean; status: string; location: string; lines: number; counted: number; createdAt: string }

function NewCount({ onDone }: { onDone: (id: string) => void }) {
  const qc = useQueryClient(); const { locations } = useLens(); const { can } = useAuth(); const cats = useQuery({ queryKey: ["categories"], queryFn: () => api<{ id: string; name: string }[]>("/categories") });
  const places = locations.filter((l) => (l.type === "store" || l.type === "warehouse") && can("inventory:write", l.id)); const [loc, setLoc] = useState<string | null>(places.length === 1 ? places[0]!.id : null); const [mode, setMode] = useState<"full" | "cycle">("full"); const [cat, setCat] = useState<string | null>(null); const [blind, setBlind] = useState(true); const [err, setErr] = useState<string | null>(null);
  const save = useMutation({ mutationFn: () => api<{ id: string }>("/stock-counts", { method: "POST", body: { locationId: loc, mode, blind, ...(mode === "cycle" ? { categoryId: cat } : {}) } }), onSuccess: (c) => { void qc.invalidateQueries({ queryKey: ["counts"] }); onDone(c.id); },
    onError: (e) => setErr(e instanceof ApiError && e.code === "nothing_to_count" ? "There is nothing to count there yet." : "Could not start the count.") });
  return (
    <Panel title="New stock count">
      <form className="stack" onSubmit={(e) => { e.preventDefault(); setErr(null); save.mutate(); }}>
        <div className="grid2"><Select label="Location" value={loc} onChange={setLoc} options={places.map((l) => ({ value: l.id, label: l.name }))} placeholder="Choose a location" chevron={<ChevronDown size={16} />} />
          <Segmented label="Kind of count" value={mode} onChange={setMode} options={[{ value: "full", label: "Full count" }, { value: "cycle", label: "Cycle count" }]} /></div>
        {mode === "cycle" && <Select label="Category" value={cat} onChange={setCat} options={(cats.data ?? []).map((c) => ({ value: c.id, label: c.name }))} placeholder="Count one category" chevron={<ChevronDown size={16} />} />}
        <Switch checked={blind} onChange={setBlind}>Blind count: counters do not see the expected quantities</Switch>
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>The system's quantities are frozen now. Sales and deliveries while you count are kept; only the difference between what is counted and what was expected is adjusted.</p>
        {err && <p className="err" role="alert">{err}</p>}
        <div className="row-flex"><Button onClick={() => onDone("")}>Cancel</Button><span className="grow" /><Button variant="primary" type="submit" disabled={!loc || (mode === "cycle" && !cat) || save.isPending}>Start counting</Button></div>
      </form>
    </Panel>
  );
}

function Detail({ id }: { id: string }) {
  const qc = useQueryClient(); const [typed, setTyped] = useState<Record<string, string>>({}); const [err, setErr] = useState<string | null>(null); const [uncounted, setUncounted] = useState<"skip" | "zero">("skip"); const [msg, setMsg] = useState<string | null>(null); const [q, setQ] = useState("");
  const c = useQuery({ queryKey: ["count", id], queryFn: () => api<any>(`/stock-counts/${id}`) });
  useEffect(() => { setTyped({}); }, [id]);
  const refresh = () => { setErr(null); void qc.invalidateQueries({ queryKey: ["count", id] }); void qc.invalidateQueries({ queryKey: ["counts"] }); void qc.invalidateQueries({ queryKey: ["inventory"] }); };
  const dirty = Object.entries(typed).filter(([, v]) => /^\d{1,7}$/.test(v.trim()));
  const save = useMutation({ mutationFn: (extra?: { variantId: string; countedQty: number }[]) => api<any>(`/stock-counts/${id}/lines`, { method: "PUT", body: { lines: [...dirty.map(([variantId, v]) => ({ variantId, countedQty: Number(v) })), ...(extra ?? [])] } }), onSuccess: () => { setTyped({}); setMsg("Counts saved."); refresh(); }, onError: () => setErr("Could not save the counts.") });
  const act = useMutation({ mutationFn: async (a: string) => { if (a === "submit" && dirty.length) await save.mutateAsync(undefined); return api<any>(`/stock-counts/${id}/${a}`, { method: "POST", body: a === "commit" ? { uncounted: c.data!.lines.some((l: any) => l.counted === null) ? uncounted : undefined } : undefined }); },
    onSuccess: (r, a) => { setMsg(a === "commit" ? `Committed: ${r.adjusted} item${r.adjusted === 1 ? "" : "s"} adjusted, net ${r.netUnits > 0 ? "+" : ""}${r.netUnits} units.` : null); refresh(); },
    onError: (e) => setErr(e instanceof ApiError && e.code === "insufficient_stock" ? "An adjustment would take an item below zero, because it sold after the snapshot. Go back to counting and recount that item." : e instanceof ApiError && e.code === "uncounted_lines" ? "Some items were not counted." : "That is not possible right now.") });
  const lines: any[] = c.data?.lines ?? []; const shown = useMemo(() => { const n = q.trim().toLowerCase(); return n ? lines.filter((l) => `${l.title} ${l.sku} ${optText(l.options)}`.toLowerCase().includes(n)) : lines; }, [lines, q]);
  if (c.isLoading) return <Panel><Skeleton rows={8} /></Panel>; if (c.isError) return <ErrorBox error={c.error} retry={() => c.refetch()} />; const d = c.data!; const counting = d.status === "counting"; const review = d.status === "review";
  const uncountedN = lines.filter((l) => l.counted === null && !(typed[l.variantId] ?? "").trim()).length; const net = lines.reduce((a, l) => a + (l.variance ?? 0), 0);
  return (
    <section className="panel detail" aria-label={`Count ${d.number}`} data-testid="count-detail" style={{ gridColumn: "1 / -1" }}>
      <div className="drawer-head"><div><h2>{d.number}</h2><div className="muted" style={{ fontSize: 13 }}>{d.location} · {d.mode === "full" ? "full count" : "cycle count"}{d.blind ? " · blind" : ""} · snapshot {new Date(d.snapshotAt).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })}</div></div><span className="row-flex" style={{ gap: 6 }}>{countChip(d.status)}<button className="btn ghost sm" aria-label="Close details" onClick={() => navigate("stock", "counts")}>✕</button></span></div>
      <div className="pb stack">
        {msg && <Callout tone="info"><span>{msg}</span></Callout>}
        {review && d.movedSinceTotal !== 0 && <Callout tone="warn"><span><b>Stock moved while you counted:</b> {d.movedSinceTotal > 0 ? "+" : ""}{d.movedSinceTotal} units net since the snapshot (sales, deliveries). Those are kept; only the count difference is adjusted.</span></Callout>}
        {counting && d.hidden && <p className="muted" style={{ margin: 0 }}>Blind count: expected quantities are hidden until the count is submitted.</p>}
        <div className="filters"><label className="input" style={{ minWidth: 240 }}><input aria-label="Filter items" placeholder="Filter items" value={q} onChange={(e) => setQ(e.target.value)} /></label>
          {counting && <div style={{ minWidth: 280 }}><VariantPicker label="Add an item that was not expected" onPick={(v) => save.mutate([{ variantId: v.id, countedQty: 0 }])} /></div>}</div>
        <div className="tbl-wrap" style={{ maxHeight: 520, overflow: "auto" }}><table className="tbl" data-testid="count-table"><thead><tr><th>Item</th>{!d.hidden && <th className="n">Expected</th>}<th className="n">Counted</th>{!d.hidden && <><th className="n">Variance</th><th className="n">Moved since</th></>}</tr></thead>
          <tbody>{shown.map((l) => { const v = typed[l.variantId]; return (
            <tr key={l.variantId}><td><b>{l.title}</b>{l.unexpected && <> <Chip tone="info">Not expected</Chip></>}<br /><span className="muted" style={{ fontSize: 12.5 }}>{optText(l.options)} · {l.sku}</span></td>
              {!d.hidden && <td className="n">{l.expected}</td>}
              <td className="n">{counting ? <label className="input" style={{ width: 84, marginLeft: "auto" }}><input aria-label={`Counted ${l.sku}`} inputMode="numeric" value={v ?? (l.counted ?? "")} onChange={(e) => setTyped((t) => ({ ...t, [l.variantId]: e.target.value }))} /></label> : l.counted ?? <span className="muted">—</span>}</td>
              {!d.hidden && <><td className={`n${l.variance ? " neg" : ""}`}>{l.variance === null ? "—" : l.variance > 0 ? `+${l.variance}` : l.variance}</td><td className="n">{l.movedSince ? (l.movedSince > 0 ? `+${l.movedSince}` : l.movedSince) : "—"}</td></>}</tr>); })}</tbody></table></div>
        {review && <div className="lead total"><span>Net adjustment</span><i /><b data-testid="count-net">{net > 0 ? "+" : ""}{net} units</b></div>}
        {err && <p className="err" role="alert">{err}</p>}
        {counting && <div className="row-flex"><Button onClick={() => act.mutate("cancel")} variant="ghost">Cancel count</Button><span className="grow" /><span className="muted">{lines.length - uncountedN} of {lines.length} counted</span><Button disabled={dirty.length === 0 || save.isPending} onClick={() => save.mutate(undefined)}>Save counts</Button><Button variant="primary" disabled={act.isPending} onClick={() => act.mutate("submit")}>Submit for review</Button></div>}
        {review && <>
          {lines.some((l) => l.counted === null) && <Segmented label="Items nobody counted" value={uncounted} onChange={setUncounted} options={[{ value: "skip", label: "Leave as they are" }, { value: "zero", label: "Count as zero" }]} />}
          <div className="row-flex"><Button variant="ghost" onClick={() => act.mutate("cancel")}>Cancel count</Button><Button onClick={() => act.mutate("reopen")}>Back to counting</Button><span className="grow" /><Button variant="primary" disabled={act.isPending} onClick={() => act.mutate("commit")}>Commit adjustments</Button></div></>}
      </div>
    </section>
  );
}

const VIEWS = [{ value: "open", label: "Open" }, { value: "committed", label: "Committed" }, { value: "all", label: "All" }] as const;
export function StockCounts() {
  useLensLock(false);
  const { lens, selected } = useLens(); const route = useRoute(); const { canAny } = useAuth(); const [view, setView] = useState<(typeof VIEWS)[number]["value"]>("open"); const [creating, setCreating] = useState(false); const sel = route.id;
  const list = useQuery({ queryKey: ["counts", lens], queryFn: () => api<Row[]>(`/stock-counts${lens === "all" ? "" : `?locationId=${lens}`}`) });
  const rows = useMemo(() => (list.data ?? []).filter((r) => view === "all" || (view === "open" ? ["counting", "review"].includes(r.status) : r.status === "committed")), [list.data, view]);
  return (<>
    <PageHeader title="Stock counts" sub={<>{lens === "all" ? "All locations" : selected?.name} · count what is on the shelf; the ledger is adjusted by the difference</>} actions={canAny("inventory:write") && <Button variant="primary" onClick={() => setCreating(true)}>New count</Button>} />
    <div className="filters"><Segmented label="Show" value={view} onChange={setView} options={VIEWS.map((v) => ({ value: v.value, label: v.label }))} /></div>
    {creating && <NewCount onDone={(id) => { setCreating(false); if (id) navigate("stock", "counts", id); }} />}
    {sel ? <Detail id={sel} /> : (
      <Panel flush>{list.isLoading ? <Skeleton rows={5} /> : list.isError ? <ErrorBox error={list.error} retry={() => list.refetch()} /> : rows.length === 0 ? <Empty title="No counts here">{view === "open" ? "Start a count to check the shelf against the ledger." : "Nothing matches."}</Empty> :
        <div className="tbl-wrap"><table className="tbl" data-testid="counts-table"><thead><tr><th>Count</th><th>Location</th><th>Kind</th><th className="n">Counted</th><th>Status</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id} className="clickable" tabIndex={0} onClick={() => navigate("stock", "counts", r.id)} onKeyDown={(e) => { if (e.key === "Enter") navigate("stock", "counts", r.id); }}>
            <td><b className="mono">{r.number}</b></td><td>{r.location}</td><td>{r.mode === "full" ? "Full" : "Cycle"}{r.blind && " · blind"}</td><td className="n">{r.counted} / {r.lines}</td><td>{countChip(r.status)}</td></tr>)}</tbody></table></div>}
      </Panel>)}
  </>);
}
