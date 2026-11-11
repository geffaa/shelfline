import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Download, Lock } from "lucide-react";
import { Button, Callout, Chip } from "@shelfline/ui";
import { api, ApiError, API_URL, getToken } from "../lib/api";
import { money, plain } from "../lib/format";
import { useAuth } from "../state/auth";
import { useBusinessToday, useLensLock } from "../state/lens";
import { Empty, ErrorBox, Field, PageHeader, Panel, Skeleton, TextInput } from "../ui";
import { navigate, useRoute } from "../router";

interface Period { id: string; startDate: string; endDate: string; status: string; earnedMinor: number; clawbackMinor: number; adjustMinor: number; netMinor: number; people: number }
interface Person { userId: string; user: string; earnedMinor: number; clawbackMinor: number; adjustMinor: number; netMinor: number; entries: number }
interface Entry { id: string; kind: string; receiptNo: string | null; date: string; location: string | null; item: string | null; baseMinor: number; amountMinor: number; late: boolean; reason: string | null; rateBp: number | null; basis: string | null; splitMode: string | null; ruleVersion: number | null; scopeKind: string | null }
const KIND: Record<string, { label: string; tone?: "ok" | "warn" | "info" }> = { earn: { label: "Earned", tone: "ok" }, clawback: { label: "Clawed back", tone: "warn" }, adjust: { label: "Adjustment", tone: "info" } };
const range = (p: { startDate: string; endDate: string }) => `${p.startDate} to ${p.endDate}`;
const signed = (n: number) => (n === 0 ? "—" : (n > 0 ? "" : "") + plain(n));
const download = async (id: string, name: string) => { const r = await fetch(`${API_URL}/commission/periods/${id}/export`, { headers: { authorization: `Bearer ${getToken()}` } }); const u = URL.createObjectURL(await r.blob()); const a = document.createElement("a"); a.href = u; a.download = name; a.click(); URL.revokeObjectURL(u); };

function Adjust({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient(); const [uid, setUid] = useState(""); const [amt, setAmt] = useState(""); const [why, setWhy] = useState(""); const [err, setErr] = useState<string | null>(null);
  const staff = useQuery({ queryKey: ["staff-names"], queryFn: () => api<{ id: string; name: string }[]>("/users") });
  const cents = Math.round(Number(amt.replace(/[^0-9.-]/g, "")) * 100);
  const save = useMutation({ mutationFn: () => api("/commission/adjustments", { method: "POST", body: { userId: uid, amountMinor: cents, reason: why.trim() } }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["commission-periods"] }); void qc.invalidateQueries({ queryKey: ["commission-statements"] }); onDone(); },
    onError: (e) => setErr(e instanceof ApiError && e.code === "no_open_period" ? "There is no open period to put it in. Add a period first." : "Could not add the adjustment.") });
  return (
    <Panel title="Add an adjustment">
      <form className="stack" aria-label="Adjustment" onSubmit={(e) => { e.preventDefault(); setErr(null); save.mutate(); }}>
        <p className="muted" style={{ margin: 0 }}>Goes into the earliest open period. Closed periods are never changed.</p>
        <Field id="adj-who" label="Person"><div className="chips">{(staff.data ?? []).slice(0, 40).map((s) => <Button key={s.id} type="button" size="sm" variant={uid === s.id ? "primary" : "secondary"} aria-pressed={uid === s.id} onClick={() => setUid(s.id)}>{s.name}</Button>)}</div></Field>
        <div className="grid2"><Field id="adj-amt" label="Amount (A$, negative to take away)"><TextInput id="adj-amt" value={amt} onChange={setAmt} inputMode="decimal" placeholder="-15.00" /></Field><Field id="adj-why" label="Reason"><TextInput id="adj-why" value={why} onChange={setWhy} placeholder="e.g. Store promotion bonus" /></Field></div>
        {err && <p className="err" role="alert">{err}</p>}
        <div className="row-flex"><Button type="button" onClick={onDone}>Cancel</Button><span className="grow" /><Button variant="primary" type="submit" disabled={!uid || !Number.isFinite(cents) || cents === 0 || why.trim().length < 3 || save.isPending}>Add adjustment</Button></div>
      </form>
    </Panel>
  );
}

