import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Copy, Plus, X } from "lucide-react";
import { Button, Callout, Chip, Select, Switch } from "@shelfline/ui";
import { api, ApiError, qs } from "../lib/api";
import { ago, money } from "../lib/format";
import { navigate, useRoute } from "../router";
import { useAuth } from "../state/auth";
import { useLens, useLensLock } from "../state/lens";
import { Empty, ErrorBox, Field, PageHeader, Panel, Skeleton, TextInput } from "../ui";

const ZONES = ["Australia/Melbourne", "Australia/Sydney", "Australia/Brisbane", "Australia/Adelaide", "Australia/Perth", "Pacific/Auckland", "Asia/Jakarta", "Asia/Singapore", "Europe/London", "America/New_York"];
const cents = (s: string): number | null => { const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(s.trim()); return m ? Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0") : null; };

function Registers({ id, canWrite }: { id: string; canWrite: boolean }) {
  const qc = useQueryClient(); const [code, setCode] = useState(""); const [name, setName] = useState(""); const [err, setErr] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["registers", id], queryFn: () => api<any[]>(`/locations/${id}/registers`) });
  const add = useMutation({ mutationFn: () => api(`/locations/${id}/registers`, { method: "POST", body: { code: code.trim(), name: name.trim() } }), onSuccess: () => { setCode(""); setName(""); void qc.invalidateQueries({ queryKey: ["registers", id] }); }, onError: (e) => setErr(e instanceof ApiError && e.status === 409 ? "That register code is already used." : "A code is 2-16 letters, digits or dashes.") });
  return (<Panel title="Registers">{q.isLoading ? <Skeleton rows={2} /> : <>{q.data!.length === 0 ? <span className="muted">No registers yet.</span> : q.data!.map((r) => <div className="lead" key={r.id}><span><b className="mono">{r.code}</b> · {r.name}</span><i /><Chip tone={r.status === "active" ? "ok" : undefined}>{r.status}</Chip></div>)}
    {canWrite && <form className="row-flex" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); setErr(null); add.mutate(); }}><div className="input"><input aria-label="Register code" placeholder="Code, e.g. FIT-3" value={code} onChange={(e) => setCode(e.target.value)} /></div><div className="input"><input aria-label="Register name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} /></div><Button type="submit" disabled={!code || !name || add.isPending}>Add register</Button></form>}{err && <p className="err" role="alert">{err}</p>}</>}</Panel>);
}

