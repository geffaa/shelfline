import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Download } from "lucide-react";
import { Button, Callout, Chip, Select } from "@shelfline/ui";
import { api, ApiError, qs } from "../lib/api";
import { addDays, dateTime, money } from "../lib/format";
import { useAuth } from "../state/auth";
import { useBusinessToday, useLens, useLensLock } from "../state/lens";
import { Empty, ErrorBox, Field, PageHeader, Panel, Skeleton, TextInput } from "../ui";

interface Acct { key: string; label: string; code: string | null; name: string | null }
interface DayRow { date: string; status: string; balanced: boolean; unreconciledMinor: number; versions: number; netSalesMinor: number }
interface JLine { account: string; label: string; code: string | null; description: string; debitMinor: number; creditMinor: number }
interface Day { location: string; date: string; netSalesMinor: number; lines: JLine[]; balanced: boolean; unreconciledMinor: number; openRegisters: number; missingAccounts: string[]; pending: JLine[]; status: string; versions: { id: string; version: number; method: string; reference: string; externalRef: string | null; exportedAt: string }[] }
interface Hist { id: string; location: string; date: string; version: number; method: string; reference: string; externalRef: string | null; exportedAt: string }
interface XeroStatus { connected: boolean; tenantId?: string; lastError?: string | null }

const STATUS: Record<string, { label: string; tone?: "ok" | "warn" | "info" }> = { open: { label: "Register open", tone: "warn" }, ready: { label: "Ready to export", tone: "info" }, changed: { label: "Changed since export", tone: "warn" }, exported: { label: "Exported", tone: "ok" }, empty: { label: "Nothing to export" } };
const ERR: Record<string, string> = { day_not_closed: "A register is still open for that day. Close it first.", mapping_missing: "Some accounts have no code yet. Fill them in under Chart of accounts.", xero_not_connected: "Xero is not connected.", xero_failed: "Xero did not accept the journal. Nothing was recorded; try again." };

function Mapping() {
  const qc = useQueryClient(); const q = useQuery({ queryKey: ["acct-map"], queryFn: () => api<Acct[]>("/accounting/accounts") }); const [draft, setDraft] = useState<Record<string, string>>({}); const [err, setErr] = useState<string | null>(null);
  const save = useMutation({ mutationFn: () => api("/accounting/accounts", { method: "PUT", body: { items: Object.entries(draft).filter(([, c]) => c.trim()).map(([key, code]) => ({ key, code })) } }), onSuccess: () => { setDraft({}); void qc.invalidateQueries({ queryKey: ["acct-map"] }); void qc.invalidateQueries({ queryKey: ["acct-day"] }); }, onError: () => setErr("Could not save the account codes.") });
  return (
    <Panel title="Chart of accounts" right={<Button variant="primary" disabled={!Object.keys(draft).length || save.isPending} onClick={() => { setErr(null); save.mutate(); }}>Save codes</Button>}>
      {q.isLoading ? <Skeleton rows={4} /> : q.isError ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : (
        <div className="grid2">{q.data!.map((a) => <Field key={a.key} id={`acct-${a.key}`} label={a.label}><TextInput id={`acct-${a.key}`} value={draft[a.key] ?? a.code ?? ""} onChange={(v) => setDraft({ ...draft, [a.key]: v })} placeholder="Account code" /></Field>)}</div>
      )}
      {err && <p className="err" role="alert">{err}</p>}
    </Panel>
  );
}