function Detail({ period, userId, onBack }: { period: Period; userId: string; onBack: () => void }) {
  const q = useQuery({ queryKey: ["commission-detail", period.id, userId], queryFn: () => api<{ user: string; entries: Entry[] }>(`/commission/periods/${period.id}/statements/${userId}`) });
  const tot = (q.data?.entries ?? []).reduce((a, e) => a + e.amountMinor, 0);
  return (<>
    <PageHeader title={q.data?.user ?? "Statement"} sub={<>{range(period)} · every line behind the total</>} actions={<Button onClick={onBack}><ArrowLeft size={16} /> All people</Button>} />
    <Panel flush>{q.isLoading ? <Skeleton rows={6} /> : q.isError ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : q.data!.entries.length === 0 ? <Empty title="Nothing in this period" /> :
      <div className="tbl-wrap"><table className="tbl" data-testid="detail-table"><thead><tr><th>Day</th><th>What</th><th>Receipt</th><th>Item</th><th className="n">Basis</th><th>Rule</th><th className="n">Amount</th></tr></thead><tbody>
        {q.data!.entries.map((e) => <tr key={e.id}><td>{e.date}</td><td><Chip tone={KIND[e.kind]?.tone}>{KIND[e.kind]?.label ?? e.kind}</Chip>{e.late && <> <Chip tone="info">Arrived late</Chip></>}</td><td className="mono">{e.receiptNo ?? "—"}</td><td>{e.item ?? e.reason ?? "—"}</td>
          <td className="n">{e.kind === "adjust" ? "—" : plain(e.baseMinor)}</td><td className="muted">{e.rateBp !== null ? `${(e.rateBp / 100).toFixed(e.rateBp % 100 === 0 ? 0 : 2)}% v${e.ruleVersion}${e.splitMode && e.splitMode !== "seller" ? ` · ${e.splitMode.replace("_", " ")}` : ""}` : "—"}</td><td className={`n ${e.amountMinor < 0 ? "neg" : ""}`}>{plain(e.amountMinor)}</td></tr>)}</tbody>
        <tfoot><tr><th colSpan={6}>Total</th><th className="n">{plain(tot)}</th></tr></tfoot></table></div>}</Panel>
  </>);
}