function Devices({ id, canWrite }: { id: string; canWrite: boolean }) {
  const qc = useQueryClient(); const regs = useQuery({ queryKey: ["registers", id], queryFn: () => api<any[]>(`/locations/${id}/registers`) }); const q = useQuery({ queryKey: ["devices", id], queryFn: () => api<any[]>(`/devices${qs({ locationId: id })}`), enabled: canWrite });
  const [name, setName] = useState(""); const [reg, setReg] = useState<string | null>(null); const [key, setKey] = useState<{ key: string; name: string } | null>(null);
  const add = useMutation({ mutationFn: () => api<any>("/devices", { method: "POST", body: { kind: "pos", locationId: id, registerId: reg ?? undefined, name: name.trim() } }), onSuccess: (d) => { setKey({ key: d.key, name: d.name }); setName(""); void qc.invalidateQueries({ queryKey: ["devices", id] }); } });
  const revoke = useMutation({ mutationFn: (d: string) => api(`/devices/${d}/revoke`, { method: "POST" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["devices", id] }) });
  if (!canWrite) return null;
  return (<Panel title="Devices">
    {key && <Callout tone="warn"><span><b>Copy this key now. It is shown once.</b> Enter it on {key.name} when pairing the iPad.<div className="row-flex" style={{ marginTop: 8 }}><code className="mono" data-testid="device-key" style={{ padding: "6px 8px", background: "var(--surface)", borderRadius: 6, overflowWrap: "anywhere" }}>{key.key}</code><Button size="sm" onClick={() => void navigator.clipboard?.writeText(key.key)}><Copy size={14} />Copy</Button><Button size="sm" variant="ghost" onClick={() => setKey(null)}>I have saved it</Button></div></span></Callout>}
    {q.isLoading ? <Skeleton rows={2} /> : q.data!.length === 0 ? <span className="muted">No devices yet.</span> : q.data!.map((d) => <div className="lead" key={d.id}><span><b>{d.name}</b> <span className="muted">{d.kind}{d.registerId ? ` · ${regs.data?.find((r) => r.id === d.registerId)?.code ?? ""}` : ""} · seen {ago(d.lastSeenAt)}</span></span><i />{d.status === "active" ? <Button size="sm" variant="ghost" onClick={() => { if (confirm(`Revoke ${d.name}? It stops working immediately.`)) revoke.mutate(d.id); }}>Revoke</Button> : <Chip>Revoked</Chip>}</div>)}
    <form className="row-flex" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); add.mutate(); }}><div className="input"><input aria-label="Device name" placeholder="Device name, e.g. iPad FIT-3" value={name} onChange={(e) => setName(e.target.value)} /></div><Select label="Register" value={reg} onChange={setReg} options={(regs.data ?? []).map((r) => ({ value: r.id, label: r.code }))} placeholder="Register" chevron={<ChevronDown size={16} />} /><Button type="submit" variant="primary" disabled={!name || !reg || add.isPending}><Plus size={14} />Add POS device</Button></form></Panel>);
}

