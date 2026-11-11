import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button, Callout, Chip } from "@shelfline/ui";
import { api, ApiError, qs } from "../lib/api";
import { time } from "../lib/format";
import { useAuth } from "../state/auth";
import { useBusinessToday, useLens, useLensLock } from "../state/lens";
import { Empty, ErrorBox, Field, PageHeader, Panel, Skeleton, TextInput } from "../ui";

interface E { id: string; userId: string; user: string; date: string; inAt: string; outAt: string | null; breakMinutes: number; workedMinutes: number | null; scheduledMinutes: number | null; lateMinutes: number; varianceMinutes: number | null; flags: string[]; status: string; punchInId: string; punchOutId: string | null }
const addDays = (s: string, n: number) => new Date(Date.parse(s + "T12:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
const monday = (s: string) => { const d = new Date(s + "T12:00:00Z").getUTCDay(); return addDays(s, d === 0 ? -6 : 1 - d); };
const hours = (m: number | null) => (m === null ? "—" : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`);
const signed = (m: number | null) => (m === null ? "—" : m === 0 ? "on time" : `${m > 0 ? "+" : "−"}${Math.abs(m)} min`);
const FLAG: Record<string, { label: string; tone: "warn" | "danger" | "info" }> = { late: { label: "Late", tone: "warn" }, missing_out: { label: "No clock-out", tone: "danger" }, still_in: { label: "Still clocked in", tone: "info" }, no_shift: { label: "Unscheduled", tone: "info" }, left_early: { label: "Left early", tone: "warn" } };

function Fix({ e, tz, loc, onDone }: { e: E; tz: string | undefined; loc: string; onDone: () => void }) {
  const qc = useQueryClient(); const missingOut = e.outAt === null; const [kind, setKind] = useState<"in" | "out">(missingOut ? "out" : "in"); const [hm, setHm] = useState(time(missingOut ? e.inAt : e.inAt, tz)); const [reason, setReason] = useState(""); const [err, setErr] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      const [h, m] = hm.split(":").map(Number); const base = kind === "out" && e.outAt ? new Date(e.outAt) : new Date(e.inAt); const date = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(base);
      // the wall-clock time the manager typed, in the store's zone, as an instant
      const guess = Date.parse(`${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`); const off = (t: number) => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(t)).map((x) => [x.type, x.value])); return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - t; };
      const at = new Date(guess - off(guess - off(guess))).toISOString();
      return api("/timesheets/corrections", { method: "POST", body: { userId: e.userId, locationId: loc, kind, at, reason: reason.trim(), supersedesPunchId: kind === "in" ? e.punchInId : missingOut ? null : e.punchOutId } });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["timesheets"] }); onDone(); },
    onError: (x) => setErr(x instanceof ApiError && x.code === "day_approved" ? "That day is already approved." : x instanceof ApiError && x.code === "bad_time" ? "That time has not happened yet." : "Could not record the correction."),
  });
  return (
    <Panel title={`Correct ${e.user} · ${e.date}`}>
      <form className="stack" aria-label="Correct punch" onSubmit={(ev) => { ev.preventDefault(); setErr(null); save.mutate(); }}>
        <p className="muted" style={{ margin: 0 }}>This adds a new, manual punch. The original punch stays in the record.</p>
        <div className="grid2"><div className="row-flex"><Button type="button" variant={kind === "in" ? "primary" : "secondary"} onClick={() => setKind("in")}>Change clock-in</Button><Button type="button" variant={kind === "out" ? "primary" : "secondary"} onClick={() => setKind("out")}>{missingOut ? "Add clock-out" : "Change clock-out"}</Button></div>
          <Field id="fx-t" label="Correct time (24h, store clock)"><TextInput id="fx-t" value={hm} onChange={setHm} placeholder="17:00" /></Field></div>
        <Field id="fx-r" label="Reason" hint="Kept with the correction in the audit log"><TextInput id="fx-r" value={reason} onChange={setReason} placeholder="e.g. Terminal was down" /></Field>
        {err && <p className="err" role="alert">{err}</p>}
        <div className="row-flex"><Button type="button" onClick={onDone}>Cancel</Button><span className="grow" /><Button variant="primary" type="submit" disabled={!/^[0-2]\d:[0-5]\d$/.test(hm) || reason.trim().length < 3 || save.isPending}>Save correction</Button></div>
      </form>
    </Panel>
  );
}

export function Timesheets() {
  useLensLock(false);
  const { lens, selected } = useLens(); const { can } = useAuth(); const today = useBusinessToday(); const qc = useQueryClient(); const [weekOf, setWeekOf] = useState(() => monday(today)); const [pick, setPick] = useState<Set<string>>(new Set()); const [fix, setFix] = useState<E | null>(null); const [msg, setMsg] = useState<string | null>(null);
  const loc = lens !== "all" ? lens : null; const tz = selected?.timezone; const ok = !!loc && can("timesheet:approve", loc); const from = weekOf, to = addDays(weekOf, 6);
  const q = useQuery({ queryKey: ["timesheets", loc, from], enabled: !!loc, queryFn: () => api<{ entries: E[]; people: { userId: string; user: string; workedMinutes: number; scheduledMinutes: number; lateMinutes: number; entries: number; problems: number }[]; needsReviewPunches: number }>(`/timesheets${qs({ locationId: loc, from, to })}`) });
  const approve = useMutation({ mutationFn: () => api<{ id: string; result: string }[]>("/timesheets/approve", { method: "POST", body: { ids: [...pick] } }), onSuccess: (r) => { const n = r.filter((x) => x.result === "approved").length; const bad = r.filter((x) => x.result === "incomplete").length; setMsg(`${n} approved${bad ? `, ${bad} skipped: no clock-out` : ""}.`); setPick(new Set()); void qc.invalidateQueries({ queryKey: ["timesheets"] }); } });
  if (!loc) return (<><PageHeader title="Timesheets" sub="Choose one location in the rail." /><Empty title="Pick a location">Timesheets are per location. Choose a store on the left.</Empty></>);
  const d = q.data; const open = (d?.entries ?? []).filter((e) => e.status === "open" && e.outAt !== null);
  return (<>
    <PageHeader title="Timesheets" sub={<>{selected?.name} · week of {from} · built from clock-in and clock-out punches</>} actions={ok && <Button variant="primary" disabled={pick.size === 0 || approve.isPending} onClick={() => approve.mutate()}>{pick.size ? `Approve ${pick.size} selected` : "Approve selected"}</Button>} />
    <div className="filters"><Button onClick={() => setWeekOf(addDays(weekOf, -7))} aria-label="Previous week"><ChevronLeft size={16} /></Button><Button onClick={() => setWeekOf(monday(today))}>This week</Button><Button onClick={() => setWeekOf(addDays(weekOf, 7))} aria-label="Next week"><ChevronRight size={16} /></Button>
      {ok && open.length > 0 && <Button variant="ghost" onClick={() => setPick(new Set(open.map((e) => e.id)))}>Select all complete ({open.length})</Button>}</div>
    {msg && <Callout tone="info"><span>{msg}</span></Callout>}{d && d.needsReviewPunches > 0 && <Callout tone="warn"><span><b>{d.needsReviewPunches} punch{d.needsReviewPunches === 1 ? "" : "es"} held for review</b> (a repeated clock-in or clock-out). Look at the entries marked below.</span></Callout>}
    {fix && <Fix key={fix.id} e={fix} tz={tz} loc={loc} onDone={() => setFix(null)} />}
    {d && d.people.length > 0 && <Panel title="This week" flush><div className="tbl-wrap"><table className="tbl" data-testid="people-hours"><thead><tr><th>Person</th><th className="n">Worked</th><th className="n">Scheduled</th><th className="n">Late</th><th className="n">Needs attention</th></tr></thead>
      <tbody>{d.people.map((p) => <tr key={p.userId}><td><b>{p.user}</b></td><td className="n">{hours(p.workedMinutes)}</td><td className="n">{p.scheduledMinutes ? hours(p.scheduledMinutes) : "—"}</td><td className="n">{p.lateMinutes ? `${p.lateMinutes} min` : "—"}</td><td className="n">{p.problems ? <span className="neg">{p.problems} missing clock-out</span> : "—"}</td></tr>)}</tbody></table></div></Panel>}
    <Panel flush>{q.isLoading ? <Skeleton rows={5} /> : q.isError ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : d!.entries.length === 0 ? <Empty title="No time recorded this week">Entries appear as people clock in and out on the till.</Empty> :
      <div className="tbl-wrap"><table className="tbl" data-testid="timesheet-table"><thead><tr>{ok && <th />}<th>Day</th><th>Person</th><th>In</th><th>Out</th><th className="n">Worked</th><th className="n">vs shift</th><th>Notes</th><th>Status</th><th /></tr></thead>
        <tbody>{d!.entries.map((e) => <tr key={e.id}>{ok && <td><input type="checkbox" aria-label={`Select ${e.user} ${e.date}`} disabled={e.status === "approved" || e.outAt === null} checked={pick.has(e.id)} onChange={(x) => setPick((p) => { const n = new Set(p); x.target.checked ? n.add(e.id) : n.delete(e.id); return n; })} /></td>}
          <td>{e.date}</td><td><b>{e.user}</b></td><td className="mono">{time(e.inAt, tz)}</td><td className="mono">{e.outAt ? time(e.outAt, tz) : "—"}</td><td className="n">{hours(e.workedMinutes)}{e.breakMinutes ? <span className="muted" style={{ fontSize: 12 }}> −{e.breakMinutes}m</span> : null}</td><td className="n">{e.scheduledMinutes === null ? <span className="muted">—</span> : signed(e.varianceMinutes)}</td>
          <td><span className="pill-row">{e.flags.map((f) => <Chip key={f} tone={FLAG[f]?.tone ?? "info"}>{f === "late" ? `Late ${e.lateMinutes} min` : FLAG[f]?.label ?? f}</Chip>)}</span></td><td><Chip tone={e.status === "approved" ? "ok" : undefined}>{e.status === "approved" ? "Approved" : "Open"}</Chip></td>
          <td className="n">{ok && e.status === "open" && <Button size="sm" variant="ghost" onClick={() => setFix(e)}>Correct</Button>}</td></tr>)}</tbody></table></div>}</Panel>
  </>);
}
