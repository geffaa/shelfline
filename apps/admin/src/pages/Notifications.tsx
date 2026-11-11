import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown } from "lucide-react";
import { Button, Checkbox, Chip, Select, Switch } from "@shelfline/ui";
import { api, ApiError } from "../lib/api";
import { dateTime } from "../lib/format";
import { useAuth } from "../state/auth";
import { useLens, useLensLock } from "../state/lens";
import { Empty, ErrorBox, Field, PageHeader, Panel, Skeleton, TextInput } from "../ui";

interface Rule { id: string; name: string; eventKind: string; locationIds: string[] | null; locations: string[] | null; conditions: { minMinor?: number; minLateMinutes?: number; varianceOverMinor?: number }; recipientUserIds: string[]; recipients: string[]; recipientRoles: string[]; channels: string[]; quietStart: string | null; quietEnd: string | null; critical: boolean; digest: boolean; digestAt: string; active: boolean; sent: number; lastAt: string | null }
const KINDS = [
  { value: "no_sale", label: "No-sale (drawer opened without a sale)" }, { value: "cash_variance", label: "Cash variance at close" }, { value: "large_refund", label: "Large refund" }, { value: "register_open", label: "Register opened" },
  { value: "register_close", label: "Register closed" }, { value: "punch_in", label: "Clock-in" }, { value: "punch_out", label: "Clock-out" }, { value: "late_arrival", label: "Late arrival" },
];
const ROLES = [["store_manager", "Store managers there"], ["hq_manager", "HQ managers"], ["owner", "Owners"], ["finance", "Finance"], ["roster", "Roster / HR"]] as const;
const kindLabel = (k: string) => KINDS.find((x) => x.value === k)?.label.replace(/ \(.*\)/, "") ?? k;
const cents = (s: string) => Math.round(Number(s.replace(/[^0-9.]/g, "")) * 100);
const condText = (r: Rule) => (r.conditions.minMinor !== undefined ? `from A$${(r.conditions.minMinor / 100).toFixed(2)}` : r.conditions.varianceOverMinor !== undefined ? `over A$${(r.conditions.varianceOverMinor / 100).toFixed(2)} either way` : r.conditions.minLateMinutes !== undefined ? `${r.conditions.minLateMinutes}+ minutes` : "");

