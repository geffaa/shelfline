import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Calendar, ChevronDown, ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react";
import { Button, Callout, Chip, DatePicker, Select, Stepper } from "@shelfline/ui";
import { api, ApiError, qs } from "../lib/api";
import { time } from "../lib/format";
import { useAuth } from "../state/auth";
import { useBusinessToday, useLens, useLensLock } from "../state/lens";
import { Empty, ErrorBox, Field, PageHeader, Panel, Skeleton, TextInput } from "../ui";

interface Sh { id: string; userId: string | null; user: string | null; date: string; startsAt: string; endsAt: string; role: string | null; breakMinutes: number; note: string | null; published: boolean; conflict: boolean }
interface Day { date: string; weekday: number; need: number; staffed: number; open: number; under: boolean }
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const addDays = (s: string, n: number) => new Date(Date.parse(s + "T12:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
const monday = (s: string) => { const d = new Date(s + "T12:00:00Z").getUTCDay(); return addDays(s, d === 0 ? -6 : 1 - d); };
const hmOk = (v: string) => /^[0-2]\d:[0-5]\d$/.test(v);

function ShiftForm({ loc, date, who: who0, people, template, shift, onDone }: { loc: string; date: string; who?: string | null; people: { id: string; name: string }[]; template?: { startTime: string; endTime: string; breakMinutes: number; role: string | null }; shift?: Sh; onDone: () => void }) {
  const qc = useQueryClient(); const tz = useLens().locations.find((l) => l.id === loc)?.timezone; const today = useBusinessToday();
  const [who, setWho] = useState<string | null>(shift ? shift.userId : who0 ?? null); const [on, setOn] = useState(date); const [start, setStart] = useState(shift ? time(shift.startsAt, tz) : template?.startTime ?? "09:00"); const [end, setEnd] = useState(shift ? time(shift.endsAt, tz) : template?.endTime ?? "17:00"); const [brk, setBrk] = useState(shift?.breakMinutes ?? template?.breakMinutes ?? 30); const [role, setRole] = useState(shift?.role ?? template?.role ?? ""); const [err, setErr] = useState<string | null>(null);
  const save = useMutation({ mutationFn: () => { const body = { userId: who, date: on, start, end, role: role.trim() || null, breakMinutes: brk }; return shift ? api(`/shifts/${shift.id}`, { method: "PATCH", body }) : api("/shifts", { method: "POST", body: { locationId: loc, ...body } }); }, onSuccess: () => { void qc.invalidateQueries({ queryKey: ["shifts"] }); onDone(); },
    onError: (e) => setErr(e instanceof ApiError && e.code === "shift_overlap" ? "That person already has a shift that overlaps." : e instanceof ApiError && e.code === "user_not_assigned" ? "That person is not assigned to this location." : "Could not save the shift.") });
  const del = useMutation({ mutationFn: () => api(`/shifts/${shift!.id}`, { method: "DELETE" }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["shifts"] }); onDone(); } });
  return (
    <Panel title={shift ? "Edit shift" : "Add a shift"}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); setErr(null); save.mutate(); }}>
        <div className="grid2"><Select label="Person" value={who ?? "__open"} onChange={(v) => setWho(v === "__open" ? null : v)} options={[{ value: "__open", label: "Open shift (nobody yet)" }, ...people.map((p) => ({ value: p.id, label: p.name }))]} chevron={<ChevronDown size={16} />} />
          <DatePicker label="Day" value={on} onChange={setOn} today={today} icon={<Calendar size={16} />} prevIcon={<ChevronLeft size={16} />} nextIcon={<ChevronRight size={16} />} /></div>
        <div className="grid2"><Field id="sh-s" label="Starts (24h)"><TextInput id="sh-s" value={start} onChange={setStart} placeholder="09:00" /></Field><Field id="sh-e" label="Ends (24h)" hint="An earlier time than the start runs into the next day"><TextInput id="sh-e" value={end} onChange={setEnd} placeholder="17:00" /></Field></div>
        <div className="grid2"><div className="row-flex"><span>Unpaid break</span><Stepper label="Break minutes" value={brk} min={0} max={480} onChange={(n) => setBrk(Math.min(480, n))} decrementIcon={<Minus size={16} />} incrementIcon={<Plus size={16} />} /><span className="muted">min</span></div><Field id="sh-r" label="Role"><TextInput id="sh-r" value={role} onChange={setRole} placeholder="e.g. Floor, Till, Opening" /></Field></div>
        {err && <p className="err" role="alert">{err}</p>}
        <div className="row-flex">{shift && <Button type="button" variant="ghost" onClick={() => del.mutate()}>Delete shift</Button>}<Button type="button" onClick={onDone}>Cancel</Button><span className="grow" /><Button variant="primary" type="submit" disabled={!hmOk(start) || !hmOk(end) || start === end || save.isPending}>{shift ? "Save shift" : "Add shift"}</Button></div>
      </form>
    </Panel>
  );
}

