import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Minus, Plus } from "lucide-react";
import { Button, Callout, Checkbox, Chip, Segmented, Select, Stepper, Switch } from "@shelfline/ui";
import { api, ApiError } from "../lib/api";
import { dateTime, plain } from "../lib/format";
import { useAuth } from "../state/auth";
import { useLens, useLensLock } from "../state/lens";
import { Empty, ErrorBox, Field, PageHeader, Panel, Skeleton, TextInput } from "../ui";

interface Sched { id: string; name: string; locationIds: string[] | null; locations: string[] | null; sendAtLocal: string; daysOfWeek: number[]; timezone: string; methods: string[]; recipients: string[]; webhookUrl: string | null; hasWebhookSecret: boolean; format: "pdf" | "csv" | "inline"; onlyWhenClosed: boolean; maxWaitMinutes: number; active: boolean; last: { date: string; version: number; status: string; at: string } | null }
interface RunRow { id: string; schedule: string; date: string; version: number; status: "provisional" | "final" | "amended"; notes: string[]; delivered: { method: string; ok: boolean; to: string; detail?: string }[]; generatedAt: string; totals: { orders: number; netMinor: number } }
const DAYS = [["1", "Mon"], ["2", "Tue"], ["3", "Wed"], ["4", "Thu"], ["5", "Fri"], ["6", "Sat"], ["0", "Sun"]] as const;
const ZONES = ["Australia/Melbourne", "Australia/Sydney", "Australia/Brisbane", "Australia/Adelaide", "Australia/Perth", "Australia/Hobart", "Pacific/Auckland"];
const STATUS = { provisional: { label: "Provisional", tone: "warn" }, final: { label: "Final", tone: "ok" }, amended: { label: "Amended", tone: "info" } } as const;
const daysText = (d: number[]) => (d.length === 7 ? "every day" : DAYS.filter(([k]) => d.includes(Number(k))).map(([, l]) => l).join(", "));

