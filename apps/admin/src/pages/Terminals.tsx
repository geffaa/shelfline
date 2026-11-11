import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { Button, Callout, Chip, Select } from "@shelfline/ui";
import { api, ApiError, qs } from "../lib/api";
import { ago, time } from "../lib/format";
import { API_URL } from "../lib/api";
import { useAuth } from "../state/auth";
import { useLens, useLensLock } from "../state/lens";
import { Empty, ErrorBox, Field, PageHeader, Panel, Skeleton, TextInput } from "../ui";

interface Bridge { id: string; name: string; status: string; location: string; locationId: string; lastSeenAt: string | null; lastBatchSize: number | null; pairingExpiresAt: string | null }
interface Term { id: string; serial: string; name: string; status: string; location: string; locationId: string; lastEventAt: string | null; eventsWeek: number }
interface Ev { id: string; serial: string; personCode: string; ts: string; verify: string; reason: string }
const REASON: Record<string, string> = { unknown_person: "No one has this code", unknown_terminal: "Terminal not registered", terminal_elsewhere: "Terminal belongs to another store" };

function AddBridge({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient(); const { locations } = useLens(); const [loc, setLoc] = useState<string | null>(null); const [name, setName] = useState(""); const [made, setMade] = useState<{ pairingCode: string } | null>(null); const [err, setErr] = useState<string | null>(null);
  const save = useMutation({ mutationFn: () => api<{ pairingCode: string }>("/bridges", { method: "POST", body: { locationId: loc, name: name.trim() } }), onSuccess: (r) => { setMade(r); void qc.invalidateQueries({ queryKey: ["terminals"] }); }, onError: () => setErr("Could not create the bridge.") });
  if (made) return <Callout tone="warn"><span data-testid="pair-code"><b>Pairing code (shown once, valid 15 minutes):</b><br /><span className="mono" style={{ fontSize: 24, letterSpacing: 1 }}>{made.pairingCode}</span><br />On the bridge machine run: <span className="mono">bridge --server {API_URL} --pair {made.pairingCode}</span><br /><Button size="sm" onClick={onDone}>Done</Button></span></Callout>;
  return (<Panel title="Pair a bridge"><form className="stack" onSubmit={(e) => { e.preventDefault(); setErr(null); save.mutate(); }}>
    <div className="grid2"><Select label="Store" value={loc} onChange={setLoc} options={locations.filter((l) => l.type === "store" || l.type === "warehouse").map((l) => ({ value: l.id, label: l.name }))} placeholder="Where the terminals are" chevron={<ChevronDown size={16} />} /><Field id="br-n" label="Name"><TextInput id="br-n" value={name} onChange={setName} placeholder="e.g. Back office mini PC" /></Field></div>
    {err && <p className="err" role="alert">{err}</p>}<div className="row-flex"><Button onClick={onDone}>Cancel</Button><span className="grow" /><Button variant="primary" type="submit" disabled={!loc || !name.trim() || save.isPending}>Create pairing code</Button></div></form></Panel>);
}
function AddTerminal({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient(); const { locations } = useLens(); const [loc, setLoc] = useState<string | null>(null); const [serial, setSerial] = useState(""); const [name, setName] = useState(""); const [err, setErr] = useState<string | null>(null);
  const save = useMutation({ mutationFn: () => api("/terminals", { method: "POST", body: { locationId: loc, serial: serial.trim(), name: name.trim() } }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["terminals"] }); onDone(); }, onError: (e) => setErr(e instanceof ApiError && e.code === "serial_taken" ? "That serial number is already registered." : "Could not add the terminal.") });
  return (<Panel title="Register a terminal"><form className="stack" onSubmit={(e) => { e.preventDefault(); setErr(null); save.mutate(); }}>
    <div className="grid2"><Select label="Store" value={loc} onChange={setLoc} options={locations.filter((l) => l.type === "store" || l.type === "warehouse").map((l) => ({ value: l.id, label: l.name }))} placeholder="Where it hangs" chevron={<ChevronDown size={16} />} /><Field id="tm-s" label="Serial number" hint="Printed on the terminal and shown in its menu"><TextInput id="tm-s" value={serial} onChange={setSerial} /></Field><Field id="tm-n" label="Name"><TextInput id="tm-n" value={name} onChange={setName} placeholder="e.g. Staff door" /></Field></div>
    <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>People are enrolled on the terminal itself. Shelfline only receives who clocked and when: never a fingerprint.</p>
    {err && <p className="err" role="alert">{err}</p>}<div className="row-flex"><Button onClick={onDone}>Cancel</Button><span className="grow" /><Button variant="primary" type="submit" disabled={!loc || serial.trim().length < 3 || !name.trim() || save.isPending}>Register terminal</Button></div></form></Panel>);
}