function Need({ loc }: { loc: string }) {
  const qc = useQueryClient(); const q = useQuery({ queryKey: ["staffing", loc], queryFn: () => api<Record<string, number>>(`/locations/${loc}/staffing`) }); const [v, setV] = useState<Record<number, number> | null>(null);
  const save = useMutation({ mutationFn: () => api(`/locations/${loc}/staffing`, { method: "PUT", body: v }), onSuccess: () => { setV(null); void qc.invalidateQueries({ queryKey: ["staffing", loc] }); void qc.invalidateQueries({ queryKey: ["shifts"] }); } });
  if (!q.data) return null; const cur = v ?? Object.fromEntries(DAYS.map((_, i) => [i, q.data![i] ?? 0]));
  return (<Panel title="Staff needed per day" right={v && <Button size="sm" variant="primary" onClick={() => save.mutate()}>Save</Button>}><div className="row-flex" style={{ flexWrap: "wrap", gap: 16 }}>
    {[1, 2, 3, 4, 5, 6, 0].map((d) => <div key={d} className="stack" style={{ alignItems: "center", gap: 4 }}><span className="muted">{DAYS[d]}</span><Stepper label={`People needed on ${DAYS[d]}`} value={cur[d] ?? 0} min={0} max={50} onChange={(n) => setV({ ...cur, [d]: n })} decrementIcon={<Minus size={14} />} incrementIcon={<Plus size={14} />} /></div>)}</div></Panel>);
}

