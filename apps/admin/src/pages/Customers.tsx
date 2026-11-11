import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Search, X } from "lucide-react";
import { Button, Select, Switch } from "@shelfline/ui";
import { parseMoney } from "../lib/format";
import { api, ApiError, qs } from "../lib/api";
import { dateTime, money } from "../lib/format";
import { href, navigate, useRoute } from "../router";
import { useAuth } from "../state/auth";
import { useLensLock } from "../state/lens";
import { Empty, ErrorBox, Field, PageHeader, Panel, Skeleton, TextInput } from "../ui";

interface C { id: string; name: string; email: string | null; phone: string | null; orders: number; spentMinor: number; lastPurchaseAt: string | null; marketingConsent: { email?: boolean; sms?: boolean } }

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function Form({ initial, onDone, onCancel }: { initial?: any; onDone: (c: any) => void; onCancel: () => void }) {
  const qc = useQueryClient(); const [name, setName] = useState(initial?.name ?? ""); const [email, setEmail] = useState(initial?.email ?? ""); const [phone, setPhone] = useState(initial?.phone ?? ""); const [notes, setNotes] = useState(initial?.notes ?? "");
  const [consent, setConsent] = useState(!!(initial?.marketingConsent?.email)); const [err, setErr] = useState<string | null>(null); const [bm, setBm] = useState<string | null>(initial?.birthMonth ? String(initial.birthMonth) : null); const [bd, setBd] = useState<string | null>(initial?.birthDay ? String(initial.birthDay) : null);
  const save = useMutation({
    mutationFn: () => { const body = { name: name.trim(), email: email.trim() || (initial ? null : undefined), phone: phone.trim() || (initial ? null : undefined), notes: notes.trim() || (initial ? null : undefined), ...(bm && bd ? { birthMonth: Number(bm), birthDay: Number(bd) } : initial?.birthMonth ? { birthMonth: null, birthDay: null } : {}), marketingConsent: { email: consent, sms: consent } }; return initial ? api(`/customers/${initial.id}`, { method: "PATCH", body }) : api("/customers", { method: "POST", body }); },
    onSuccess: (c) => { void qc.invalidateQueries({ queryKey: ["customers"] }); void qc.invalidateQueries({ queryKey: ["customer"] }); onDone(c); },
    onError: (e) => setErr(e instanceof ApiError && e.status === 409 ? "Another customer already has that email." : e instanceof ApiError && e.status === 400 ? "Check the name and email address." : "Could not save."),
  });
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); setErr(null); save.mutate(); }}>
      <Field id="cn" label="Name"><TextInput id="cn" value={name} onChange={setName} required autoFocus /></Field>
      <Field id="ce" label="Email"><TextInput id="ce" type="email" value={email} onChange={setEmail} /></Field>
      <Field id="cp" label="Phone"><TextInput id="cp" value={phone} onChange={setPhone} /></Field>
      <Field id="cno" label="Notes"><TextInput id="cno" value={notes} onChange={setNotes} /></Field>
      <div className="grid2"><Select label="Birthday month (optional)" value={bm} onChange={setBm} options={MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))} placeholder="Month" chevron={<ChevronDown size={16} />} />
        <Select label="Birthday day" value={bd} onChange={setBd} options={Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))} placeholder="Day" chevron={<ChevronDown size={16} />} /></div>
      <Switch checked={consent} onChange={setConsent}>Agreed to receive offers</Switch>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="row-flex"><Button onClick={onCancel}>Cancel</Button><span className="grow" /><Button variant="primary" type="submit" disabled={!name.trim() || save.isPending}>Save customer</Button></div>
    </form>
  );
}