function Form({ initial, onDone }: { initial?: Rule; onDone: () => void }) {
  const qc = useQueryClient(); const { locations } = useLens(); const stores = locations.filter((l) => l.type === "store");
  const [name, setName] = useState(initial?.name ?? ""); const [kind, setKind] = useState(initial?.eventKind ?? "no_sale"); const [all, setAll] = useState(initial ? initial.locationIds === null : true); const [locs, setLocs] = useState<string[]>(initial?.locationIds ?? []);
  const [roles, setRoles] = useState<string[]>(initial?.recipientRoles ?? ["store_manager"]); const [people, setPeople] = useState<string[]>(initial?.recipientUserIds ?? []); const [chan, setChan] = useState<string[]>(initial?.channels ?? ["in_app"]);
  const c = initial?.conditions ?? {}; const [cond, setCond] = useState(c.minMinor !== undefined ? String(c.minMinor / 100) : c.varianceOverMinor !== undefined ? String(c.varianceOverMinor / 100) : c.minLateMinutes !== undefined ? String(c.minLateMinutes) : "");
  const [quiet, setQuiet] = useState(!!initial?.quietStart); const [qs, setQs] = useState(initial?.quietStart ?? "22:00"); const [qe, setQe] = useState(initial?.quietEnd ?? "07:00"); const [critical, setCritical] = useState(initial?.critical ?? false);
  const [digest, setDigest] = useState(initial?.digest ?? false); const [digestAt, setDigestAt] = useState(initial?.digestAt ?? "18:00"); const [err, setErr] = useState<string | null>(null);
  const staff = useQuery({ queryKey: ["staff-names"], queryFn: () => api<{ id: string; name: string }[]>("/users") });
  const tog = (arr: string[], set: (v: string[]) => void, k: string, on: boolean) => set(on ? [...new Set([...arr, k])] : arr.filter((x) => x !== k));
  const conditions = cond.trim() === "" ? {} : kind === "large_refund" ? { minMinor: cents(cond) } : kind === "cash_variance" ? { varianceOverMinor: cents(cond) } : kind === "late_arrival" ? { minLateMinutes: Math.round(Number(cond)) } : {};
  const save = useMutation({
    mutationFn: () => { const body = { name: name.trim(), eventKind: kind, locationIds: all ? null : locs, conditions, recipientUserIds: people, recipientRoles: roles, channels: chan, quietStart: quiet ? qs : null, quietEnd: quiet ? qe : null, critical, digest: digest && chan.includes("email"), digestAt }; return initial ? api(`/notification-rules/${initial.id}`, { method: "PATCH", body }) : api("/notification-rules", { method: "POST", body }); },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["notification-rules"] }); onDone(); },
    onError: (e) => setErr(e instanceof ApiError && e.code === "no_recipients" ? "Choose at least one person or group to tell." : e instanceof ApiError && e.status === 400 ? "Check the times (like 22:00), the amounts and who is chosen." : "Could not save the rule."),
  });
  const condLabel = kind === "large_refund" ? "Refunds of at least (A$)" : kind === "cash_variance" ? "Short or over by more than (A$)" : kind === "late_arrival" ? "Late by at least (minutes)" : null;
  return (
    <Panel title={initial ? `Edit "${initial.name}"` : "New notification rule"}>
      <form className="stack" aria-label="Notification rule" onSubmit={(e) => { e.preventDefault(); setErr(null); save.mutate(); }}>
        <div className="grid2"><Field id="nr-name" label="Name"><TextInput id="nr-name" value={name} onChange={setName} placeholder="No-sales to store managers" /></Field>
          <Select label="When this happens" value={kind} onChange={(k) => { setKind(k); setCond(""); }} options={KINDS} chevron={<ChevronDown size={16} />} /></div>
        {condLabel && <Field id="nr-cond" label={condLabel} hint="Leave empty to be told every time"><TextInput id="nr-cond" value={cond} onChange={setCond} inputMode="decimal" /></Field>}
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}><legend className="lbl">Where</legend><Switch checked={all} onChange={setAll}>Every location</Switch>{!all && <div className="pill-row">{stores.map((l) => <Checkbox key={l.id} checked={locs.includes(l.id)} onChange={(on) => tog(locs, setLocs, l.id, on)} checkIcon={<Check size={14} />}>{l.name}</Checkbox>)}</div>}</fieldset>
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}><legend className="lbl">Tell</legend><div className="pill-row">{ROLES.map(([k, l]) => <Checkbox key={k} checked={roles.includes(k)} onChange={(on) => tog(roles, setRoles, k, on)} checkIcon={<Check size={14} />}>{l}</Checkbox>)}</div>
          {(staff.data ?? []).length > 0 && <details><summary className="muted" style={{ cursor: "pointer" }}>Or specific people ({people.length})</summary><div className="pill-row" style={{ marginTop: 8 }}>{(staff.data ?? []).slice(0, 60).map((s) => <Checkbox key={s.id} checked={people.includes(s.id)} onChange={(on) => tog(people, setPeople, s.id, on)} checkIcon={<Check size={14} />}>{s.name}</Checkbox>)}</div></details>}</fieldset>
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}><legend className="lbl">How</legend><div className="pill-row"><Checkbox checked={chan.includes("in_app")} onChange={(on) => tog(chan, setChan, "in_app", on)} checkIcon={<Check size={14} />}>In the inbox</Checkbox><Checkbox checked={chan.includes("email")} onChange={(on) => tog(chan, setChan, "email", on)} checkIcon={<Check size={14} />}>By email</Checkbox></div>
          {chan.includes("email") && <><Switch checked={digest} onChange={setDigest}>One summary email a day instead of one per event</Switch>{digest && <div style={{ maxWidth: 200 }}><Field id="nr-digest" label="Send the summary at (24h, store clock)"><TextInput id="nr-digest" value={digestAt} onChange={setDigestAt} /></Field></div>}</>}</fieldset>
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}><legend className="lbl">Quiet hours</legend><Switch checked={quiet} onChange={setQuiet}>Hold messages overnight</Switch>
          {quiet && <><div className="grid2"><Field id="nr-qs" label="Quiet from (24h, store clock)"><TextInput id="nr-qs" value={qs} onChange={setQs} /></Field><Field id="nr-qe" label="Until"><TextInput id="nr-qe" value={qe} onChange={setQe} /></Field></div>
            <Switch checked={critical} onChange={setCritical}>Send even in quiet hours (use for things that cannot wait)</Switch><p className="muted" style={{ margin: 0 }}>Held messages arrive when the quiet hours end. Serious cash shortages always come through.</p></>}</fieldset>
        {err && <p className="err" role="alert">{err}</p>}
        <div className="row-flex"><Button type="button" onClick={onDone}>Cancel</Button><span className="grow" /><Button variant="primary" type="submit" disabled={!name.trim() || chan.length === 0 || (!all && locs.length === 0) || (roles.length === 0 && people.length === 0) || save.isPending}>{initial ? "Save changes" : "Add rule"}</Button></div>
      </form>
    </Panel>
  );
}