export function Schedule() {
  useLensLock(false);
  const { lens, locations, selected } = useLens(); const { can } = useAuth(); const today = useBusinessToday(); const qc = useQueryClient(); const [weekOf, setWeekOf] = useState(() => monday(today));
  const [form, setForm] = useState<{ date: string; who?: string | null; shift?: Sh; template?: any } | null>(null); const [tpl, setTpl] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null); const [showNeed, setShowNeed] = useState(false);
  const loc = lens !== "all" ? lens : null; const tz = selected?.timezone; const w = !!loc && can("roster:write", loc);
  const from = weekOf, to = addDays(weekOf, 6);
  const board = useQuery({ queryKey: ["shifts", loc, from], enabled: !!loc, queryFn: () => api<{ shifts: Sh[]; days: Day[] }>(`/shifts${qs({ locationId: loc, from, to })}`) });
  const users = useQuery({ queryKey: ["users"], queryFn: () => api<{ id: string; name: string; status: string; assignments: { locationId: string | null }[] }[]>("/users") }); const templates = useQuery({ queryKey: ["templates"], queryFn: () => api<any[]>("/shift-templates") });
  const people = useMemo(() => (users.data ?? []).filter((u) => u.status === "active" && u.assignments.some((a) => a.locationId === null || a.locationId === loc)).map((u) => ({ id: u.id, name: u.name })), [users.data, loc]);
  const publish = useMutation({ mutationFn: () => api<{ published: number }>("/shifts/publish", { method: "POST", body: { locationId: loc, from, to } }), onSuccess: (r) => { setMsg(r.published ? `${r.published} shift${r.published === 1 ? "" : "s"} published. People see them on their till and profile.` : "Everything this week is already published."); void qc.invalidateQueries({ queryKey: ["shifts"] }); } });
  if (!loc) return (<><PageHeader title="Schedule" sub="Choose one location in the rail to see its roster." /><Empty title="Pick a location">The roster is per location. Choose a store on the left.</Empty></>);
  const days = board.data?.days ?? []; const shifts = board.data?.shifts ?? []; const rows = [...people.map((p) => ({ id: p.id as string | null, name: p.name })), { id: null as string | null, name: "Open shifts" }];
  const drafts = shifts.filter((s) => !s.published).length; const tmpl = (templates.data ?? []).find((t) => t.id === tpl);
  return (<>
    <PageHeader title="Schedule" sub={<>{selected?.name} · week of {from} · times are the store's clock</>} actions={w && <span className="row-flex"><Button onClick={() => setShowNeed((x) => !x)}>Staffing need</Button><Button variant="primary" onClick={() => publish.mutate()} disabled={drafts === 0 || publish.isPending}>{drafts ? `Publish ${drafts} draft${drafts === 1 ? "" : "s"}` : "Published"}</Button></span>} />
    <div className="filters"><Button onClick={() => setWeekOf(addDays(weekOf, -7))} aria-label="Previous week"><ChevronLeft size={16} /></Button><Button onClick={() => setWeekOf(monday(today))}>This week</Button><Button onClick={() => setWeekOf(addDays(weekOf, 7))} aria-label="Next week"><ChevronRight size={16} /></Button>
      {w && <Select label="Template" value={tpl} onChange={setTpl} options={(templates.data ?? []).map((t) => ({ value: t.id, label: `${t.name} ${t.startTime}–${t.endTime}` }))} placeholder="Shift template (optional)" chevron={<ChevronDown size={16} />} />}</div>
    {msg && <Callout tone="info"><span>{msg}</span></Callout>}{showNeed && <Need loc={loc} />}
    {form && <ShiftForm key={form.shift?.id ?? form.date + (form.who ?? "") + (tpl ?? "")} loc={loc} date={form.date} who={form.who} people={people} template={tmpl} shift={form.shift} onDone={() => setForm(null)} />}
    <Panel flush>{board.isLoading ? <Skeleton rows={6} /> : board.isError ? <ErrorBox error={board.error} retry={() => board.refetch()} /> :
      <div className="tbl-wrap"><table className="tbl" data-testid="roster"><thead><tr><th>Person</th>{days.map((d) => <th key={d.date} className="n" style={{ minWidth: 112 }}>{DAYS[d.weekday]} {d.date.slice(8)}<br /><span className={d.under ? "neg" : "muted"} style={{ fontSize: 12, fontWeight: 600 }} data-testid={`need-${d.date}`}>{d.need ? `${d.staffed}/${d.need} staffed` : d.staffed ? `${d.staffed} on` : "—"}{d.under ? " · short" : ""}</span></th>)}</tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id ?? "open"}><td><b>{r.name}</b></td>{days.map((d) => { const cell = shifts.filter((s) => s.date === d.date && s.userId === r.id); return (
          <td key={d.date} style={{ verticalAlign: "top" }}>{cell.map((s) => <button type="button" key={s.id} className={`chip${s.published ? " ok" : ""}${s.conflict ? " danger" : ""}`} style={{ display: "block", marginBottom: 4, borderStyle: s.published ? "solid" : "dashed" }} aria-label={`Shift ${r.name} ${d.date} ${time(s.startsAt, tz)}–${time(s.endsAt, tz)}`} onClick={() => w && setForm({ date: d.date, shift: s })}>{time(s.startsAt, tz)}–{time(s.endsAt, tz)}{s.role ? ` · ${s.role}` : ""}</button>)}
            {w && <button type="button" className="btn ghost sm" aria-label={`Add shift for ${r.name} on ${d.date}`} onClick={() => setForm({ date: d.date, who: r.id })}><Plus size={14} /></button>}</td>); })}</tr>)}</tbody></table></div>}</Panel>
    <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Dashed shifts are drafts; solid ones are published. Pick a template first to pre-fill the times.</p>
  </>);
}