function Detail({ id }: { id: string }) {
  const { canAny } = useAuth(); const [edit, setEdit] = useState(false); const q = useQuery({ queryKey: ["customer", id], queryFn: () => api<any>(`/customers/${id}`) });
  if (q.isLoading) return <Panel><Skeleton rows={6} /></Panel>; if (q.isError) return <ErrorBox error={q.error} retry={() => q.refetch()} />; const c = q.data!;
  return (
    <section className="panel detail" aria-label={c.name}>
      <div className="drawer-head"><h2>{c.name}</h2><button className="btn ghost sm" aria-label="Close details" onClick={() => navigate("sell", "customers")}><X size={16} /></button></div>
      <div className="pb stack">{edit ? <Form initial={c} onDone={() => setEdit(false)} onCancel={() => setEdit(false)} /> : <>
        <dl className="kv"><dt>Email</dt><dd>{c.email ?? "—"}</dd><dt>Phone</dt><dd>{c.phone ?? "—"}</dd><dt>Offers</dt><dd>{c.marketingConsent?.email ? "Agreed" : "Not agreed"}</dd><dt>Customer since</dt><dd>{dateTime(c.createdAt)}</dd><dt>Spent</dt><dd><b>{money(c.spentMinor)}</b> over {c.orders} order{c.orders === 1 ? "" : "s"}</dd>{c.notes && <><dt>Notes</dt><dd>{c.notes}</dd></>}</dl>
        {canAny("customer:write") && <div><Button onClick={() => setEdit(true)}>Edit customer</Button></div>}
        <StoreCredit id={c.id} />
        <Points id={c.id} />
        <div><b>Recent orders</b>{c.recent.length === 0 ? <p className="muted">No purchases yet.</p> : c.recent.map((o: any) => <div className="lead" key={o.id}><span><a href={href("sell", "orders", o.id)}>{o.receiptNo}</a> · {o.location} · {dateTime(o.at)}</span><i /><b>{(o.totalMinor / 100).toFixed(2)}</b></div>)}</div></>}
      </div>
    </section>
  );
}

function StoreCredit({ id }: { id: string }) {
  const qc = useQueryClient(); const { canAny } = useAuth(); const w = canAny("giftcard:write"); const q = useQuery({ queryKey: ["credit", id], queryFn: () => api<any>(`/customers/${id}/credit`) });
  const [open, setOpen] = useState(false); const [amt, setAmt] = useState(""); const [note, setNote] = useState(""); const [sign, setSign] = useState<1 | -1>(1); const [err, setErr] = useState<string | null>(null); const [key, setKey] = useState(() => crypto.randomUUID());
  const adj = useMutation({ mutationFn: () => api(`/customers/${id}/credit`, { method: "POST", body: { amountMinor: sign * parseMoney(amt)!, idempotencyKey: key, note: note.trim() } }), onSuccess: () => { setOpen(false); setAmt(""); setNote(""); setKey(crypto.randomUUID()); void qc.invalidateQueries({ queryKey: ["credit", id] }); },
    onError: (e) => setErr(e instanceof ApiError && e.code === "insufficient_credit" ? "That is more than the customer has." : "Could not adjust the credit.") });
  if (q.isLoading || q.isError) return null; const d = q.data!;
  return (
    <div data-testid="store-credit"><b>Store credit</b>
      <div className="lead"><span>Balance</span><i /><b data-testid="credit-balance" className={d.balanceMinor < 0 ? "neg" : ""}>{money(d.balanceMinor)}</b></div>
      {d.entries.slice(0, 4).map((e: any) => <div className="lead" key={e.id}><span className="muted">{dateTime(e.at)} · {e.kind.replace(/_/g, " ")}{e.note ? ` · ${e.note}` : ""}</span><i /><b>{e.deltaMinor > 0 ? "+" : "−"}{(Math.abs(e.deltaMinor) / 100).toFixed(2)}</b></div>)}
      {w && !open && <div style={{ marginTop: 8 }}><Button size="sm" onClick={() => setOpen(true)}>Adjust credit</Button></div>}
      {open && <form className="stack" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); setErr(null); adj.mutate(); }} aria-label="Adjust credit">
        <div className="row-flex"><Button type="button" variant={sign === 1 ? "primary" : "secondary"} onClick={() => setSign(1)}>Add</Button><Button type="button" variant={sign === -1 ? "primary" : "secondary"} onClick={() => setSign(-1)}>Take off</Button></div>
        <Field id="cr-a" label="Amount (A$)"><TextInput id="cr-a" inputMode="decimal" value={amt} onChange={setAmt} /></Field><Field id="cr-n" label="Reason"><TextInput id="cr-n" value={note} onChange={setNote} /></Field>
        {err && <p className="err" role="alert">{err}</p>}<div className="row-flex"><Button type="button" onClick={() => setOpen(false)}>Cancel</Button><span className="grow" /><Button variant="primary" type="submit" disabled={!parseMoney(amt) || note.trim().length < 3 || adj.isPending}>Save adjustment</Button></div></form>}
    </div>
  );
}

