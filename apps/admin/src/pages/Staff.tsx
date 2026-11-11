import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Plus, Trash2, X } from "lucide-react";
import { Button, Chip, Select } from "@shelfline/ui";
import { api, ApiError } from "../lib/api";
import { navigate, useRoute } from "../router";
import { useAuth } from "../state/auth";
import { useLens, useLensLock } from "../state/lens";
import { Empty, ErrorBox, Field, PageHeader, Panel, Skeleton, TextInput } from "../ui";

interface U { id: string; email: string; name: string; status: string; employeeCode: string | null; terminalPersonCode?: string | null; assignments: { role: string; locationId: string | null }[] }
interface Role { key: string; name: string; permissions: string[] }
type Asg = { role: string; locationId: string | null };

function Assignments({ value, onChange, roles }: { value: Asg[]; onChange: (v: Asg[]) => void; roles: Role[] }) {
  const { locations } = useLens();
  const locOpts = [{ value: "all", label: "All locations" }, ...locations.map((l) => ({ value: l.id, label: l.name }))];
  return (
    <div className="stack">
      {value.map((a, i) => <div key={i} className="row-flex" data-testid="assignment-row">
        <Select label={`Role ${i + 1}`} value={a.role} onChange={(r) => onChange(value.map((x, j) => (j === i ? { ...x, role: r } : x)))} options={roles.map((r) => ({ value: r.key, label: r.name }))} chevron={<ChevronDown size={16} />} />
        <Select label={`Location ${i + 1}`} value={a.locationId ?? "all"} onChange={(l) => onChange(value.map((x, j) => (j === i ? { ...x, locationId: l === "all" ? null : l } : x)))} options={locOpts} chevron={<ChevronDown size={16} />} />
        <Button size="sm" variant="ghost" aria-label={`Remove assignment ${i + 1}`} onClick={() => onChange(value.filter((_, j) => j !== i))}><Trash2 size={14} /></Button></div>)}
      <div><Button size="sm" onClick={() => onChange([...value, { role: roles.find((r) => r.key === "cashier")?.key ?? roles[0]!.key, locationId: locations[0]?.id ?? null }])}><Plus size={14} />Add a role</Button></div>
    </div>
  );
}