function Detail({ l, onClose }: { l: any; onClose: () => void }) {
  const qc = useQueryClient(); const { can } = useAuth(); const w = can("location:write", l.id);
  const [name, setName] = useState(l.name); const [tz, setTz] = useState(l.timezone); const [cutoff, setCutoff] = useState(String(l.dayCutoff).slice(0, 5)); const [region, setRegion] = useState(l.taxRegion ?? "");
  const [disc, setDisc] = useState(String(l.cashierDiscountLimitBp / 100)); const [refund, setRefund] = useState((l.cashierRefundLimitMinor / 100).toFixed(2)); const [variance, setVariance] = useState((l.cashVarianceLimitMinor / 100).toFixed(2)); const [giftOff, setGiftOff] = useState(!!l.giftCardOffline); const [pickup, setPickup] = useState(!!(l as { pickupEnabled?: boolean }).pickupEnabled); const [giftCap, setGiftCap] = useState(((l.giftCardOfflineCapMinor ?? 5000) / 100).toFixed(2)); const [active, setActive] = useState(l.status === "active"); const [msg, setMsg] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  const save = useMutation({ mutationFn: () => api(`/locations/${l.id}`, { method: "PATCH", body: { name: name.trim(), timezone: tz.trim(), dayCutoff: cutoff, taxRegion: region.trim(), status: active ? "active" : "inactive", cashierDiscountLimitBp: Math.round(Number(disc) * 100), cashierRefundLimitMinor: cents(refund) ?? 0, cashVarianceLimitMinor: cents(variance) ?? 0, giftCardOffline: giftOff, giftCardOfflineCapMinor: cents(giftCap) ?? 0, pickupEnabled: pickup } }),
    onSuccess: () => { setMsg("Saved. Tills receive the new limits on their next sync."); setErr(null); void qc.invalidateQueries({ queryKey: ["locations"] }); void qc.invalidateQueries({ queryKey: ["locations-status"] }); },
    onError: (e) => setErr(e instanceof ApiError && e.code === "open_sessions" ? "A register is still open here. Close it first." : e instanceof ApiError && e.status === 400 ? "Check the time zone (like Australia/Perth), the cutoff (HH:MM) and the amounts." : "Could not save.") });
  return (<>
    <section className="panel" aria-label={l.name}>
      <div className="drawer-head"><h2>{l.name}</h2><button className="btn ghost sm" aria-label="Close details" onClick={onClose}><X size={16} /></button></div>
      <form className="pb stack" onSubmit={(e) => { e.preventDefault(); setMsg(null); save.mutate(); }}>
        <dl className="kv"><dt>Code</dt><dd className="mono">{l.code}</dd><dt>Type</dt><dd>{l.type}</dd></dl>
        <Field id="ln" label="Name"><TextInput id="ln" value={name} onChange={setName} disabled={!w} /></Field>
        <Field id="lz" label="Time zone" hint="Sets the business day and when end-of-day reports are cut."><TextInput id="lz" value={tz} onChange={setTz} disabled={!w} /></Field>
        <div className="pill-row">{ZONES.map((z) => <button type="button" key={z} className="chip" onClick={() => w && setTz(z)} disabled={!w} style={{ cursor: w ? "pointer" : "default" }}>{z.split("/")[1]!.replace(/_/g, " ")}</button>)}</div>
        <div className="row-flex"><Field id="lc" label="Business day starts" hint="Sales before this time count for the previous day"><TextInput id="lc" value={cutoff} onChange={setCutoff} disabled={!w} placeholder="04:00" /></Field><Field id="lr" label="Tax region" hint="Optional, e.g. AU-WA"><TextInput id="lr" value={region} onChange={setRegion} disabled={!w} /></Field></div>
        <b>Limits for the till</b>
        <div className="row-flex"><Field id="ld" label="Discount a cashier may give (%)"><TextInput id="ld" value={disc} onChange={setDisc} inputMode="decimal" disabled={!w} /></Field><Field id="lrf" label="Refund a cashier may give (A$)"><TextInput id="lrf" value={refund} onChange={setRefund} inputMode="decimal" disabled={!w} /></Field><Field id="lv" label="Cash count tolerance (A$)"><TextInput id="lv" value={variance} onChange={setVariance} inputMode="decimal" disabled={!w} /></Field></div>
        <b>Gift cards when the till is offline</b>
        <Switch checked={giftOff} onChange={(v) => w && setGiftOff(v)}>Accept gift cards without a connection (the balance cannot be checked)</Switch>
        {giftOff && <Field id="lgc" label="Most one offline gift card payment may take (A$)" hint="Each card can be used once per iPad while offline. A card that turns out to be short is flagged as an overdraft."><TextInput id="lgc" value={giftCap} onChange={setGiftCap} inputMode="decimal" disabled={!w} /></Field>}
        <b>Online store</b>
        <Switch checked={pickup} onChange={(v) => w && setPickup(v)}>Customers can reserve online and collect here</Switch>
        <Switch checked={active} onChange={(v) => w && setActive(v)}>Location is active</Switch>
        {msg && <div className="callout info" role="status"><div>{msg}</div></div>}{err && <p className="err" role="alert">{err}</p>}
        {w && <div><Button variant="primary" type="submit" disabled={save.isPending}>Save changes</Button></div>}
      </form>
    </section>
    {l.type === "store" && <><Registers id={l.id} canWrite={can("register:write", l.id)} /><Devices id={l.id} canWrite={can("device:manage", l.id)} /></>}
  </>);
}

