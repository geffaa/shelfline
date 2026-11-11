import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Calendar, Check, ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react";
import { Button, Callout, Checkbox, Chip, DatePicker, Segmented, Stepper, Switch } from "@shelfline/ui";
import { api, ApiError } from "../lib/api";
import { dateTime, plain } from "../lib/format";
import { useAuth } from "../state/auth";
import { useBusinessToday, useLens, useLensLock } from "../state/lens";
import { Empty, ErrorBox, Field, PageHeader, Panel, Skeleton, TextInput } from "../ui";

interface Cat { key: string; title: string; description: string; groupBys: string[]; columns: { key: string; label: string; sensitive: boolean }[] }
interface Grant { id: string; grantee: string; email: string; reportKeys: string[]; locations: string[] | null; rangeKind: "fixed" | "rolling"; rangeFrom: string | null; rangeTo: string | null; rollingDays: number | null; hiddenColumns: string[]; expiresAt: string | null; status: string; views: number; lastViewAt: string | null }
interface Run { title: string; groupBy: string | null; columns: { key: string; label: string; kind: string }[]; rows: Record<string, unknown>[]; totals: Record<string, number> | null; scope: { from: string; to: string; clamped: boolean; empty: boolean; locations: string[] | null; hiddenColumns: string[] } }
const label = (c: Cat[] | undefined, key: string) => c?.find((x) => x.key === key)?.title ?? key;
const colLabel = (c: Cat[] | undefined, key: string) => c?.flatMap((x) => x.columns).find((x) => x.key === key)?.label ?? key;
const windowText = (g: Grant) => (g.rangeKind === "fixed" ? `${g.rangeFrom} to ${g.rangeTo}` : `Last ${g.rollingDays} day${g.rollingDays === 1 ? "" : "s"}, moving`);
const STATUS: Record<string, { label: string; tone?: "ok" | "warn" | "danger" }> = { active: { label: "Active", tone: "ok" }, revoked: { label: "Revoked", tone: "danger" }, expired: { label: "Expired", tone: "warn" } };
export const cell = (c: { key: string; kind: string }, v: unknown) => (c.kind === "money" ? plain(Number(v ?? 0)) : String(v ?? ""));

