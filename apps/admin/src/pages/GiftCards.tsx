import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Calendar, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { Button, Callout, Chip, DatePicker, Segmented, Switch } from "@shelfline/ui";
import { api, ApiError, qs } from "../lib/api";
import { dateTime, money, parseMoney, plain } from "../lib/format";
import { navigate, useRoute } from "../router";
import { useAuth } from "../state/auth";
import { useBusinessToday, useLensLock } from "../state/lens";
import { Empty, ErrorBox, Field, PageHeader, Panel, Skeleton, TextInput } from "../ui";

interface Card { id: string; last4: string; status: string; expiresOn: string | null; createdAt: string; note: string | null; customer: string | null; balanceMinor: number; loadedMinor: number }
const KIND: Record<string, string> = { issue: "Issued", topup: "Top-up", redeem: "Spent", refund_credit: "Refund credit", adjust: "Adjustment" };

function Issue({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient(); const today = useBusinessToday(); const [amt, setAmt] = useState("50.00"); const [note, setNote] = useState(""); const [exp, setExp] = useState(false); const [on, setOn] = useState(today.replace(/^(\d{4})/, (y) => String(Number(y) + 3))); const [err, setErr] = useState<string | null>(null); const [made, setMade] = useState<{ code: string; id: string } | null>(null);
  const save = useMutation({ mutationFn: () => api<{ code: string; id: string }>("/gift-cards", { method: "POST", body: { amountMinor: parseMoney(amt), note: note.trim() || undefined, expiresOn: exp ? on : null } }), onSuccess: (r) => { setMade(r); void qc.invalidateQueries({ queryKey: ["gifts"] }); }, onError: () => setErr("Could not issue the card. Check the amount.") });
  if (made) return <Callout tone="warn"><span data-testid="new-code"><b>Write this code on the card. It is shown once and cannot be looked up again.</b><br /><span className="mono" style={{ fontSize: 22, letterSpacing: 1 }}>{made.code}</span><br /><Button size="sm" onClick={() => { onDone(); navigate("sell", "gift-cards", made.id); }}>I have it</Button></span></Callout>;
  return (
    <Panel title="Issue a gift card">
      <form className="stack" onSubmit={(e) => { e.preventDefault(); setErr(null); save.mutate(); }}>
        <div className="grid2"><Field id="gc-amt" label="Amount (A$)"><TextInput id="gc-amt" inputMode="decimal" value={amt} onChange={setAmt} autoFocus /></Field><Field id="gc-note" label="Note (optional)"><TextInput id="gc-note" value={note} onChange={setNote} placeholder="e.g. Birthday, order #1042" /></Field></div>
        <Switch checked={exp} onChange={setExp}>Expires</Switch>{exp && <DatePicker label="Expires on" value={on} onChange={setOn} today={today} min={today} icon={<Calendar size={16} />} prevIcon={<ChevronLeft size={16} />} nextIcon={<ChevronRight size={16} />} />}
        {err && <p className="err" role="alert">{err}</p>}
        <div className="row-flex"><Button onClick={onDone}>Cancel</Button><span className="grow" /><Button variant="primary" type="submit" disabled={!parseMoney(amt) || parseMoney(amt)! < 1 || save.isPending}>Issue card</Button></div>
      </form>
    </Panel>
  );
}

function Detail({ id }: { id: string }) {
  const qc = useQueryClient(); const { canAny } = useAuth(); const w = canAny("giftcard:write"); const [amt, setAmt] = useState(""); const [err, setErr] = useState<string | null>(null); const [key, setKey] = useState(() => crypto.randomUUID());
  const q = useQuery({ queryKey: ["gift", id], queryFn: () => api<any>(`/gift-cards/${id}`) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["gift", id] }); void qc.invalidateQueries({ queryKey: ["gifts"] }); };
  const top = useMutation({ mutationFn: () => api(`/gift-cards/${id}/topup`, { method: "POST", body: { amountMinor: parseMoney(amt), idempotencyKey: key } }), onSuccess: () => { setAmt(""); setKey(crypto.randomUUID()); setErr(null); refresh(); }, onError: (e) => setErr(e instanceof ApiError && e.code === "gift_card_void" ? "A cancelled card cannot be topped up." : "Could not top up.") });
  const status = useMutation({ mutationFn: (s: string) => api(`/gift-cards/${id}`, { method: "PATCH", body: { status: s } }), onSuccess: refresh });
  if (q.isLoading) return <Panel><Skeleton rows={6} /></Panel>; if (q.isError) return <ErrorBox error={q.error} retry={() => q.refetch()} />; const g = q.data!;
  return (
    <section className="panel detail" aria-label={`Gift card ${g.codeLast4}`} data-testid="gift-detail">
      <div className="drawer-head"><div><h2>Card …{g.codeLast4}</h2><div className="muted" style={{ fontSize: 13 }}>Issued {dateTime(g.createdAt)}{g.expiresOn ? ` · expires ${g.expiresOn}` : ""}{g.note ? ` · ${g.note}` : ""}</div></div><span className="row-flex" style={{ gap: 6 }}><Chip tone={g.status === "active" ? "ok" : "danger"}>{g.status === "active" ? "Active" : "Cancelled"}</Chip><button className="btn ghost sm" aria-label="Close details" onClick={() => navigate("sell", "gift-cards")}>✕</button></span></div>
      <div className="pb stack">
        <div className="lead total"><span>Balance</span><i /><b data-testid="gift-balance" className={g.balanceMinor < 0 ? "neg" : ""}>{money(g.balanceMinor)}</b></div>
        {g.balanceMinor < 0 && <Callout tone="warn"><span>This card was spent past its balance (two tills, or an offline sale). The sale stands; see Alerts.</span></Callout>}
        {w && g.status === "active" && <form className="row-flex" onSubmit={(e) => { e.preventDefault(); setErr(null); top.mutate(); }} aria-label="Top up"><div className="input grow"><input aria-label="Top up amount" inputMode="decimal" placeholder="Top up (A$)" value={amt} onChange={(e) => setAmt(e.target.value)} /></div><Button type="submit" disabled={!parseMoney(amt) || top.isPending}>Top up</Button></form>}
        {err && <p className="err" role="alert">{err}</p>}
        <div className="tbl-wrap"><table className="tbl" data-testid="gift-entries"><thead><tr><th>When</th><th>What</th><th className="n">Amount</th></tr></thead>
          <tbody>{g.entries.map((e: any) => <tr key={e.id}><td className="mono" style={{ fontSize: 12.5 }}>{dateTime(e.at)}</td><td>{KIND[e.kind] ?? e.kind}{e.note ? <span className="muted"> · {e.note}</span> : null}</td><td className={`n${e.deltaMinor < 0 ? "" : ""}`} style={{ color: e.deltaMinor > 0 ? "var(--ok)" : undefined, fontWeight: 700 }}>{e.deltaMinor > 0 ? "+" : "−"}{plain(Math.abs(e.deltaMinor))}</td></tr>)}</tbody></table></div>
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>The balance is the sum of these entries. Nothing here can be edited.</p>
        {w && <div className="row-flex"><Button variant="ghost" onClick={() => status.mutate(g.status === "active" ? "void" : "active")}>{g.status === "active" ? "Cancel this card" : "Restore this card"}</Button></div>}
      </div>
    </section>
  );
}