function Review({ loc, tz }: { loc: string; tz: string | undefined }) {
  const qc = useQueryClient(); const { can } = useAuth(); const w = can("timesheet:approve", loc); const q = useQuery({ queryKey: ["tevents", loc], queryFn: () => api<Ev[]>(`/terminal-events${qs({ locationId: loc })}`) });
  const users = useQuery({ queryKey: ["users"], queryFn: () => api<{ id: string; name: string; status: string; assignments: { locationId: string | null }[] }[]>("/users") }); const [who, setWho] = useState<Record<string, string | null>>({});
  const people = (users.data ?? []).filter((u) => u.status === "active" && u.assignments.some((a) => a.locationId === null || a.locationId === loc));
  const done = () => { void qc.invalidateQueries({ queryKey: ["tevents", loc] }); void qc.invalidateQueries({ queryKey: ["timesheets"] }); };
  const resolve = useMutation({ mutationFn: (e: Ev) => api(`/terminal-events/${e.id}/resolve`, { method: "POST", body: { userId: who[e.id] } }), onSuccess: done }); const dismiss = useMutation({ mutationFn: (e: Ev) => api(`/terminal-events/${e.id}/dismiss`, { method: "POST" }), onSuccess: done });
  return (<Panel title="Held for review" flush>{q.isLoading ? <Skeleton rows={3} /> : q.isError ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : q.data!.length === 0 ? <Empty title="Nothing held">Records from a terminal that cannot be matched to a person or a registered terminal wait here.</Empty> :
    <div className="tbl-wrap"><table className="tbl" data-testid="held-table"><thead><tr><th>When</th><th>Terminal</th><th>Code</th><th>Why</th><th /></tr></thead><tbody>{q.data!.map((e) => <tr key={e.id}><td className="mono">{time(e.ts, tz)} <span className="muted">{new Date(e.ts).toLocaleDateString("en-AU", { day: "numeric", month: "short", timeZone: tz })}</span></td><td>{e.serial}</td><td className="mono">{e.personCode}</td><td><Chip tone="warn">{REASON[e.reason] ?? e.reason}</Chip></td>
      <td className="n">{w && <span className="row-flex" style={{ justifyContent: "flex-end" }}><Select label={`Person for code ${e.personCode}`} value={who[e.id] ?? null} onChange={(v) => setWho((x) => ({ ...x, [e.id]: v }))} options={people.map((p) => ({ value: p.id, label: p.name }))} placeholder="This is…" chevron={<ChevronDown size={16} />} /><Button size="sm" variant="primary" disabled={!who[e.id]} onClick={() => resolve.mutate(e)}>Record punch</Button><Button size="sm" variant="ghost" onClick={() => dismiss.mutate(e)}>Dismiss</Button></span>}</td></tr>)}</tbody></table></div>}</Panel>);
}