function Form({ cat, onDone }: { cat: Cat[]; onDone: () => void }) {
  const qc = useQueryClient(); const { locations } = useLens(); const today = useBusinessToday(); const stores = locations.filter((l) => l.type === "store");
  const [email, setEmail] = useState(""); const [name, setName] = useState(""); const [reports, setReports] = useState<string[]>(["sales"]); const [allLoc, setAllLoc] = useState(false); const [locs, setLocs] = useState<string[]>([]);
  const [kind, setKind] = useState<"fixed" | "rolling">("fixed"); const [from, setFrom] = useState(`${today.slice(0, 8)}01`); const [to, setTo] = useState(today); const [days, setDays] = useState(30);
  const sensitive = cat.flatMap((c) => c.columns).filter((c) => c.sensitive).map((c) => c.key); const [hidden, setHidden] = useState<string[]>(sensitive); const [exp, setExp] = useState(false); const [expOn, setExpOn] = useState(today); const [err, setErr] = useState<string | null>(null);
  const cols = [...new Map(cat.filter((c) => reports.includes(c.key)).flatMap((c) => c.columns).map((c) => [c.key, c])).values()];
  const toggle = (arr: string[], set: (v: string[]) => void, k: string, on: boolean) => set(on ? [...new Set([...arr, k])] : arr.filter((x) => x !== k));
  const save = useMutation({
    mutationFn: () => api("/report-grants", { method: "POST", body: { email: email.trim(), name: name.trim() || undefined, reportKeys: reports, locationIds: allLoc ? null : locs, rangeKind: kind, ...(kind === "fixed" ? { rangeFrom: from, rangeTo: to } : { rollingDays: days }), hiddenColumns: hidden.filter((h) => cols.some((c) => c.key === h)), expiresAt: exp ? new Date(`${expOn}T23:59:59`).toISOString() : null } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["report-grants"] }); onDone(); },
    onError: (e) => setErr(e instanceof ApiError && e.status === 400 ? "Check the email address, the reports and the dates." : "Could not save the access."),
  });
  const ready = /.+@.+\..+/.test(email) && reports.length > 0 && (allLoc || locs.length > 0) && (kind === "rolling" || from <= to);
  return (
    <Panel title="Give someone access to reports">
      <form className="stack" aria-label="Report access" onSubmit={(e) => { e.preventDefault(); setErr(null); save.mutate(); }}>
        <div className="grid2"><Field id="ra-email" label="Email" hint="They sign in with a one-time code sent here"><TextInput id="ra-email" type="email" value={email} onChange={setEmail} placeholder="accountant@firm.com" /></Field><Field id="ra-name" label="Name"><TextInput id="ra-name" value={name} onChange={setName} placeholder="Ines Walker" /></Field></div>
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}><legend className="lbl">Reports</legend>{cat.map((c) => <Checkbox key={c.key} checked={reports.includes(c.key)} onChange={(on) => toggle(reports, setReports, c.key, on)} checkIcon={<Check size={14} />}><b>{c.title}</b> <span className="muted">{c.description}</span></Checkbox>)}</fieldset>
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}><legend className="lbl">Locations</legend><Switch checked={allLoc} onChange={setAllLoc}>All locations, including ones opened later</Switch>
          {!allLoc && <div className="pill-row">{stores.map((l) => <Checkbox key={l.id} checked={locs.includes(l.id)} onChange={(on) => toggle(locs, setLocs, l.id, on)} checkIcon={<Check size={14} />}>{l.name}</Checkbox>)}</div>}</fieldset>
        <div className="stack"><span className="lbl">Dates they can see</span><Segmented label="Window" value={kind} onChange={setKind} options={[{ value: "fixed", label: "Fixed dates" }, { value: "rolling", label: "Rolling days" }]} />
          {kind === "fixed" ? <div className="grid2"><DatePicker label="From" value={from} onChange={(v) => { setFrom(v); if (v > to) setTo(v); }} today={today} icon={<Calendar size={16} />} prevIcon={<ChevronLeft size={16} />} nextIcon={<ChevronRight size={16} />} /><DatePicker label="To" value={to} onChange={(v) => { setTo(v); if (v < from) setFrom(v); }} today={today} icon={<Calendar size={16} />} prevIcon={<ChevronLeft size={16} />} nextIcon={<ChevronRight size={16} />} /></div>
            : <div className="row-flex"><Stepper label="Days" value={days} min={1} max={366} onChange={setDays} decrementIcon={<Minus size={16} />} incrementIcon={<Plus size={16} />} /><span className="muted">days ending today, moving forward each day</span></div>}</div>
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}><legend className="lbl">Hide these columns</legend><div className="pill-row">{cols.filter((c) => c.key !== "label").map((c) => <Checkbox key={c.key} checked={hidden.includes(c.key)} onChange={(on) => toggle(hidden, setHidden, c.key, on)} checkIcon={<Check size={14} />}>{c.label}{c.sensitive ? " · sensitive" : ""}</Checkbox>)}</div>
          <p className="muted" style={{ margin: 0 }}>Hiding cost of goods also hides margin, because margin gives cost away.</p></fieldset>
        <Switch checked={exp} onChange={setExp}>Access ends on a date</Switch>{exp && <DatePicker label="Access ends" value={expOn} onChange={setExpOn} today={today} min={today} icon={<Calendar size={16} />} prevIcon={<ChevronLeft size={16} />} nextIcon={<ChevronRight size={16} />} />}
        {err && <p className="err" role="alert">{err}</p>}
        <div className="row-flex"><Button type="button" onClick={onDone}>Cancel</Button><span className="grow" /><Button variant="primary" type="submit" disabled={!ready || save.isPending}>Give access and send invite</Button></div>
      </form>
    </Panel>
  );
}

function Preview({ g, cat, onClose }: { g: Grant; cat: Cat[] | undefined; onClose: () => void }) {
  const [key, setKey] = useState(g.reportKeys[0]!); const def = cat?.find((c) => c.key === key); const [groupBy, setGroupBy] = useState<string>("day");
  const q = useQuery({ queryKey: ["grant-preview", g.id, key, groupBy], queryFn: () => api<Run>(`/report-grants/${g.id}/preview/${key}?${new URLSearchParams(def?.groupBys.length ? { groupBy } : {})}`) });
  return (
    <Panel title={`What ${g.grantee} would see`} right={<Button size="sm" aria-label="Close preview" onClick={onClose}>Close</Button>}>
      <div className="stack">
        {g.reportKeys.length > 1 && <Segmented label="Report" value={key} onChange={setKey} options={g.reportKeys.map((k) => ({ value: k, label: label(cat, k) }))} />}
        {def?.groupBys.length ? <Segmented label="Group by" value={groupBy} onChange={setGroupBy} options={def.groupBys.map((x) => ({ value: x, label: x[0]!.toUpperCase() + x.slice(1) }))} /> : null}
        {q.isLoading ? <Skeleton rows={4} /> : q.isError ? <ErrorBox error={q.error} /> : <>
          <div className="callout info" data-testid="preview-banner"><div><b>{q.data!.scope.locations ? q.data!.scope.locations.join(", ") || "No locations" : "All locations"}</b> · {q.data!.scope.from} to {q.data!.scope.to}{q.data!.scope.hiddenColumns.length ? ` · hidden: ${q.data!.scope.hiddenColumns.map((c) => colLabel(cat, c).toLowerCase()).join(", ")}` : ""}</div></div>
          {q.data!.rows.length === 0 ? <Empty title="Nothing in this window" /> : <div className="tbl-wrap"><table className="tbl" data-testid="preview-table"><thead><tr>{q.data!.columns.map((c) => <th key={c.key} className={c.kind === "text" ? "" : "n"}>{c.label || (q.data!.groupBy ?? "")}</th>)}</tr></thead>
            <tbody>{q.data!.rows.map((r, i) => <tr key={i}>{q.data!.columns.map((c) => <td key={c.key} className={c.kind === "text" ? "" : "n"}>{cell(c, r[c.key])}</td>)}</tr>)}</tbody></table></div>}</>}
      </div>
    </Panel>
  );
}