function XeroPanel() {
  const qc = useQueryClient(); const q = useQuery({ queryKey: ["xero"], queryFn: () => api<XeroStatus>("/accounting/xero") }); const [f, setF] = useState({ tenantId: "", accessToken: "", refreshToken: "", clientId: "", clientSecret: "" }); const [open, setOpen] = useState(false); const [err, setErr] = useState<string | null>(null);
  const done = () => { void qc.invalidateQueries({ queryKey: ["xero"] }); };
  const connect = useMutation({ mutationFn: () => api("/accounting/xero", { method: "PUT", body: f }), onSuccess: () => { setOpen(false); setF({ tenantId: "", accessToken: "", refreshToken: "", clientId: "", clientSecret: "" }); done(); }, onError: (e) => setErr(e instanceof ApiError && e.status === 400 ? "Check the details; Xero did not accept them." : "Could not connect to Xero.") });
  const disconnect = useMutation({ mutationFn: () => api("/accounting/xero", { method: "DELETE" }), onSuccess: done });
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });
  return (
    <Panel title="Xero" right={q.data?.connected ? <Chip tone="ok">Connected</Chip> : <Chip>Not connected</Chip>}>
      {q.isLoading ? <Skeleton rows={2} /> : q.data?.connected && !open ? (
        <div className="row-flex"><span className="muted">Organisation {q.data.tenantId}. Journals are created as drafts for you to review in Xero.</span><span className="grow" /><Button onClick={() => setOpen(true)}>Replace credentials</Button><Button variant="ghost" onClick={() => disconnect.mutate()}>Disconnect</Button></div>
      ) : !open ? (
        <div className="row-flex"><span className="muted">Not connected. You can still download each day as a CSV and import it.</span><span className="grow" /><Button onClick={() => setOpen(true)}>Connect Xero</Button></div>
      ) : (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); setErr(null); connect.mutate(); }}>
          <div className="grid2"><Field id="x-tenant" label="Tenant id"><TextInput id="x-tenant" value={f.tenantId} onChange={set("tenantId")} /></Field><Field id="x-client" label="Client id"><TextInput id="x-client" value={f.clientId} onChange={set("clientId")} /></Field>
            <Field id="x-secret" label="Client secret"><TextInput id="x-secret" type="password" value={f.clientSecret} onChange={set("clientSecret")} /></Field><Field id="x-access" label="Access token"><TextInput id="x-access" type="password" value={f.accessToken} onChange={set("accessToken")} /></Field>
            <Field id="x-refresh" label="Refresh token"><TextInput id="x-refresh" type="password" value={f.refreshToken} onChange={set("refreshToken")} /></Field></div>
          {err && <p className="err" role="alert">{err}</p>}
          <div className="row-flex"><Button onClick={() => setOpen(false)}>Cancel</Button><span className="grow" /><Button variant="primary" type="submit" disabled={connect.isPending || Object.values(f).some((v) => v.trim().length < 4)}>Save connection</Button></div>
        </form>
      )}
      {q.data?.lastError && <p className="muted">Last problem: {q.data.lastError}</p>}
    </Panel>
  );
}

function DayDetail({ locationId, date, xero }: { locationId: string; date: string; xero: boolean }) {
  const qc = useQueryClient(); const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const q = useQuery({ queryKey: ["acct-day", locationId, date], queryFn: () => api<Day>(`/accounting/day${qs({ locationId, date })}`) });
  const run = useMutation({
    mutationFn: (method: "xero" | "csv") => api<{ status: string; version: number; reference?: string; csv?: string }>("/accounting/export", { method: "POST", body: { locationId, date, method } }).then((r) => ({ ...r, method })),
    onSuccess: (r) => {
      if (r.status === "unchanged") setMsg({ ok: true, text: "Nothing has changed since the last export." });
      else { setMsg({ ok: true, text: r.method === "xero" ? `Sent to Xero as ${r.reference} (draft).` : `Exported as ${r.reference}.` }); if (r.csv) { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([r.csv], { type: "text/csv" })); a.download = `${r.reference}.csv`; a.click(); } }
      void qc.invalidateQueries({ queryKey: ["acct-day"] }); void qc.invalidateQueries({ queryKey: ["acct-days"] }); void qc.invalidateQueries({ queryKey: ["acct-hist"] });
    },
    onError: (e) => setMsg({ ok: false, text: ERR[e instanceof ApiError ? e.code : ""] ?? "Could not export this day." }),
  });
  if (q.isLoading) return <Skeleton rows={5} />; if (q.isError) return <ErrorBox error={q.error} retry={() => q.refetch()} />;
  const d = q.data!; const show = d.versions.length ? d.pending : d.lines; const st = STATUS[d.status]!; const blocked = d.status === "open" || d.status === "empty" || d.status === "exported";
  return (
    <Panel title={<>{d.location} · {d.date} <Chip tone={st.tone}>{st.label}</Chip></>} right={<span className="row-flex"><Button disabled={blocked || run.isPending} onClick={() => { setMsg(null); run.mutate("csv"); }}><Download size={16} /> Download CSV</Button><Button variant="primary" disabled={blocked || !xero || run.isPending} onClick={() => { setMsg(null); run.mutate("xero"); }}>Export to Xero</Button></span>}>
      {d.openRegisters > 0 && <Callout tone="warn">{d.openRegisters} register{d.openRegisters > 1 ? "s are" : " is"} still open. A day can be exported once every register is closed.</Callout>}
      {d.missingAccounts.length > 0 && <Callout tone="warn">No account code for: {d.missingAccounts.join(", ")}.</Callout>}
      {d.unreconciledMinor !== 0 && <Callout tone="info">{money(Math.abs(d.unreconciledMinor))} could not be matched to a tender and is held in the suspense account.</Callout>}
      {msg && <p className={msg.ok ? "muted" : "err"} role={msg.ok ? "status" : "alert"}>{msg.text}</p>}
      {show.length === 0 ? <Empty title="Nothing to post">There is no activity to post for this day.</Empty> : (
        <div className="tbl-wrap"><table className="tbl" data-testid="journal-table"><caption className="muted">{d.versions.length ? "Adjustment since the last export" : "Journal preview"}</caption><thead><tr><th>Account</th><th>Code</th><th>Description</th><th className="n">Debit</th><th className="n">Credit</th></tr></thead>
          <tbody>{show.map((l, i) => <tr key={i}><td>{l.label}</td><td>{l.code ?? <span className="muted">—</span>}</td><td>{l.description}</td><td className="n">{l.debitMinor ? money(l.debitMinor) : ""}</td><td className="n">{l.creditMinor ? money(l.creditMinor) : ""}</td></tr>)}</tbody>
          <tfoot><tr><td colSpan={3}><b>{d.balanced ? "Balanced" : "Out of balance"}</b></td><td className="n"><b>{money(show.reduce((a, l) => a + l.debitMinor, 0))}</b></td><td className="n"><b>{money(show.reduce((a, l) => a + l.creditMinor, 0))}</b></td></tr></tfoot></table></div>
      )}
      {d.versions.length > 0 && <p className="muted">Sent: {d.versions.map((v) => `${v.reference} (${v.method})`).join(", ")}</p>}
    </Panel>
  );
}