export function Commission() {
  useLensLock(true);
  const { can } = useAuth(); const route = useRoute(); const qc = useQueryClient(); const canWrite = can("commission:write", null); const canLock = can("commission:lock", null); const today = useBusinessToday();
  const [adj, setAdj] = useState(false); const [msg, setMsg] = useState<string | null>(null); const [newFrom, setNewFrom] = useState(""); const [newTo, setNewTo] = useState(""); const [adding, setAdding] = useState(false); const [err, setErr] = useState<string | null>(null);
  const periods = useQuery({ queryKey: ["commission-periods"], queryFn: () => api<Period[]>("/commission/periods") });
  const recalc = useMutation({ mutationFn: () => api("/commission/recalculate", { method: "POST" }), onSettled: () => { void qc.invalidateQueries({ queryKey: ["commission-periods"] }); void qc.invalidateQueries({ queryKey: ["commission-statements"] }); } });
  useEffect(() => { if (canWrite) recalc.mutate(); /* bring open periods up to date when the page opens */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const sel = periods.data?.find((p) => p.id === route.id) ?? periods.data?.find((p) => p.status === "open" && p.startDate <= today && today <= p.endDate) ?? periods.data?.[0];
  const people = useQuery({ queryKey: ["commission-statements", sel?.id, periods.dataUpdatedAt], enabled: !!sel, queryFn: () => api<{ people: Person[] }>(`/commission/periods/${sel!.id}/statements`) });
  const lock = useMutation({ mutationFn: () => api<{ people: number; netMinor: number }>(`/commission/periods/${sel!.id}/lock`, { method: "POST" }), onSuccess: (r) => { setMsg(`Period closed: ${r.people} statements, ${money(r.netMinor)} in total.`); void qc.invalidateQueries({ queryKey: ["commission-periods"] }); void qc.invalidateQueries({ queryKey: ["commission-statements"] }); },
    onError: (e) => setMsg(e instanceof ApiError ? ({ period_not_ended: "That period has not ended yet.", earlier_period_open: "Close the earlier period first.", already_locked: "Already closed." } as Record<string, string>)[e.code] ?? "Could not close the period." : "Could not close the period.") });
  const add = useMutation({ mutationFn: () => api("/commission/periods", { method: "POST", body: { from: newFrom, to: newTo } }), onSuccess: () => { setAdding(false); recalc.mutate(); },
    onError: (e) => setErr(e instanceof ApiError && e.code === "period_overlap" ? "That overlaps another period." : "Use dates like 2026-11-01, with the end on or after the start.") });
  const user = route.query.get("person");
  if (sel && user) return <Detail period={sel} userId={user} onBack={() => navigate("money", "commission", sel.id)} />;
  const total = (people.data?.people ?? []).reduce((a, p) => a + p.netMinor, 0);
  return (<>
    <PageHeader title="Commission statements" sub={sel ? <>{range(sel)} · {sel.status === "locked" ? "closed" : "open, still changing as sales and refunds arrive"}</> : "Periods group commission for payroll"}
      actions={<>{canWrite && <Button onClick={() => setAdj(true)}>Add adjustment</Button>}{canWrite && <Button onClick={() => setAdding(!adding)}>Add period</Button>}{sel && <Button onClick={() => void download(sel.id, `commission-${sel.startDate}.csv`)}><Download size={16} /> CSV</Button>}{canLock && sel?.status === "open" && <Button variant="primary" disabled={lock.isPending} onClick={() => lock.mutate()}><Lock size={16} /> Close period</Button>}</>} />
    {msg && <Callout tone="info"><span>{msg}</span></Callout>}
    {adj && <Adjust onDone={() => setAdj(false)} />}
    {adding && <Panel title="New period"><form className="stack" aria-label="New period" onSubmit={(e) => { e.preventDefault(); setErr(null); add.mutate(); }}><div className="grid2"><Field id="np-from" label="First day"><TextInput id="np-from" value={newFrom} onChange={setNewFrom} placeholder="2026-11-01" /></Field><Field id="np-to" label="Last day"><TextInput id="np-to" value={newTo} onChange={setNewTo} placeholder="2026-11-14" /></Field></div>
      {err && <p className="err" role="alert">{err}</p>}<div className="row-flex"><span className="grow" /><Button type="submit" variant="primary" disabled={!/^\d{4}-\d{2}-\d{2}$/.test(newFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(newTo) || add.isPending}>Add period</Button></div></form></Panel>}
    {periods.isLoading ? <Skeleton rows={3} /> : periods.isError ? <ErrorBox error={periods.error} retry={() => periods.refetch()} /> : periods.data!.length === 0 ? <Empty title="No periods yet">Add a period to start totalling commission. Sales before the first period earn nothing.</Empty> : <>
      <nav className="subnav" aria-label="Periods" data-testid="period-list" style={{ overflowX: "auto" }}>{periods.data!.map((p) => <a key={p.id} href={`#/money/commission/${p.id}`} aria-current={sel?.id === p.id ? "page" : undefined}>{p.startDate.slice(5)} → {p.endDate.slice(5)} {p.status === "locked" ? "· closed" : "· open"}</a>)}</nav>
      <Panel flush right={sel && <span className="muted">{money(total)} total</span>}>{people.isLoading ? <Skeleton rows={5} /> : people.isError ? <ErrorBox error={people.error} retry={() => people.refetch()} /> : people.data!.people.length === 0 ? <Empty title="No commission in this period">Nothing has been earned yet, or no rule applies.</Empty> :
        <div className="tbl-wrap"><table className="tbl" data-testid="statements-table"><thead><tr><th>Person</th><th className="n">Earned</th><th className="n">Clawed back</th><th className="n">Adjustments</th><th className="n">Total</th><th /></tr></thead><tbody>
          {people.data!.people.map((p) => <tr key={p.userId}><td><b>{p.user}</b></td><td className="n">{plain(p.earnedMinor)}</td><td className="n neg">{signed(p.clawbackMinor)}</td><td className="n">{signed(p.adjustMinor)}</td><td className="n"><b>{plain(p.netMinor)}</b></td><td className="n"><Button size="sm" variant="ghost" onClick={() => navigate("money", "commission", sel!.id, { person: p.userId })}>{p.entries} {p.entries === 1 ? "line" : "lines"}</Button></td></tr>)}</tbody></table></div>}</Panel></>}
  </>);
}
