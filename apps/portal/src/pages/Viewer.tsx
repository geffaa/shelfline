import { useEffect, useState } from "react";
import { Calendar, ChevronDown, ChevronLeft, ChevronRight, Download } from "lucide-react";
import { Button, DatePicker, Segmented, Select } from "@shelfline/ui";
import { api, ApiError, day, plain, qs, range } from "../lib/api";
import { useFetch } from "../lib/use";
import { Empty, Skeleton } from "../ui";
import { hiddenText, type PortalGrant } from "./MyReports";

interface Run { title: string; groupBy: string | null; columns: { key: string; label: string; kind: string }[]; rows: Record<string, unknown>[]; totals: Record<string, number> | null; scope: { from: string; to: string; clamped: boolean; empty: boolean; locations: string[] | null; hiddenColumns: string[] } }
const cell = (c: { key: string; kind: string }, v: unknown) => (c.kind === "money" ? plain(Number(v ?? 0)) : String(v ?? ""));
const GROUPS: Record<string, string> = { day: "Day", location: "Location", product: "Product" };

/** S62: the scope banner never leaves the screen, and the date pickers cannot be moved outside the window. */
export function Viewer({ grantId, reportKey }: { grantId: string; reportKey: string }) {
  const grants = useFetch(() => api<PortalGrant[]>("/portal/grants"), []); const g = grants.data?.find((x) => x.id === grantId);
  const [from, setFrom] = useState<string | null>(null); const [to, setTo] = useState<string | null>(null); const [loc, setLoc] = useState<string | null>(null); const [groupBy, setGroupBy] = useState("day");
  useEffect(() => { if (g) { setFrom(g.window.from); setTo(g.window.to); } }, [g?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const ready = !!g && from !== null && to !== null; const active = g?.status === "active";
  const run = useFetch(() => (ready && active ? api<Run>(`/portal/grants/${grantId}/reports/${reportKey}${qs({ from, to, locationId: loc, groupBy })}`) : Promise.resolve(null as unknown as Run)), [grantId, reportKey, from, to, loc, groupBy, ready, active]);
  const download = async () => { const csv = await api<string>(`/portal/grants/${grantId}/reports/${reportKey}${qs({ from, to, locationId: loc, groupBy, format: "csv" })}`, { raw: true }); const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = `${reportKey}-${from}-${to}.csv`; a.click(); URL.revokeObjectURL(a.href); };
  const back = <a className="back" href="#/"><ChevronLeft size={16} /> My reports</a>;
  if (grants.loading) return <><Skeleton rows={4} /></>;
  if (!g) return <>{back}<Empty title="Report not found">This link is not one of your reports.</Empty></>;
  if (!active || (run.error instanceof ApiError && run.error.status === 410)) {
    const by = run.error instanceof ApiError ? run.error.body?.grantedBy ?? g.grantedBy : g.grantedBy;
    return <>{back}<Empty title="Access ended">{g.endedReason === "expired" || (run.error instanceof ApiError && run.error.body?.reason === "expired") ? "This access has expired." : "This access was withdrawn."} It was given by {by}. Ask them if you still need it.</Empty></>;
  }
  const def = g.reports.find((r) => r.key === reportKey); const d = run.data;
  const showGroups = reportKey === "sales";
  return (<>
    {back}
    <div><h1>{def?.title ?? reportKey}</h1></div>
    <div className="scope-banner" role="status" data-testid="scope-banner">
      <span>{g.locations ? g.locations.join(", ") : "All locations"}</span><span className="dim">·</span><span>{range(g.window.from, g.window.to)}</span>
      {g.hiddenColumns.length > 0 && <span className="tag">{hiddenText(g.hiddenColumns)}</span>}
    </div>
    <div className="filters">
      <DatePicker label="From" value={from ?? g.window.from} onChange={(v) => { setFrom(v); if (to && v > to) setTo(v); }} today={g.window.to} min={g.window.from} max={g.window.to} icon={<Calendar size={16} />} prevIcon={<ChevronLeft size={16} />} nextIcon={<ChevronRight size={16} />} />
      <DatePicker label="To" value={to ?? g.window.to} onChange={(v) => { setTo(v); if (from && v < from) setFrom(v); }} today={g.window.to} min={g.window.from} max={g.window.to} icon={<Calendar size={16} />} prevIcon={<ChevronLeft size={16} />} nextIcon={<ChevronRight size={16} />} />
      {g.locationOptions.length > 1 && <Select label="Location" value={loc ?? "all"} onChange={(v) => setLoc(v === "all" ? null : v)} options={[{ value: "all", label: g.locations ? "All of mine" : "All locations" }, ...g.locationOptions.map((l) => ({ value: l.id, label: l.name }))]} chevron={<ChevronDown size={16} />} />}
      {showGroups && <Segmented label="Group by" value={groupBy} onChange={setGroupBy} options={["day", "location", "product"].map((k) => ({ value: k, label: GROUPS[k]! }))} />}
      <Button onClick={() => void download()} disabled={!d?.rows.length}><Download size={14} /> Download CSV</Button>
    </div>
    <section className="panel">{run.loading && !d ? <Skeleton rows={6} /> : run.error ? <div className="pb"><div className="callout danger" role="alert"><div>Could not load this report.</div></div></div> : !d || d.rows.length === 0 ? <Empty title="Nothing in this period">There is no data for these dates{loc ? " at this location" : ""}.</Empty> :
      <div className="tbl-wrap"><table className="tbl" data-testid="report-table"><thead><tr>{d.columns.map((c) => <th key={c.key} className={c.kind === "text" ? "" : "n"}>{c.label || GROUPS[d.groupBy ?? ""] || ""}</th>)}</tr></thead>
        <tbody>{d.rows.map((r, i) => <tr key={i}>{d.columns.map((c, j) => <td key={c.key} className={c.kind === "text" ? "" : "n"}>{j === 0 && c.key === "label" ? <b>{d.groupBy === "day" ? day(String(r[c.key])) : cell(c, r[c.key])}</b> : cell(c, r[c.key])}</td>)}</tr>)}</tbody>
        {d.totals && <tfoot><tr>{d.columns.map((c, j) => <td key={c.key} className={c.kind === "text" ? "" : "n"}><b>{j === 0 ? "Total" : c.kind === "text" ? "" : cell(c, d.totals![c.key])}</b></td>)}</tr></tfoot>}</table></div>}</section>
    <p className="pt-foot">Refunds are matched to the sale they came from. Amounts are in Australian dollars and include GST unless a column says otherwise.</p>
  </>);
}