export function Accounting() {
  useLensLock(false);
  const { can } = useAuth(); const { locations, selected } = useLens(); const today = useBusinessToday(); const stores = locations.filter((l) => l.type === "store"); const [loc, setLoc] = useState<string | null>(null); const [date, setDate] = useState<string | null>(null);
  const locationId = loc ?? (selected?.type === "store" ? selected.id : undefined) ?? stores[0]?.id; const xero = useQuery({ queryKey: ["xero"], queryFn: () => api<XeroStatus>("/accounting/xero") });
  const days = useQuery({ queryKey: ["acct-days", locationId, today], enabled: !!locationId, queryFn: () => api<DayRow[]>(`/accounting/days${qs({ locationId, from: addDays(today, -13), to: today })}`) });
  const hist = useQuery({ queryKey: ["acct-hist"], queryFn: () => api<Hist[]>("/accounting/exports") }); const picked = date ?? days.data?.find((d) => d.status !== "empty" && d.status !== "open")?.date ?? days.data?.find((d) => d.status !== "empty")?.date ?? today;
  if (!can("accounting:manage", null)) return <Empty title="Nothing here">Accounting is for owners and finance.</Empty>;
  return (<>
    <PageHeader title="Accounting" sub="Each closed day becomes a balanced journal for your books" />
    <div className="split">
    <Panel title="Days" right={stores.length > 1 && locationId ? <Select label="Store" value={locationId} onChange={(v) => { setLoc(v); setDate(null); }} options={stores.map((l) => ({ value: l.id, label: l.name }))} chevron={<ChevronDown size={16} />} /> : undefined} flush>
      {days.isLoading ? <Skeleton rows={5} /> : days.isError ? <ErrorBox error={days.error} retry={() => days.refetch()} /> : (
        <div className="tbl-wrap"><table className="tbl" data-testid="days-table"><thead><tr><th>Day</th><th className="n">Net sales</th><th>Status</th><th /></tr></thead>
          <tbody>{days.data!.map((d) => <tr key={d.date} aria-selected={d.date === picked}><td>{d.date}</td><td className="n">{money(d.netSalesMinor)}</td><td><Chip tone={STATUS[d.status]?.tone}>{STATUS[d.status]?.label ?? d.status}</Chip></td><td className="n"><Button size="sm" onClick={() => setDate(d.date)} aria-label={`Open ${d.date}`}>Open</Button></td></tr>)}</tbody></table></div>
      )}
    </Panel>
      {locationId && <DayDetail key={`${locationId}-${picked}`} locationId={locationId} date={picked} xero={!!xero.data?.connected} />}
    </div>
    <XeroPanel /><Mapping />
    <Panel title="Export history" flush>
      {hist.isLoading ? <Skeleton rows={3} /> : hist.data!.length === 0 ? <Empty title="Nothing exported yet">Exports appear here, one row per journal.</Empty> : (
        <div className="tbl-wrap"><table className="tbl" data-testid="export-history"><thead><tr><th>Reference</th><th>Store</th><th>Day</th><th>Sent via</th><th>When</th></tr></thead>
          <tbody>{hist.data!.map((h) => <tr key={h.id}><td><b>{h.reference}</b></td><td>{h.location}</td><td>{h.date}</td><td>{h.method === "xero" ? "Xero" : "CSV"}</td><td>{dateTime(h.exportedAt)}</td></tr>)}</tbody></table></div>
      )}
    </Panel>
  </>);
}
