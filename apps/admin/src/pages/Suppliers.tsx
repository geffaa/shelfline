import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Minus, Plus, Search } from "lucide-react";
import { Button, Chip, Segmented, Stepper } from "@shelfline/ui";
import { api, ApiError, qs } from "../lib/api";
import { money } from "../lib/format";
import { useAuth } from "../state/auth";
import { useLensLock } from "../state/lens";
import { Empty, ErrorBox, Field, PageHeader, Panel, Skeleton, TextInput } from "../ui";

interface Sup { id: string; name: string; contactName: string | null; email: string | null; phone: string | null; termsDays: number; leadTimeDays: number; status: string; note: string | null; openBills: number; owedMinor: number; openOrders: number }

function Form({ s, onDone }: { s?: Sup; onDone: () => void }) {
  const qc = useQueryClient(); const [name, setName] = useState(s?.name ?? ""); const [contact, setContact] = useState(s?.contactName ?? ""); const [email, setEmail] = useState(s?.email ?? ""); const [phone, setPhone] = useState(s?.phone ?? ""); const [terms, setTerms] = useState(s?.termsDays ?? 30); const [lead, setLead] = useState(s?.leadTimeDays ?? 7); const [err, setErr] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => { const body = { name: name.trim(), contactName: contact.trim() || (s ? null : undefined), email: email.trim() || (s ? null : undefined), phone: phone.trim() || (s ? null : undefined), termsDays: terms, leadTimeDays: lead }; return s ? api(`/suppliers/${s.id}`, { method: "PATCH", body }) : api("/suppliers", { method: "POST", body }); },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["suppliers"] }); onDone(); },
    onError: (e) => setErr(e instanceof ApiError && e.code === "supplier_name_taken" ? "A supplier with that name already exists." : e instanceof ApiError && e.status === 400 ? "Check the email address and the terms." : "Could not save the supplier."),
  });
  return (
    <Panel title={s ? `Edit ${s.name}` : "New supplier"}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); setErr(null); save.mutate(); }}>
        <div className="grid2"><Field id="sup-name" label="Name"><TextInput id="sup-name" value={name} onChange={setName} autoFocus /></Field><Field id="sup-contact" label="Contact"><TextInput id="sup-contact" value={contact} onChange={setContact} /></Field>
          <Field id="sup-email" label="Email"><TextInput id="sup-email" type="email" value={email} onChange={setEmail} /></Field><Field id="sup-phone" label="Phone"><TextInput id="sup-phone" value={phone} onChange={setPhone} /></Field></div>
        <div className="row-flex"><span>Payment terms</span><Stepper label="Payment terms in days" value={terms} min={0} max={365} onChange={setTerms} decrementIcon={<Minus size={16} />} incrementIcon={<Plus size={16} />} /><span className="muted">days from the bill date</span></div>
        <div className="row-flex"><span>Lead time</span><Stepper label="Lead time in days" value={lead} min={0} max={365} onChange={setLead} decrementIcon={<Minus size={16} />} incrementIcon={<Plus size={16} />} /><span className="muted">days from placing an order to goods arriving; used when suggesting what to reorder</span></div>
        {err && <p className="err" role="alert">{err}</p>}
        <div className="row-flex"><Button onClick={onDone}>Cancel</Button><span className="grow" /><Button variant="primary" type="submit" disabled={!name.trim() || save.isPending}>{s ? "Save changes" : "Add supplier"}</Button></div>
      </form>
    </Panel>
  );
}

export function Suppliers() {
  useLensLock(true);
  const { can } = useAuth(); const w = can("purchase:write", null); const qc = useQueryClient();
  const [q, setQ] = useState(""); const [view, setView] = useState<"active" | "archived">("active"); const [edit, setEdit] = useState<Sup | "new" | null>(null);
  const list = useQuery({ queryKey: ["suppliers", q, view], queryFn: () => api<Sup[]>(`/suppliers${qs({ q, status: view })}`) });
  const archive = useMutation({ mutationFn: (s: Sup) => api(`/suppliers/${s.id}`, { method: "PATCH", body: { status: s.status === "active" ? "archived" : "active" } }), onSuccess: () => qc.invalidateQueries({ queryKey: ["suppliers"] }) });
  return (<>
    <PageHeader title="Suppliers" sub="Who you buy from, on what terms, and what is owed" actions={w && <Button variant="primary" onClick={() => setEdit("new")}>New supplier</Button>} />
    <div className="filters"><label className="input" style={{ minWidth: 260 }}><Search size={16} /><input aria-label="Search suppliers" placeholder="Supplier name" value={q} onChange={(e) => setQ(e.target.value)} /></label>
      <Segmented label="Show" value={view} onChange={setView} options={[{ value: "active", label: "Active" }, { value: "archived", label: "Archived" }]} /></div>
    {edit && <Form key={edit === "new" ? "new" : edit.id} s={edit === "new" ? undefined : edit} onDone={() => setEdit(null)} />}
    <Panel flush>
      {list.isLoading ? <Skeleton rows={5} /> : list.isError ? <ErrorBox error={list.error} retry={() => list.refetch()} /> : list.data!.length === 0 ? <Empty title={view === "archived" ? "No archived suppliers" : "No suppliers yet"}>{view === "archived" ? "Suppliers you stop using are kept here." : "Add the first supplier, then raise a purchase order against it."}</Empty> :
        <div className="tbl-wrap"><table className="tbl" data-testid="suppliers-table"><thead><tr><th>Supplier</th><th>Contact</th><th className="n">Terms</th><th className="n">Lead time</th><th className="n">Open orders</th><th className="n">Open bills</th><th className="n">Owed</th><th /></tr></thead>
          <tbody>{list.data!.map((s) => <tr key={s.id}><td><b>{s.name}</b>{s.status === "archived" && <> <Chip>Archived</Chip></>}</td><td>{s.contactName ?? <span className="muted">—</span>}<br /><span className="muted" style={{ fontSize: 12.5 }}>{[s.email, s.phone].filter(Boolean).join(" · ")}</span></td>
            <td className="n">{s.termsDays} days</td><td className="n">{s.leadTimeDays} days</td><td className="n">{s.openOrders}</td><td className="n">{s.openBills}</td><td className="n"><b>{s.owedMinor ? money(s.owedMinor) : "—"}</b></td>
            <td className="n">{w && <span className="row-flex" style={{ justifyContent: "flex-end" }}><Button size="sm" onClick={() => setEdit(s)}>Edit</Button><Button size="sm" variant="ghost" onClick={() => archive.mutate(s)}>{s.status === "active" ? "Archive" : "Restore"}</Button></span>}</td></tr>)}</tbody></table></div>}
    </Panel>
  </>);
}