function NewLocation({ onDone, onCancel }: { onDone: (id: string) => void; onCancel: () => void }) {
  const qc = useQueryClient(); const [code, setCode] = useState(""); const [name, setName] = useState(""); const [type, setType] = useState<"store" | "warehouse">("store"); const [tz, setTz] = useState("Australia/Melbourne"); const [err, setErr] = useState<string | null>(null);
  const save = useMutation({ mutationFn: () => api<any>("/locations", { method: "POST", body: { code: code.trim(), name: name.trim(), type, timezone: tz.trim() } }), onSuccess: (l) => { void qc.invalidateQueries({ queryKey: ["locations"] }); void qc.invalidateQueries({ queryKey: ["locations-status"] }); onDone(l.id); }, onError: (e) => setErr(e instanceof ApiError && e.status === 409 ? "That location code is already used." : "Check the code (2-16 letters, digits or dashes) and the time zone (like Australia/Perth).") });
  return (
    <section className="panel detail" aria-label="New location">
      <div className="drawer-head"><h2>New location</h2><button className="btn ghost sm" aria-label="Cancel" onClick={onCancel}><X size={16} /></button></div>
      <form className="pb stack" onSubmit={(e) => { e.preventDefault(); setErr(null); save.mutate(); }}>
        <Field id="nc" label="Code" hint="Short and unique, e.g. FRE"><TextInput id="nc" value={code} onChange={setCode} required autoFocus /></Field>
        <Field id="nn" label="Name"><TextInput id="nn" value={name} onChange={setName} required /></Field>
        <div><div className="lbl" style={{ marginBottom: 4 }}>Type</div><Select label="Location type" value={type} onChange={setType} options={[{ value: "store", label: "Store" }, { value: "warehouse", label: "Warehouse" }]} chevron={<ChevronDown size={16} />} /></div>
        <Field id="nz" label="Time zone"><TextInput id="nz" value={tz} onChange={setTz} /></Field>
        <div className="pill-row">{ZONES.slice(0, 7).map((z) => <button type="button" key={z} className="chip" onClick={() => setTz(z)} style={{ cursor: "pointer" }}>{z.split("/")[1]!.replace(/_/g, " ")}</button>)}</div>
        {err && <p className="err" role="alert">{err}</p>}
        <div className="row-flex"><Button onClick={onCancel}>Cancel</Button><span className="grow" /><Button variant="primary" type="submit" disabled={!code || !name || save.isPending}>Create location</Button></div>
      </form>
    </section>
  );
}

export function Locations() {
  useLensLock(true); const route = useRoute(); const { can } = useAuth(); const [creating, setCreating] = useState(false); const { locations } = useLens(); void locations;
  const list = useQuery({ queryKey: ["locations"], queryFn: () => api<any[]>("/locations") }); const sel = list.data?.find((l) => l.id === route.id);
  return (<>
    <PageHeader title="Locations" sub="Stores and warehouses, their registers and tills" actions={can("location:write") ? <Button variant="primary" onClick={() => setCreating(true)}><Plus size={14} />New location</Button> : undefined} />
    <div className={`md${sel || creating ? "" : " single"}`}>
      <Panel flush>{list.isLoading ? <Skeleton rows={4} /> : list.isError ? <ErrorBox error={list.error} retry={() => list.refetch()} /> : list.data!.length === 0 ? <Empty title="No locations yet">Create the first store.</Empty> :
        <div className="tbl-wrap"><table className="tbl" data-testid="locations-table"><thead><tr><th>Location</th><th>Type</th><th>Time zone</th><th className="n">Refund limit</th><th>Status</th></tr></thead><tbody>{list.data!.map((l) => <tr key={l.id} className="clickable" tabIndex={0} aria-selected={route.id === l.id} onClick={() => { setCreating(false); navigate("admin", "locations", l.id); }} onKeyDown={(e) => { if (e.key === "Enter") navigate("admin", "locations", l.id); }}><td><b>{l.name}</b><br /><span className="mono muted">{l.code}</span></td><td>{l.type}</td><td>{l.timezone}</td><td className="n">{money(l.cashierRefundLimitMinor)}</td><td>{l.status === "active" ? <Chip tone="ok">Active</Chip> : <Chip>Inactive</Chip>}</td></tr>)}</tbody></table></div>}</Panel>
      {creating ? <NewLocation onCancel={() => setCreating(false)} onDone={(id) => { setCreating(false); navigate("admin", "locations", id); }} /> : sel ? <div className="stack detail" style={{ minWidth: 0 }}><Detail key={sel.id} l={sel} onClose={() => navigate("admin", "locations")} /></div> : null}
    </div>
  </>);
}