function Views({ g, onClose }: { g: Grant; onClose: () => void }) {
  const q = useQuery({ queryKey: ["grant-views", g.id], queryFn: () => api<{ id: number; at: string; reportKey: string; format: string; requested: { from?: string; to?: string; locationId?: string }; served: { from: string; to: string; clamped: boolean }; rows: number }[]>(`/report-grants/${g.id}/views`) });
  return (
    <Panel title={`Views by ${g.grantee}`} right={<Button size="sm" aria-label="Close views" onClick={onClose}>Close</Button>} flush>
      {q.isLoading ? <Skeleton rows={3} /> : q.data!.length === 0 ? <Empty title="Not opened yet">Each time they open a report it is listed here.</Empty> :
        <div className="tbl-wrap"><table className="tbl" data-testid="views-table"><thead><tr><th>When</th><th>Report</th><th>Asked for</th><th>Shown</th><th className="n">Rows</th></tr></thead><tbody>
          {q.data!.map((v) => <tr key={v.id}><td>{dateTime(v.at)}</td><td>{v.reportKey}{v.format === "csv" ? " · CSV" : ""}</td><td className="muted">{v.requested.from ?? "any"} to {v.requested.to ?? "any"}</td><td>{v.served.from} to {v.served.to}{v.served.clamped && <> <Chip tone="info">Cut to window</Chip></>}</td><td className="n">{v.rows}</td></tr>)}</tbody></table></div>}
    </Panel>
  );
}

export function ReportAccess() {
  useLensLock(true);
  const { can } = useAuth(); const qc = useQueryClient(); const owner = can("report:grant", null);
  const [form, setForm] = useState(false); const [prev, setPrev] = useState<Grant | null>(null); const [views, setViews] = useState<Grant | null>(null);
  const cat = useQuery({ queryKey: ["report-catalog"], enabled: owner, queryFn: () => api<Cat[]>("/report-catalog") });
  const list = useQuery({ queryKey: ["report-grants"], enabled: owner, queryFn: () => api<Grant[]>("/report-grants") });
  const revoke = useMutation({ mutationFn: (id: string) => api(`/report-grants/${id}/revoke`, { method: "POST" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["report-grants"] }) });
  if (!owner) return (<><PageHeader title="Report access" /><Empty title="Owners only">Only an owner can decide who sees reports.</Empty></>);
  return (<>
    <PageHeader title="Report access" sub="Give an accountant or area manager a limited view: some reports, some locations, some dates, without the columns you choose." actions={<Button variant="primary" onClick={() => setForm(true)} disabled={!cat.data}>Give access</Button>} />
    {form && cat.data && <Form cat={cat.data} onDone={() => setForm(false)} />}
    {prev && <Preview key={prev.id} g={prev} cat={cat.data} onClose={() => setPrev(null)} />}
    {views && <Views key={views.id} g={views} onClose={() => setViews(null)} />}
    <Panel flush>{list.isLoading ? <Skeleton rows={4} /> : list.isError ? <ErrorBox error={list.error} retry={() => list.refetch()} /> : list.data!.length === 0 ? <Empty title="No one has access yet">Outside readers sign in at the report portal with a one-time code.</Empty> :
      <div className="tbl-wrap"><table className="tbl" data-testid="grants-table"><thead><tr><th>Person</th><th>Reports</th><th>Locations</th><th>Dates</th><th>Hidden</th><th>Status</th><th className="n">Views</th><th /></tr></thead><tbody>
        {list.data!.map((g) => <tr key={g.id}><td><b>{g.grantee}</b><br /><span className="muted" style={{ fontSize: 12 }}>{g.email}</span></td><td>{g.reportKeys.map((k) => label(cat.data, k)).join(", ")}</td><td>{g.locations ? g.locations.join(", ") : "All locations"}</td><td>{windowText(g)}</td>
          <td>{g.hiddenColumns.length ? g.hiddenColumns.map((c) => colLabel(cat.data, c)).join(", ") : <span className="muted">Nothing</span>}</td><td><Chip tone={STATUS[g.status]?.tone}>{STATUS[g.status]?.label ?? g.status}</Chip></td><td className="n">{g.views}</td>
          <td className="n"><Button size="sm" variant="ghost" onClick={() => setPrev(g)}>Preview</Button><Button size="sm" variant="ghost" onClick={() => setViews(g)}>Views</Button>{g.status === "active" && <Button size="sm" variant="ghost" onClick={() => revoke.mutate(g.id)}>Revoke</Button>}</td></tr>)}</tbody></table></div>}</Panel>
    {revoke.isError && <Callout tone="danger"><span>Could not revoke that access.</span></Callout>}
  </>);
}