const VIEWS = [{ value: "active", label: "Active" }, { value: "owing", label: "With balance" }, { value: "all", label: "All" }] as const;
export function GiftCards() {
  useLensLock(true);
  const route = useRoute(); const { canAny } = useAuth(); const [q, setQ] = useState(""); const [view, setView] = useState<(typeof VIEWS)[number]["value"]>("owing"); const [creating, setCreating] = useState(false); const sel = route.id;
  const list = useQuery({ queryKey: ["gifts", q], queryFn: () => api<Card[]>(`/gift-cards${qs({ q })}`) });
  const rows = useMemo(() => (list.data ?? []).filter((c) => view === "all" || (view === "active" ? c.status === "active" : c.balanceMinor > 0 && c.status === "active")), [list.data, view]);
  const outstanding = rows.reduce((a, c) => a + Math.max(0, c.balanceMinor), 0);
  return (<>
    <PageHeader title="Gift cards" sub="Cards you have sold. A card's balance is the sum of its entries." actions={canAny("giftcard:write") && <Button variant="primary" onClick={() => setCreating(true)}>Issue a card</Button>} />
    <div className="filters"><label className="input" style={{ minWidth: 240 }}><Search size={16} /><input aria-label="Search cards" placeholder="Last four characters" value={q} onChange={(e) => setQ(e.target.value)} /></label><Segmented label="Show" value={view} onChange={setView} options={VIEWS.map((v) => ({ value: v.value, label: v.label }))} /></div>
    {creating && <Issue onDone={() => setCreating(false)} />}
    <div className={`md${sel ? "" : " single"}`}>
      <Panel flush>{list.isLoading ? <Skeleton rows={5} /> : list.isError ? <ErrorBox error={list.error} retry={() => list.refetch()} /> : rows.length === 0 ? <Empty title="No cards here">Issue a card to sell one. The code is shown once, so write it on the card straight away.</Empty> : <>
        <div className="tbl-wrap"><table className="tbl" data-testid="gift-table"><thead><tr><th>Card</th><th>Issued</th><th>Expires</th><th className="n">Loaded</th><th className="n">Balance</th><th>Status</th></tr></thead>
          <tbody>{rows.map((c) => <tr key={c.id} className="clickable" tabIndex={0} aria-selected={sel === c.id} onClick={() => navigate("sell", "gift-cards", c.id)} onKeyDown={(e) => { if (e.key === "Enter") navigate("sell", "gift-cards", c.id); }}>
            <td><b className="mono">…{c.last4}</b>{c.note && <><br /><span className="muted" style={{ fontSize: 12.5 }}>{c.note}</span></>}</td><td>{dateTime(c.createdAt)}</td><td>{c.expiresOn ?? <span className="muted">—</span>}</td><td className="n">{plain(c.loadedMinor)}</td><td className={`n${c.balanceMinor < 0 ? " neg" : ""}`}><b>{plain(c.balanceMinor)}</b></td><td><Chip tone={c.status === "active" ? "ok" : "danger"}>{c.status === "active" ? "Active" : "Cancelled"}</Chip></td></tr>)}</tbody></table></div>
        <div className="pb muted" style={{ borderTop: "1px solid var(--line)" }}>{rows.length} card{rows.length === 1 ? "" : "s"} · {money(outstanding)} still to be spent</div></>}</Panel>
      {sel && <Detail id={sel} />}
    </div>
  </>);
}