export function Terminals() {
  useLensLock(false);
  const { lens, selected } = useLens(); const qc = useQueryClient(); const { canAny } = useAuth(); const [add, setAdd] = useState<"bridge" | "terminal" | null>(null);
  const q = useQuery({ queryKey: ["terminals"], queryFn: () => api<{ bridges: Bridge[]; terminals: Term[] }>("/terminals"), refetchInterval: 30_000 });
  const revoke = useMutation({ mutationFn: (p: { kind: "bridges" | "terminals"; id: string }) => api(`/${p.kind}/${p.id}/revoke`, { method: "POST" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["terminals"] }) });
  const repair = useMutation({ mutationFn: (id: string) => api<{ pairingCode: string }>(`/bridges/${id}/pairing`, { method: "POST" }), onSuccess: (r) => { window.alert(`New pairing code: ${r.pairingCode}\nValid 15 minutes. Run the bridge with --pair ${r.pairingCode}`); void qc.invalidateQueries({ queryKey: ["terminals"] }); } });
  const stale = (iso: string | null) => !iso || Date.now() - new Date(iso).getTime() > 15 * 60_000;
  return (<>
    <PageHeader title="Attendance terminals" sub="Fingerprint terminals on the store network, and the small bridge that carries their records here" actions={canAny("device:manage") && <span className="row-flex"><Button onClick={() => setAdd("terminal")}>Register a terminal</Button><Button variant="primary" onClick={() => setAdd("bridge")}>Pair a bridge</Button></span>} />
    {add === "bridge" && <AddBridge onDone={() => setAdd(null)} />}{add === "terminal" && <AddTerminal onDone={() => setAdd(null)} />}
    <Panel title="Bridges" flush>{q.isLoading ? <Skeleton rows={2} /> : q.isError ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : q.data!.bridges.length === 0 ? <Empty title="No bridge yet">A bridge is a small program on a PC in the store. It receives the terminals' records and forwards them, even through an internet outage.</Empty> :
      <div className="tbl-wrap"><table className="tbl" data-testid="bridges-table"><thead><tr><th>Bridge</th><th>Store</th><th>Status</th><th>Last heard</th><th /></tr></thead><tbody>{q.data!.bridges.map((b) => <tr key={b.id}><td><b>{b.name}</b></td><td>{b.location}</td>
        <td>{b.status === "active" ? <Chip tone={stale(b.lastSeenAt) ? "warn" : "ok"}>{stale(b.lastSeenAt) ? "Quiet" : "Online"}</Chip> : b.status === "pending" ? <Chip tone="info">Waiting to pair</Chip> : <Chip tone="danger">Revoked</Chip>}</td><td>{b.lastSeenAt ? `${ago(b.lastSeenAt)}${b.lastBatchSize ? ` · ${b.lastBatchSize} record${b.lastBatchSize === 1 ? "" : "s"}` : ""}` : "—"}</td>
        <td className="n">{b.status !== "revoked" && <span className="row-flex" style={{ justifyContent: "flex-end" }}>{b.status === "pending" && <Button size="sm" onClick={() => repair.mutate(b.id)}>New code</Button>}<Button size="sm" variant="ghost" onClick={() => revoke.mutate({ kind: "bridges", id: b.id })}>Revoke</Button></span>}</td></tr>)}</tbody></table></div>}</Panel>
    <Panel title="Terminals" flush>{q.data && (q.data.terminals.length === 0 ? <Empty title="No terminal registered">Add each terminal by its serial number so its records are accepted.</Empty> :
      <div className="tbl-wrap"><table className="tbl" data-testid="terminals-table"><thead><tr><th>Terminal</th><th>Serial</th><th>Store</th><th>Last record</th><th className="n">This week</th><th /></tr></thead><tbody>{q.data.terminals.map((t) => <tr key={t.id}><td><b>{t.name}</b>{t.status === "revoked" && <> <Chip tone="danger">Revoked</Chip></>}</td><td className="mono">{t.serial}</td><td>{t.location}</td><td>{t.lastEventAt ? ago(t.lastEventAt) : "—"}</td><td className="n">{t.eventsWeek}</td><td className="n">{t.status === "active" && <Button size="sm" variant="ghost" onClick={() => revoke.mutate({ kind: "terminals", id: t.id })}>Revoke</Button>}</td></tr>)}</tbody></table></div>)}</Panel>
    {lens !== "all" ? <Review loc={lens} tz={selected?.timezone} /> : <Callout tone="info"><span>Choose a store in the rail to see records held for review there.</span></Callout>}
  </>);
}