function Detail({ u, roles, onClose }: { u: U; roles: Role[]; onClose: () => void }) {
  const qc = useQueryClient(); const { me } = useAuth(); const { locations } = useLens();
  const [asg, setAsg] = useState<Asg[]>(u.assignments); const [pin, setPin] = useState(""); const [msg, setMsg] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  const [tcode, setTcode] = useState(u.terminalPersonCode ?? "");
  const setTcodeM = useMutation({ mutationFn: () => api(`/users/${u.id}/terminal-code`, { method: "PUT", body: { code: tcode.trim() || null } }), onSuccess: () => { setMsg(tcode.trim() ? "Terminal code saved." : "Terminal code cleared: the staff code is used."); setErr(null); void qc.invalidateQueries({ queryKey: ["users"] }); }, onError: (e) => setErr(e instanceof ApiError && e.code === "person_code_taken" ? "Another person already uses that code on the terminals." : "Could not save the terminal code.") });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["users"] }); };
  const server = JSON.stringify(u.assignments); useEffect(() => { setAsg(u.assignments); }, [server]); // eslint-disable-line react-hooks/exhaustive-deps
  const err409 = (e: unknown) => setErr(e instanceof ApiError && e.code === "last_owner" ? "That would leave the organisation without an owner." : e instanceof ApiError && e.status === 403 ? "You do not have permission to do that." : "Could not save.");
  const save = useMutation({ mutationFn: () => api(`/users/${u.id}/assignments`, { method: "PUT", body: { assignments: asg } }), onSuccess: () => { setMsg("Roles saved. They apply on the person's next action."); setErr(null); refresh(); }, onError: err409 });
  const setPinM = useMutation({ mutationFn: () => api(`/users/${u.id}/pin`, { method: "POST", body: { pin } }), onSuccess: () => { setPin(""); setMsg("PIN set. It also clears any lock."); setErr(null); }, onError: () => setErr("A PIN is 4 to 8 digits.") });
  const disable = useMutation({ mutationFn: () => api(`/users/${u.id}/disable`, { method: "POST" }), onSuccess: () => { refresh(); onClose(); }, onError: err409 });
  const name = (l: string | null) => l ? locations.find((x) => x.id === l)?.name ?? "—" : "All locations";
  return (
    <section className="panel detail" aria-label={u.name}>
      <div className="drawer-head"><h2>{u.name}</h2><button className="btn ghost sm" aria-label="Close details" onClick={onClose}><X size={16} /></button></div>
      <div className="pb stack">
        <dl className="kv"><dt>Email</dt><dd>{u.email}</dd><dt>Employee code</dt><dd>{u.employeeCode ?? <span className="muted">no till access</span>}</dd><dt>Status</dt><dd>{u.status === "active" ? <Chip tone="ok">Active</Chip> : <Chip>Disabled</Chip>}</dd></dl>
        <b>Roles and where they apply</b>
        <Assignments value={asg} onChange={(v) => { setAsg(v); setMsg(null); }} roles={roles} />
        <div className="muted" style={{ fontSize: 12.5 }}>Currently: {u.assignments.map((a) => `${a.role.replace(/_/g, " ")} @ ${name(a.locationId)}`).join("; ") || "no roles"}</div>
        <div><Button variant="primary" onClick={() => save.mutate()} disabled={save.isPending}>Save roles</Button></div>
        {u.employeeCode && <><hr className="perf" /><b>Till PIN</b><div className="row-flex"><div className="input" style={{ width: 160 }}><input aria-label="New PIN" type="password" inputMode="numeric" autoComplete="off" placeholder="4-8 digits" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))} /></div><Button onClick={() => setPinM.mutate()} disabled={pin.length < 4 || setPinM.isPending}>Set PIN</Button></div></>}
        {u.employeeCode && <><hr className="perf" /><b>Attendance terminal</b><div className="row-flex"><div className="input" style={{ width: 200 }}><input aria-label="Terminal code" value={tcode} onChange={(e) => setTcode(e.target.value)} placeholder={`Same as staff code (${u.employeeCode})`} /></div><Button onClick={() => setTcodeM.mutate()} disabled={setTcodeM.isPending}>Save</Button></div><span className="muted" style={{ fontSize: 12.5 }}>The number this person has on the fingerprint terminal, if it is not their staff code. Fingerprints stay on the terminal; Shelfline never holds them.</span></>}
        {msg && <div className="callout info" role="status"><div>{msg}</div></div>}{err && <p className="err" role="alert">{err}</p>}
        {u.status === "active" && u.id !== me?.user.id && <><hr className="perf" /><Button variant="ghost" onClick={() => { if (confirm(`Disable ${u.name}? They are signed out immediately and their PIN stops working. History is kept.`)) disable.mutate(); }}>Disable this person</Button></>}
      </div>
    </section>
  );
}

function NewUser({ roles, onDone, onCancel }: { roles: Role[]; onDone: (id: string) => void; onCancel: () => void }) {
  const qc = useQueryClient(); const { locations } = useLens();
  const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [code, setCode] = useState(""); const [pin, setPin] = useState(""); const [asg, setAsg] = useState<Asg[]>([{ role: "cashier", locationId: locations[0]?.id ?? null }]); const [err, setErr] = useState<string | null>(null);
  const save = useMutation({ mutationFn: () => api<{ id: string }>("/users", { method: "POST", body: { name: name.trim(), email: email.trim(), ...(password ? { password } : {}), ...(code ? { employeeCode: code.trim() } : {}), ...(pin ? { pin } : {}), assignments: asg } }), onSuccess: (u) => { void qc.invalidateQueries({ queryKey: ["users"] }); onDone(u.id); }, onError: (e) => setErr(e instanceof ApiError && e.status === 409 ? "Someone already has that email or employee code." : "Check the details: a password needs 12+ characters, a PIN 4-8 digits and needs an employee code.") });
  return (
    <section className="panel detail" aria-label="New person">
      <div className="drawer-head"><h2>New person</h2><button className="btn ghost sm" aria-label="Cancel" onClick={onCancel}><X size={16} /></button></div>
      <form className="pb stack" onSubmit={(e) => { e.preventDefault(); setErr(null); save.mutate(); }}>
        <Field id="un" label="Name"><TextInput id="un" value={name} onChange={setName} required autoFocus /></Field>
        <Field id="ue" label="Email"><TextInput id="ue" type="email" value={email} onChange={setEmail} required /></Field>
        <Field id="up" label="Password" hint="Only for people who sign in to this back office. 12 characters or more."><TextInput id="up" type="password" value={password} onChange={setPassword} autoComplete="new-password" /></Field>
        <div className="row-flex"><Field id="uc" label="Employee code" hint="For the till"><TextInput id="uc" value={code} onChange={setCode} /></Field><Field id="upin" label="Till PIN" hint="4-8 digits"><TextInput id="upin" type="password" inputMode="numeric" value={pin} onChange={(v) => setPin(v.replace(/\D/g, "").slice(0, 8))} autoComplete="off" /></Field></div>
        <b>Roles</b><Assignments value={asg} onChange={setAsg} roles={roles} />
        {err && <p className="err" role="alert">{err}</p>}
        <div className="row-flex"><Button onClick={onCancel}>Cancel</Button><span className="grow" /><Button variant="primary" type="submit" disabled={!name.trim() || !email.trim() || save.isPending}>Create person</Button></div>
      </form>
    </section>
  );
}