export function Notifications() {
  useLensLock(true);
  const { can } = useAuth(); const manage = can("notification:manage", null); const qc = useQueryClient(); const [form, setForm] = useState<Rule | "new" | null>(null);
  const rules = useQuery({ queryKey: ["notification-rules"], enabled: manage, refetchOnMount: "always", queryFn: () => api<Rule[]>("/notification-rules") });
  const log = useQuery({ queryKey: ["notification-log"], enabled: manage, refetchOnMount: "always", refetchInterval: 15_000, queryFn: () => api<{ id: string; to: string; title: string; status: string; emailStatus: string; severity: string; heldUntil: string | null; createdAt: string }[]>("/notification-log") });
  const toggle = useMutation({ mutationFn: (r: Rule) => api(`/notification-rules/${r.id}`, { method: "PATCH", body: { active: !r.active } }), onSuccess: () => qc.invalidateQueries({ queryKey: ["notification-rules"] }) });
  if (!manage) return (<><PageHeader title="Notifications" /><Empty title="Not available">Only HQ managers and owners set up notification rules. Your messages are in the Inbox.</Empty></>);
  return (<>
    <PageHeader title="Notifications" sub="Decide who hears about what, how, and when to keep quiet." actions={<Button variant="primary" onClick={() => setForm("new")}>New rule</Button>} />
    {form && <Form key={form === "new" ? "new" : form.id} initial={form === "new" ? undefined : form} onDone={() => setForm(null)} />}
    <Panel flush>{rules.isLoading ? <Skeleton rows={4} /> : rules.isError ? <ErrorBox error={rules.error} retry={() => rules.refetch()} /> : rules.data!.length === 0 ? <Empty title="No rules yet">Start with a rule that tells store managers about no-sales.</Empty> :
      <div className="tbl-wrap"><table className="tbl" data-testid="rules-table"><thead><tr><th>Rule</th><th>When</th><th>Where</th><th>Tell</th><th>How</th><th className="n">Sent</th><th /></tr></thead><tbody>
        {rules.data!.map((r) => <tr key={r.id} style={{ opacity: r.active ? 1 : 0.55 }}><td><b>{r.name}</b>{!r.active && <> <Chip>Paused</Chip></>}</td><td>{kindLabel(r.eventKind)}<br /><span className="muted" style={{ fontSize: 12 }}>{condText(r)}</span></td><td>{r.locations ? r.locations.join(", ") : "Every location"}</td>
          <td>{[...r.recipientRoles.map((k) => ROLES.find((x) => x[0] === k)?.[1] ?? k), ...r.recipients].join(", ")}</td><td><span className="pill-row">{r.channels.map((c) => <Chip key={c}>{c === "in_app" ? "Inbox" : r.digest ? "Daily email" : "Email"}</Chip>)}{r.quietStart && <Chip tone="info">Quiet {r.quietStart}–{r.quietEnd}</Chip>}{r.critical && <Chip tone="warn">Always</Chip>}</span></td>
          <td className="n">{r.sent}</td><td className="n"><Button size="sm" variant="ghost" onClick={() => setForm(r)}>Edit</Button><Button size="sm" variant="ghost" onClick={() => toggle.mutate(r)}>{r.active ? "Pause" : "Resume"}</Button></td></tr>)}</tbody></table></div>}</Panel>
    <Panel title="Recent deliveries" flush>{log.isLoading ? <Skeleton rows={3} /> : (log.data ?? []).length === 0 ? <Empty title="Nothing sent yet" /> :
      <div className="tbl-wrap"><table className="tbl" data-testid="log-table"><thead><tr><th>When</th><th>To</th><th>Message</th><th>Status</th></tr></thead><tbody>{log.data!.slice(0, 30).map((l) => <tr key={l.id}><td>{dateTime(l.createdAt)}</td><td>{l.to}</td><td>{l.title}</td>
        <td>{l.status === "held" ? <Chip tone="info">Held until {dateTime(l.heldUntil)}</Chip> : <Chip tone="ok">Delivered</Chip>}{l.emailStatus === "sent" && <> <Chip>Emailed</Chip></>}{l.emailStatus === "digest" && <> <Chip>In daily summary</Chip></>}</td></tr>)}</tbody></table></div>}</Panel>
  </>);
}