function Form({ initial, onDone }: { initial?: Sched; onDone: () => void }) {
  const qc = useQueryClient(); const { locations } = useLens(); const stores = locations.filter((l) => l.type === "store");
  const [name, setName] = useState(initial?.name ?? "Store close"); const [all, setAll] = useState(initial ? initial.locationIds === null : true); const [locs, setLocs] = useState<string[]>(initial?.locationIds ?? []); const [time, setTime] = useState(initial?.sendAtLocal ?? "21:30");
  const [tz, setTz] = useState(initial?.timezone ?? stores[0]?.timezone ?? "Australia/Melbourne"); const [days, setDays] = useState<string[]>((initial?.daysOfWeek ?? [0, 1, 2, 3, 4, 5, 6]).map(String));
  const [email, setEmail] = useState(initial ? initial.methods.includes("email") : true); const [hook, setHook] = useState(initial ? initial.methods.includes("webhook") : false); const [to, setTo] = useState((initial?.recipients ?? []).join(", ")); const [url, setUrl] = useState(initial?.webhookUrl ?? "");
  const [fmt, setFmt] = useState<"pdf" | "csv" | "inline">(initial?.format ?? "pdf"); const [closed, setClosed] = useState(initial?.onlyWhenClosed ?? true); const [wait, setWait] = useState(initial?.maxWaitMinutes ?? 120); const [err, setErr] = useState<string | null>(null); const [secret, setSecret] = useState<string | null>(null);
  const zones = [...new Set([...stores.map((s) => s.timezone), ...ZONES])];
  const tog = (arr: string[], set: (v: string[]) => void, k: string, on: boolean) => set(on ? [...new Set([...arr, k])] : arr.filter((x) => x !== k));
  const recipients = to.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
  const save = useMutation({
    mutationFn: () => { const body = { name: name.trim(), locationIds: all ? null : locs, sendAtLocal: time, timezone: tz, daysOfWeek: days.map(Number), methods: [...(email ? ["email"] : []), ...(hook ? ["webhook"] : [])], recipients: email ? recipients : [], webhookUrl: hook ? url.trim() : null, format: fmt, onlyWhenClosed: closed, maxWaitMinutes: wait }; return initial ? api<Sched>(`/eod-schedules/${initial.id}`, { method: "PATCH", body }) : api<Sched & { webhookSecret?: string }>("/eod-schedules", { method: "POST", body }); },
    onSuccess: (r: Sched & { webhookSecret?: string }) => { void qc.invalidateQueries({ queryKey: ["eod-schedules"] }); if (r.webhookSecret) setSecret(r.webhookSecret); else onDone(); },
    onError: (e) => setErr(e instanceof ApiError ? ({ no_recipients: "Add at least one email address.", bad_timezone: "That time zone is not recognised.", bad_webhook_url: "The webhook address must start with http:// or https://.", no_webhook_url: "Add the webhook address." } as Record<string, string>)[e.code] ?? "Check the time (like 21:30), the addresses and the places." : "Could not save the schedule."),
  });
  if (secret) return (<Panel title="Webhook secret"><div className="stack"><Callout tone="warn"><span>Copy this now. It signs every delivery and is not shown again.</span></Callout><code className="mono" data-testid="webhook-secret" style={{ wordBreak: "break-all" }}>{secret}</code><div className="row-flex"><span className="grow" /><Button variant="primary" onClick={onDone}>Done</Button></div></div></Panel>);
  const ok = name.trim() && /^([01]\d|2[0-3]):[0-5]\d$/.test(time) && days.length > 0 && (email || hook) && (!email || recipients.length > 0) && (!hook || url.trim()) && (all || locs.length > 0);
  return (
    <Panel title={initial ? `Edit "${initial.name}"` : "New end-of-day schedule"}>
      <form className="stack" aria-label="End-of-day schedule" onSubmit={(e) => { e.preventDefault(); setErr(null); save.mutate(); }}>
        <Field id="eod-name" label="Name"><TextInput id="eod-name" value={name} onChange={setName} /></Field>
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}><legend className="lbl">Which locations</legend><Switch checked={all} onChange={setAll}>Every store</Switch>{!all && <div className="pill-row">{stores.map((l) => <Checkbox key={l.id} checked={locs.includes(l.id)} onChange={(on) => tog(locs, setLocs, l.id, on)} checkIcon={<Check size={14} />}>{l.name}</Checkbox>)}</div>}</fieldset>
        <div className="grid2"><Field id="eod-time" label="Send at (24h)" hint="In the time zone chosen here, including summer time"><TextInput id="eod-time" value={time} onChange={setTime} /></Field><Select label="Time zone" value={tz} onChange={setTz} options={zones.map((z) => ({ value: z, label: z.replace("_", " ") }))} chevron={<ChevronDown size={16} />} /></div>
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}><legend className="lbl">On</legend><div className="pill-row">{DAYS.map(([k, l]) => <Checkbox key={k} checked={days.includes(k)} onChange={(on) => tog(days, setDays, k, on)} checkIcon={<Check size={14} />}>{l}</Checkbox>)}</div></fieldset>
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}><legend className="lbl">Send by</legend><Switch checked={email} onChange={setEmail}>Email</Switch>{email && <Field id="eod-to" label="Recipients" hint="Separate addresses with commas"><TextInput id="eod-to" value={to} onChange={setTo} placeholder="owner@example.com, accounts@example.com" /></Field>}
          <Switch checked={hook} onChange={setHook}>Webhook</Switch>{hook && <Field id="eod-url" label="Webhook address" hint="Each delivery is signed so you can check it came from Shelfline"><TextInput id="eod-url" value={url} onChange={setUrl} placeholder="https://example.com/shelfline" /></Field>}
          {email && <Segmented label="Attach as" value={fmt} onChange={setFmt} options={[{ value: "pdf", label: "PDF" }, { value: "csv", label: "CSV" }, { value: "inline", label: "In the email only" }]} />}</fieldset>
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}><legend className="lbl">If a register is still open</legend><Switch checked={closed} onChange={setClosed}>Wait for registers to close first</Switch>
          {closed && <div className="row-flex"><Stepper label="Minutes to wait" value={wait} min={0} max={720} onChange={(n) => setWait(n)} decrementIcon={<Minus size={16} />} incrementIcon={<Plus size={16} />} /><span className="muted">minutes at most, then send a report marked provisional</span></div>}</fieldset>
        {err && <p className="err" role="alert">{err}</p>}
        <div className="row-flex"><Button type="button" onClick={onDone}>Cancel</Button><span className="grow" /><Button variant="primary" type="submit" disabled={!ok || save.isPending}>{initial ? "Save changes" : "Add schedule"}</Button></div>
      </form>
    </Panel>
  );
}

function RunText({ id }: { id: string }) { const q = useQuery({ queryKey: ["eod-run", id], queryFn: () => api<{ lines: string[] }>(`/eod-runs/${id}`) }); return q.data ? <pre className="mono" data-testid="run-text" style={{ margin: 0, padding: 16, overflow: "auto", fontSize: 12.5, background: "var(--surface-2)" }}>{q.data.lines.join("\n")}</pre> : <Skeleton rows={3} />; }

