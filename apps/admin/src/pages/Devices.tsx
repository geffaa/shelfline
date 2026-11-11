import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Minus, Plus } from "lucide-react";
import { Button, Callout, Chip, Select, Stepper, Switch } from "@shelfline/ui";
import { api, ApiError } from "../lib/api";
import { ago, dateTime, plain } from "../lib/format";
import { useAuth } from "../state/auth";
import { useLens, useLensLock } from "../state/lens";
import { Empty, ErrorBox, Field, PageHeader, Panel, Skeleton, TextInput } from "../ui";

interface Printer { id: string; location: string; locationId: string; register: string | null; name: string; host: string; port: number; columns: number; active: boolean; lastOkAt: string | null; lastError: string | null; waiting: number; failed: number }
interface Job { id: string; kind: string; printer: string; status: string; attempts: number; lastError: string | null; createdAt: string }
interface Reader { id: string; location: string; locationId: string; name: string; providerReaderId: string; active: boolean; provider: string }
interface CardPay { id: string; location: string; reader: string; amountMinor: number; status: string; failure: string | null; brand: string | null; last4: string | null; saleId: string | null; createdAt: string }
const ERR: Record<string, string> = { bad_host: "Use the printer's address on the store network, like 192.168.1.50, or its name. Not a web address.", printer_name_taken: "A printer with that name already exists there.", reader_name_taken: "A terminal with that name already exists there." };

function useStores() { const { locations } = useLens(); return locations.filter((l) => l.type === "store"); }

function AddPrinter({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient(); const stores = useStores(); const [loc, setLoc] = useState<string | null>(stores[0]?.id ?? null); const [name, setName] = useState("Front desk"); const [host, setHost] = useState(""); const [port, setPort] = useState(9100); const [cols, setCols] = useState(42); const [err, setErr] = useState<string | null>(null);
  const save = useMutation({ mutationFn: () => api("/printers", { method: "POST", body: { locationId: loc, name: name.trim(), host: host.trim(), port, columns: cols } }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["printers"] }); onDone(); }, onError: (e) => setErr(e instanceof ApiError ? ERR[e.code] ?? (/[/:@\s]/.test(host) ? ERR.bad_host! : "Check the address and the numbers.") : "Could not save the printer.") });
  return (<Panel title="Add a receipt printer"><form className="stack" aria-label="Add printer" onSubmit={(e) => { e.preventDefault(); setErr(null); save.mutate(); }}>
    <div className="grid2"><Select label="Store" value={loc} onChange={setLoc} options={stores.map((l) => ({ value: l.id, label: l.name }))} placeholder="Choose a store" chevron={<ChevronDown size={16} />} /><Field id="pr-name" label="Name"><TextInput id="pr-name" value={name} onChange={setName} /></Field>
      <Field id="pr-host" label="Printer address" hint="On the store network, reached through the store's bridge"><TextInput id="pr-host" value={host} onChange={setHost} placeholder="192.168.1.50" /></Field>
      <div className="stack"><div className="row-flex"><span>Port</span><Stepper label="Port" value={port} min={1} max={65535} onChange={setPort} decrementIcon={<Minus size={16} />} incrementIcon={<Plus size={16} />} /></div><div className="row-flex"><span>Characters per line</span><Stepper label="Characters per line" value={cols} min={24} max={64} onChange={setCols} decrementIcon={<Minus size={16} />} incrementIcon={<Plus size={16} />} /></div></div></div>
    {err && <p className="err" role="alert">{err}</p>}<div className="row-flex"><Button type="button" onClick={onDone}>Cancel</Button><span className="grow" /><Button variant="primary" type="submit" disabled={!loc || !name.trim() || !host.trim() || save.isPending}>Add printer</Button></div></form></Panel>);
}
function AddReader({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient(); const stores = useStores(); const [loc, setLoc] = useState<string | null>(stores[0]?.id ?? null); const [name, setName] = useState("Counter terminal"); const [rid, setRid] = useState(""); const [err, setErr] = useState<string | null>(null);
  const save = useMutation({ mutationFn: () => api("/card-readers", { method: "POST", body: { locationId: loc, name: name.trim(), providerReaderId: rid.trim() } }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["card-readers"] }); onDone(); }, onError: (e) => setErr(e instanceof ApiError ? ERR[e.code] ?? "Use letters, numbers, dots, dashes and underscores for the reader id." : "Could not save the terminal.") });
  return (<Panel title="Add a card terminal"><form className="stack" aria-label="Add card terminal" onSubmit={(e) => { e.preventDefault(); setErr(null); save.mutate(); }}>
    <div className="grid2"><Select label="Store" value={loc} onChange={setLoc} options={stores.map((l) => ({ value: l.id, label: l.name }))} placeholder="Choose a store" chevron={<ChevronDown size={16} />} /><Field id="cr-name" label="Name"><TextInput id="cr-name" value={name} onChange={setName} /></Field>
      <Field id="cr-id" label="Reader id" hint="The id the card provider gave the terminal (for Stripe, starts with tmr_). The simulated terminal accepts any id."><TextInput id="cr-id" value={rid} onChange={setRid} placeholder="tmr_..." /></Field></div>
    {err && <p className="err" role="alert">{err}</p>}<div className="row-flex"><Button type="button" onClick={onDone}>Cancel</Button><span className="grow" /><Button variant="primary" type="submit" disabled={!loc || !name.trim() || !rid.trim() || save.isPending}>Add terminal</Button></div></form></Panel>);
}