export function Staff() {
  useLensLock(true); const route = useRoute(); const { can, canAny } = useAuth(); const { locations } = useLens(); const [creating, setCreating] = useState(false);
  const users = useQuery({ queryKey: ["users"], queryFn: () => api<U[]>("/users") }); const roles = useQuery({ queryKey: ["roles"], queryFn: () => api<Role[]>("/roles"), enabled: canAny("role:read") });
  const sel = users.data?.find((u) => u.id === route.id); const canManage = can("user:manage"); const locName = (l: string | null) => (l ? locations.find((x) => x.id === l)?.name ?? "—" : "All locations");
  return (<>
    <PageHeader title="Staff & roles" sub="People, what they may do, and where" actions={canManage ? <Button variant="primary" onClick={() => setCreating(true)}><Plus size={14} />New person</Button> : undefined} />
    <div className={`md${sel || creating ? "" : " single"}`}>
      <Panel flush>{users.isLoading ? <Skeleton rows={5} /> : users.isError ? <ErrorBox error={users.error} retry={() => users.refetch()} /> : users.data!.length === 0 ? <Empty title="No people yet">Add the first person.</Empty> :
        <div className="tbl-wrap"><table className="tbl" data-testid="staff-table"><thead><tr><th>Name</th><th>Code</th><th>Roles</th><th>Status</th></tr></thead><tbody>{users.data!.map((u) => <tr key={u.id} className="clickable" tabIndex={0} aria-selected={route.id === u.id} onClick={() => { setCreating(false); navigate("people", "staff", u.id); }} onKeyDown={(e) => { if (e.key === "Enter") navigate("people", "staff", u.id); }}>
          <td><b>{u.name}</b><br /><span className="muted">{u.email}</span></td><td className="mono">{u.employeeCode ?? "—"}</td><td style={{ whiteSpace: "normal" }}><span className="pill-row">{u.assignments.length === 0 ? <span className="muted">none</span> : u.assignments.map((a, i) => <Chip key={i}>{a.role.replace(/_/g, " ")} · {locName(a.locationId)}</Chip>)}</span></td><td>{u.status === "active" ? <Chip tone="ok">Active</Chip> : <Chip>Disabled</Chip>}</td></tr>)}</tbody></table></div>}</Panel>
      {creating && roles.data ? <NewUser roles={roles.data} onCancel={() => setCreating(false)} onDone={(id) => { setCreating(false); navigate("people", "staff", id); }} /> : sel && roles.data && canManage ? <Detail key={sel.id} u={sel} roles={roles.data} onClose={() => navigate("people", "staff")} /> : null}
    </div>
    {roles.data && <Panel title="Roles" right={<span className="muted">fixed roles; permissions are read-only</span>}><div className="stack">{roles.data.map((r) => <div key={r.key}><b>{r.name}</b><div className="pill-row" style={{ marginTop: 4 }}>{r.permissions.map((p) => <Chip key={p}>{p}</Chip>)}</div></div>)}</div></Panel>}
  </>);
}