export function EodSchedules() {
  useLensLock(true);
  const { can } = useAuth(); const manage = can("eod:manage", null); const qc = useQueryClient(); const [form, setForm] = useState<Sched | "new" | null>(null); const [open, setOpen] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null);
  const list = useQuery({ queryKey: ["eod-schedules"], enabled: manage, refetchOnMount: "always", queryFn: () => api<Sched[]>("/eod-schedules") });
  const runs = useQuery({ queryKey: ["eod-runs"], enabled: manage, refetchOnMount: "always", refetchInterval: 30_000, queryFn: () => api<RunRow[]>("/eod-runs") });
  const toggle = useMutation({ mutationFn: (s: Sched) => api(`/eod-schedules/${s.id}`, { method: "PATCH", body: { active: !s.active } }), onSuccess: () => qc.invalidateQueries({ queryKey: ["eod-schedules"] }) });
  const now = useMutation({ mutationFn: (s: Sched) => api<{ version: number; status: string }>(`/eod-schedules/${s.id}/send-now`, { method: "POST", body: {} }), onSuccess: (r, s) => { setMsg(`Sent a ${r.status} test of "${s.name}" (version ${r.version}).`); void qc.invalidateQueries({ queryKey: ["eod-runs"] }); void qc.invalidateQueries({ queryKey: ["eod-schedules"] }); }, onError: () => setMsg("Could not send a test.") });
  if (!manage) return (<><PageHeader title="End-of-day reports" /><Empty title="Not available">Only owners, HQ managers and finance set up automatic reports.</Empty></>);
  return (<>
    <PageHeader title="End-of-day reports" sub="A report for each store's trading day, sent on time in the store's own clock. Late changes are sent as an amended version." actions={<Button variant="primary" onClick={() => setForm("new")}>New schedule</Button>} />
    {msg && <Callout tone="info"><span>{msg}</span></Callout>}
    {form && <Form key={form === "new" ? "new" : form.id} initial={form === "new" ? undefined : form} onDone={() => setForm(null)} />}
    <Panel flush>{list.isLoading ? <Skeleton rows={3} /> : list.isError ? <ErrorBox error={list.error} retry={() => list.refetch()} /> : list.data!.length === 0 ? <Empty title="No schedules yet">Add one to have the owner's report arrive every evening.</Empty> :
      <div className="tbl-wrap"><table className="tbl" data-testid="schedules-table"><thead><tr><th>Schedule</th><th>Where</th><th>When</th><th>How</th><th>Last report</th><th /></tr></thead><tbody>
        {list.data!.map((s) => <tr key={s.id} style={{ opacity: s.active ? 1 : 0.55 }}><td><b>{s.name}</b>{!s.active && <> <Chip>Paused</Chip></>}</td><td>{s.locations ? s.locations.join(", ") : "Every store"}</td><td>{s.sendAtLocal} · {daysText(s.daysOfWeek)}<br /><span className="muted" style={{ fontSize: 12 }}>{s.timezone.replace("_", " ")}{s.onlyWhenClosed ? ` · waits up to ${s.maxWaitMinutes} min for registers` : ""}</span></td>
          <td><span className="pill-row">{s.methods.includes("email") && <Chip>{s.format === "pdf" ? "Email + PDF" : s.format === "csv" ? "Email + CSV" : "Email"} · {s.recipients.length}</Chip>}{s.methods.includes("webhook") && <Chip>Webhook</Chip>}</span></td>
          <td>{s.last ? <>{s.last.date} <Chip tone={STATUS[s.last.status as keyof typeof STATUS]?.tone}>{STATUS[s.last.status as keyof typeof STATUS]?.label ?? s.last.status}</Chip> v{s.last.version}</> : <span className="muted">None yet</span>}</td>
          <td className="n"><Button size="sm" variant="ghost" onClick={() => now.mutate(s)} disabled={now.isPending}>Send a test now</Button><Button size="sm" variant="ghost" onClick={() => setForm(s)}>Edit</Button><Button size="sm" variant="ghost" onClick={() => toggle.mutate(s)}>{s.active ? "Pause" : "Resume"}</Button></td></tr>)}</tbody></table></div>}</Panel>
    <Panel title="Reports sent" flush>{runs.isLoading ? <Skeleton rows={3} /> : (runs.data ?? []).length === 0 ? <Empty title="Nothing sent yet" /> :
      <div className="tbl-wrap"><table className="tbl" data-testid="runs-table"><thead><tr><th>Trading day</th><th>Schedule</th><th>Version</th><th className="n">Orders</th><th className="n">Net sales</th><th>Delivered</th><th /></tr></thead><tbody>
        {runs.data!.slice(0, 40).flatMap((r) => [<tr key={r.id}><td><b>{r.date}</b><br /><span className="muted" style={{ fontSize: 12 }}>{dateTime(r.generatedAt)}</span></td><td>{r.schedule}</td><td><Chip tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Chip> v{r.version}{r.notes.length > 0 && <div className="muted" style={{ fontSize: 12 }}>{r.notes[0]}</div>}</td><td className="n">{r.totals.orders}</td><td className="n">{plain(r.totals.netMinor)}</td>
          <td>{r.delivered.length ? r.delivered.map((d) => `${d.method === "email" ? d.to : "webhook"}${d.ok ? "" : " (failed)"}`).join(", ") : <span className="muted">—</span>}</td><td className="n"><Button size="sm" variant="ghost" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? "Hide" : "View"}</Button></td></tr>,
          open === r.id && <tr key={r.id + "t"}><td colSpan={7} style={{ padding: 0 }}><RunText id={r.id} /></td></tr>])}</tbody></table></div>}</Panel>
  </>);
}