export function Devices() {
  useLensLock(true);
  const { canAny } = useAuth(); const manage = canAny("device:manage"); const qc = useQueryClient(); const [add, setAdd] = useState<"printer" | "reader" | null>(null); const [msg, setMsg] = useState<string | null>(null);
  const printers = useQuery({ queryKey: ["printers"], enabled: manage, refetchInterval: 15_000, refetchOnMount: "always", queryFn: () => api<Printer[]>("/printers") });
  const jobs = useQuery({ queryKey: ["print-jobs"], enabled: manage, refetchInterval: 15_000, refetchOnMount: "always", queryFn: () => api<Job[]>("/print-jobs") });
  const readers = useQuery({ queryKey: ["card-readers"], enabled: manage, refetchOnMount: "always", queryFn: () => api<Reader[]>("/card-readers") });
  const pays = useQuery({ queryKey: ["card-payments"], enabled: manage, refetchInterval: 15_000, refetchOnMount: "always", queryFn: () => api<CardPay[]>("/card-payments") });
  const test = useMutation({ mutationFn: (p: Printer) => api(`/printers/${p.id}/test`, { method: "POST" }), onSuccess: (_r, p) => { setMsg(`A test page is queued for ${p.name}. It prints when the store's bridge next checks in.`); void qc.invalidateQueries({ queryKey: ["print-jobs"] }); void qc.invalidateQueries({ queryKey: ["printers"] }); } });
  const retry = useMutation({ mutationFn: (id: string) => api(`/print-jobs/${id}/retry`, { method: "POST" }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["print-jobs"] }); void qc.invalidateQueries({ queryKey: ["printers"] }); } });
  const toggleP = useMutation({ mutationFn: (p: Printer) => api(`/printers/${p.id}`, { method: "PATCH", body: { active: !p.active } }), onSuccess: () => qc.invalidateQueries({ queryKey: ["printers"] }) });
  const toggleR = useMutation({ mutationFn: (r: Reader) => api(`/card-readers/${r.id}`, { method: "PATCH", body: { active: !r.active } }), onSuccess: () => qc.invalidateQueries({ queryKey: ["card-readers"] }) });
  if (!manage) return (<><PageHeader title="Printers and card terminals" /><Empty title="Not available">Only people who manage devices can set these up.</Empty></>);
  const failed = (jobs.data ?? []).filter((j) => j.status === "failed");
  return (<>
    <PageHeader title="Printers and card terminals" sub="What the till can print to and charge on, store by store" actions={<span className="row-flex"><Button onClick={() => setAdd("printer")}>Add printer</Button><Button onClick={() => setAdd("reader")}>Add card terminal</Button></span>} />
    {msg && <Callout tone="info"><span>{msg}</span></Callout>}
    {add === "printer" && <AddPrinter onDone={() => setAdd(null)} />}{add === "reader" && <AddReader onDone={() => setAdd(null)} />}
    <Panel title="Receipt printers" flush>{printers.isLoading ? <Skeleton rows={2} /> : printers.isError ? <ErrorBox error={printers.error} retry={() => printers.refetch()} /> : printers.data!.length === 0 ? <Empty title="No printers yet">Add the receipt printer on the store network. A store's bridge carries print jobs to it.</Empty> :
      <div className="tbl-wrap"><table className="tbl" data-testid="printers-table"><thead><tr><th>Printer</th><th>Store</th><th>Address</th><th>Status</th><th /></tr></thead><tbody>
        {printers.data!.map((p) => <tr key={p.id} style={{ opacity: p.active ? 1 : 0.55 }}><td><b>{p.name}</b>{!p.active && <> <Chip>Off</Chip></>}</td><td>{p.location}</td><td className="mono">{p.host}:{p.port}</td>
          <td>{p.failed > 0 ? <Chip tone="danger">{p.failed} failed</Chip> : p.waiting > 0 ? <Chip tone="info">{p.waiting} waiting</Chip> : p.lastOkAt ? <Chip tone="ok">Printed {ago(p.lastOkAt)}</Chip> : <Chip>Nothing printed yet</Chip>}{p.lastError && <div className="muted" style={{ fontSize: 12 }}>{p.lastError}</div>}</td>
          <td className="n"><Button size="sm" variant="ghost" onClick={() => test.mutate(p)} disabled={!p.active}>Test print</Button><Button size="sm" variant="ghost" onClick={() => toggleP.mutate(p)}>{p.active ? "Turn off" : "Turn on"}</Button></td></tr>)}</tbody></table></div>}</Panel>
    {failed.length > 0 && <Callout tone="warn"><span><b>{failed.length} print job{failed.length === 1 ? "" : "s"} could not be printed.</b> {failed[0]!.lastError} <Button size="sm" onClick={() => failed.forEach((j) => retry.mutate(j.id))}>Retry {failed.length === 1 ? "it" : "all"}</Button></span></Callout>}
    <Panel title="Card terminals" right={<Chip>{readers.data?.[0]?.provider === "stripe" ? "Stripe Terminal" : "Simulated terminal"}</Chip>} flush>{readers.isLoading ? <Skeleton rows={2} /> : (readers.data ?? []).length === 0 ? <Empty title="No card terminals yet">Without one, card payments are recorded by hand, as before.</Empty> :
      <div className="tbl-wrap"><table className="tbl" data-testid="readers-table"><thead><tr><th>Terminal</th><th>Store</th><th>Reader id</th><th /></tr></thead><tbody>{readers.data!.map((r) => <tr key={r.id} style={{ opacity: r.active ? 1 : 0.55 }}><td><b>{r.name}</b>{!r.active && <> <Chip>Off</Chip></>}</td><td>{r.location}</td><td className="mono">{r.providerReaderId}</td><td className="n"><Button size="sm" variant="ghost" onClick={() => toggleR.mutate(r)}>{r.active ? "Turn off" : "Turn on"}</Button></td></tr>)}</tbody></table></div>}</Panel>
    <Panel title="Recent card payments" flush>{(pays.data ?? []).length === 0 ? <Empty title="No card payments yet" /> :
      <div className="tbl-wrap"><table className="tbl" data-testid="card-payments-table"><thead><tr><th>When</th><th>Store</th><th className="n">Amount</th><th>Result</th><th>Sale</th></tr></thead><tbody>{pays.data!.slice(0, 20).map((p) => <tr key={p.id}><td>{dateTime(p.createdAt)}</td><td>{p.location}</td><td className="n">{plain(p.amountMinor)}</td>
        <td><Chip tone={p.status === "succeeded" ? "ok" : p.status === "processing" ? "info" : "warn"}>{p.status === "succeeded" ? `Approved${p.last4 ? ` ····${p.last4}` : ""}` : p.status === "failed" ? `Failed${p.failure ? `: ${p.failure.replace(/_/g, " ")}` : ""}` : p.status === "canceled" ? "Cancelled" : "Waiting"}</Chip></td><td>{p.saleId ? "Linked" : <span className="muted">—</span>}</td></tr>)}</tbody></table></div>}</Panel>
  </>);
}