export function Customers() {
  useLensLock(true); const route = useRoute(); const { canAny } = useAuth(); const [q, setQ] = useState(""); const [creating, setCreating] = useState(false);
  const list = useQuery({ queryKey: ["customers", q], queryFn: () => api<C[]>(`/customers${qs({ q })}`) }); const sel = route.id;
  return (<>
    <PageHeader title="Customers" sub="Shared across every location" actions={canAny("customer:write") ? <Button variant="primary" onClick={() => setCreating(true)}>New customer</Button> : undefined} />
    <div className="filters"><label className="input" style={{ minWidth: 280 }}><Search size={16} /><input aria-label="Search customers" placeholder="Name, email or phone" value={q} onChange={(e) => setQ(e.target.value)} /></label></div>
    <div className={`md${sel || creating ? "" : " single"}`}>
      <Panel flush>{list.isLoading ? <Skeleton rows={5} /> : list.isError ? <ErrorBox error={list.error} retry={() => list.refetch()} /> : list.data!.length === 0 ? <Empty title="No customers found">Customers are added at the till or here.</Empty> :
        <div className="tbl-wrap"><table className="tbl" data-testid="customers-table"><thead><tr><th>Name</th><th>Contact</th><th className="n">Orders</th><th className="n">Spent</th><th>Last purchase</th></tr></thead>
          <tbody>{list.data!.map((c) => <tr key={c.id} className="clickable" tabIndex={0} aria-selected={sel === c.id} onClick={() => { setCreating(false); navigate("sell", "customers", c.id); }} onKeyDown={(e) => { if (e.key === "Enter") navigate("sell", "customers", c.id); }}><td><b>{c.name}</b></td><td>{c.email ?? c.phone ?? <span className="muted">—</span>}</td><td className="n">{c.orders}</td><td className="n">{money(c.spentMinor)}</td><td>{c.lastPurchaseAt ? dateTime(c.lastPurchaseAt) : <span className="muted">never</span>}</td></tr>)}</tbody></table></div>}</Panel>
      {creating ? <section className="panel detail" aria-label="New customer"><div className="drawer-head"><h2>New customer</h2></div><div className="pb"><Form onDone={(c) => { setCreating(false); navigate("sell", "customers", c.id); }} onCancel={() => setCreating(false)} /></div></section> : sel && <Detail id={sel} />}
    </div>
  </>);
}

/** Loyalty standing, where the program is on: points, tier, and how far to the next tier. */
function Points({ id }: { id: string }) {
  const q = useQuery({ queryKey: ["loyalty", id], queryFn: () => api<{ enabled: boolean; points: number; tier: string; nextTier: { name: string; pointsToGo: number } | null }>(`/loyalty/customers/${id}`), retry: false }); if (!q.data?.enabled) return null; const d = q.data;
  return (<div data-testid="loyalty"><b>Loyalty</b><div className="lead"><span>{d.tier} member</span><i /><b data-testid="loyalty-points">{d.points.toLocaleString("en-AU")} points</b></div>{d.nextTier && <span className="muted" style={{ fontSize: 13 }}>{d.nextTier.pointsToGo} more points to {d.nextTier.name}</span>}</div>);
}
