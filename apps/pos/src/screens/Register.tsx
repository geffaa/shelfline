import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Check, ChevronDown, Delete, LockOpen, Minus, Plus, Search, Wallet, X } from "lucide-react";
import { Button, Callout, Chip, Keypad, Segmented, Select, Stepper, Switch } from "@shelfline/ui";
import { REFUND_REASONS } from "@shelfline/contracts";
import { ApiError, apiCall, getSession, lookupSales, OfflineError, requestPrint, type ServerSession } from "../lib/api";
import { clockState, provisionalZ, recordMove, recordPunch, type CashKind, type LocalMove, type Punch, type ProvisionalZ } from "../lib/cash";
import { clockTime, fmt } from "../lib/format";
import { completeRefund, fromLocal, maxRefundable, planRefund, type Pick, type RefundableSale, type RefundReason } from "../lib/refunds";
import type { LocalSale } from "../lib/sales";
import { useApp } from "../state/app";
import { DENOMS } from "./Auth";
import { ApprovalPane } from "./Panes";

const KIND_LABEL: Record<CashKind, string> = { pay_in: "Pay in", pay_out: "Pay out", drop: "Safe drop", float_add: "Add to float", no_sale: "No sale" };
const REASONS: Record<CashKind, string[]> = { pay_in: ["Change top-up", "Float adjustment", "Other"], pay_out: ["Courier", "Supplies", "Refund paid by hand", "Other"], drop: ["Safe drop"], float_add: ["Extra coins", "Other"], no_sale: ["Change for customer", "Price check", "Customer request", "Other"] };
const hr = (iso: string) => clockTime(new Date(iso));
const pos = (n: number) => (n / 100).toFixed(2);
const sgn = (n: number) => (n < 0 ? `−${pos(-n)}` : pos(n));
const full: React.CSSProperties = { gridRow: "2 / 3", gridColumn: "2 / 4", overflow: "auto", display: "block" };

function Leaders({ z, counted }: { z: ProvisionalZ | NonNullable<ServerSession["z"]> & { openingFloatMinor?: number }; counted?: number }) {
  const open = (z as ProvisionalZ).openingFloatMinor;
  const L = ({ l, v, neg, total, sub }: { l: string; v: number; neg?: boolean; total?: boolean; sub?: boolean }) => <div className={`lead${total ? " total" : ""}${sub ? " sub" : ""}${neg && v ? " neg" : ""}`}><span>{l}</span><i /><b>{neg && v ? `−${pos(v)}` : pos(v)}</b></div>;
  return (
    <div className="sheet" data-testid="z-sheet">
      {open !== undefined && <L l="Opening float" v={open} />}
      <L l="Cash sales" v={z.cash.salesMinor} /><L l="Cash refunds" v={z.cash.refundsMinor} neg /><L l="Pay-ins" v={z.cash.payInMinor + z.cash.floatAddMinor} /><L l="Pay-outs" v={z.cash.payOutMinor} neg /><L l="Safe drops" v={z.cash.dropMinor} neg />
      <L l="Expected in drawer" v={z.expectedMinor} total />
      {counted !== undefined && <><div className="lead"><span>Counted</span><i /><b data-testid="z-counted">{pos(counted)}</b></div><div className={`lead${counted - z.expectedMinor ? " neg" : ""}`}><span><b>Difference</b></span><i /><b data-testid="z-variance">{sgn(counted - z.expectedMinor)}</b></div></>}
      <hr className="perf" />
      <L l="Gross sales" v={z.grossSalesMinor} /><L l="Refunds" v={z.refundsMinor} neg /><L l="Net sales" v={z.netSalesMinor} total /><L l="GST included" v={z.gstMinor} sub />
    </div>
  );
}

// ------------------------------------------------------------------ S08 Cash
export function CashScreen() {
  const { store, session, auth, device, syncNow } = useApp();
  const [moves, setMoves] = useState<LocalMove[]>([]); const [kind, setKind] = useState<CashKind | null>(null);
  const [digits, setDigits] = useState(""); const [reason, setReason] = useState<string | null>(null); const [flash, setFlash] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { setMoves((await store.list<LocalMove>("cash")).map((x) => x.value).filter((m) => m.sessionId === session?.id).sort((a, b) => b.at.localeCompare(a.at))); }, [store, session?.id]);
  useEffect(() => { void load(); }, [load]);
  const amount = digits ? Number(digits) : 0;
  const reset = () => { setKind(null); setDigits(""); setReason(null); };
  const confirm = async () => {
    if (!kind || !session || !auth || busy) return; setBusy(true);
    try { await recordMove(store, { session, cashierId: auth.userId, kind, amountMinor: kind === "no_sale" ? 0 : amount, reason: reason ?? undefined }); if (kind === "no_sale" && device && navigator.onLine) void requestPrint(device.apiUrl, auth.token, { kind: "drawer", reason: "no_sale" }).catch(() => undefined); setFlash(kind === "no_sale" ? "No sale recorded. The drawer opens if this register has a printer." : `${KIND_LABEL[kind]} ${fmt(amount)} recorded`); reset(); await load(); void syncNow(); } finally { setBusy(false); }
  };
  const ok = kind !== null && !!reason && (kind === "no_sale" || amount > 0);
  const Big = ({ k, icon }: { k: CashKind; icon: React.ReactNode }) => <Button size="lg" style={{ minHeight: 88, flexDirection: "column", gap: 6, fontSize: 16 }} aria-pressed={kind === k} onClick={() => { setKind(k); setDigits(""); setReason(null); }}>{icon}{KIND_LABEL[k]}</Button>;
  return (<>
    <section className="pos-main" aria-label="Cash drawer" style={{ gridTemplateRows: "auto auto 1fr", overflow: "auto" }}>
      <div className="row-flex"><h1 style={{ margin: 0, fontSize: 26 }}>Cash</h1><span className="muted">Everything that moves cash outside a sale is written down here.</span></div>
      <div className="denoms" style={{ gridTemplateColumns: "repeat(5, minmax(0,1fr))" }}>
        <Big k="pay_in" icon={<ArrowDownToLine />} /><Big k="pay_out" icon={<ArrowUpFromLine />} /><Big k="drop" icon={<Wallet />} /><Big k="float_add" icon={<Plus />} /><Big k="no_sale" icon={<LockOpen />} />
      </div>
      <div className="panel" style={{ alignSelf: "start" }}><header><h2>This session</h2><span className="muted">{moves.length} entr{moves.length === 1 ? "y" : "ies"}</span></header>
        <div className="pb" data-testid="cash-list">{moves.length === 0 ? <span className="muted">Nothing yet.</span> : moves.map((m) => <div className="lead" key={m.id}><span>{hr(m.at)} · {KIND_LABEL[m.kind]}{m.reason ? ` · ${m.reason}` : ""}</span><i /><b>{m.kind === "no_sale" ? "—" : pos(m.amountMinor)}</b></div>)}</div></div>
      {flash && <Callout tone="info">{flash}</Callout>}
    </section>
    <aside className="sheet-pane" aria-label="Cash entry">
      <header><h2>{kind ? KIND_LABEL[kind] : "Cash entry"}</h2>{kind && <Button size="sm" variant="ghost" onClick={reset} aria-label="Cancel cash entry"><X size={18} /></Button>}</header>
      <div className="pane-body">{!kind ? <span className="muted">Choose what happened. You will be asked for a reason every time.</span> : <>
        {kind !== "no_sale" && <><div className="lead"><span>Amount</span><i /><b data-testid="cash-amount" style={{ fontSize: 28 }}>{fmt(amount)}</b></div>
          <Keypad listen onDigit={(d) => setDigits((x) => (x.length < 8 ? x + d : x).replace(/^0+/, ""))} onBackspace={() => setDigits((x) => x.slice(0, -1))} onSubmit={ok ? confirm : undefined} submitLabel="Confirm" backspaceIcon={<Delete size={22} />} submitIcon={<Check size={24} />} /></>}
        <Select label="Reason" value={reason} onChange={setReason} options={REASONS[kind].map((r) => ({ value: r, label: r }))} placeholder="Reason" chevron={<ChevronDown size={16} />} />
        {kind === "no_sale" && <Callout tone="info">A no-sale opens the drawer without a sale. It is recorded with your name and the reason.</Callout>}
      </>}</div>
      <div className="pane-foot"><Button variant="primary" size="lg" style={{ minHeight: 60, fontSize: 20 }} disabled={!ok || busy} onClick={confirm}>{kind ? `Record ${KIND_LABEL[kind].toLowerCase()}` : "Record"}</Button></div>
    </aside>
  </>);
}

// ------------------------------------------------------------------ S07 Orders and refunds
export function OrdersScreen() {
  const { store, auth, device, session, catalogue, sync, syncNow } = useApp();
  const [q, setQ] = useState(""); const [local, setLocal] = useState<RefundableSale[]>([]); const [remote, setRemote] = useState<RefundableSale[]>([]); const [sel, setSel] = useState<RefundableSale | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(async () => setLocal((await store.list<LocalSale>("sales")).map((x) => fromLocal(x.value)).sort((a, b) => b.at.localeCompare(a.at))), [store]);
  useEffect(() => { void load(); }, [load]);
  const search = async () => {
    setNote(null); setRemote([]); if (!device || !auth) return;
    try { const rows = await lookupSales(device.apiUrl, auth.token, q.trim()); setRemote(rows.map((s) => ({ ...s, lines: s.lines, fromServer: true }))); if (q.trim() && rows.length === 0 && !local.some((l) => l.receiptNo.toLowerCase() === q.trim().toLowerCase())) setNote(`No sale with receipt “${q.trim()}” at this store.`); }
    catch (e) { setNote(e instanceof OfflineError ? "Offline: showing sales made on this iPad only. Sales from other tills are not visible until it reconnects." : "Could not look that up."); }
  };
  const merged = useMemo(() => { const map = new Map<string, RefundableSale>(); for (const s of remote) map.set(s.id, s); for (const s of local) map.set(s.id, s);   // this till's own record knows about its unsent refunds
    const needle = q.trim().toLowerCase(); return [...map.values()].filter((s) => !needle || s.receiptNo.toLowerCase().includes(needle)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40); }, [local, remote, q]);
  return (<>
    <section className="pos-main" aria-label="Orders" style={{ gridTemplateRows: "auto auto 1fr" }}>
      <form className="scan" onSubmit={(e) => { e.preventDefault(); void search(); }}>
        <label className="input" style={{ flex: 1 }}><Search size={18} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Receipt number" aria-label="Find a sale by receipt number" autoComplete="off" autoFocus /></label>
        <Button type="submit" size="lg">Find</Button>
      </form>
      {note ? <Callout tone="info">{note}</Callout> : <span />}
      <div className="results" role="list" aria-label="Sales">
        <div className="rh"><span>{merged.length} sale{merged.length === 1 ? "" : "s"}</span><span>Newest first</span></div>
        {merged.length === 0 && <p className="muted" style={{ padding: 20, margin: 0 }}>No sales yet on this iPad. Type a receipt number to look up a sale from another till.</p>}
        {merged.map((s) => { const refunded = s.lines.every((l) => l.refundedQty >= l.qty), part = !refunded && s.lines.some((l) => l.refundedQty > 0);
          return <button key={s.id} role="listitem" className="row" data-testid="order-row" onClick={() => setSel(s)}>
            <span><span className="t">{s.receiptNo}</span><br /><span className="v">{hr(s.at)} · {s.cashierName}{s.customerName ? ` · ${s.customerName}` : ""} · {s.lines.reduce((a, l) => a + l.qty, 0)} items</span></span>
            <span className="stk">{refunded ? <Chip tone="warn">Refunded</Chip> : part ? <Chip tone="warn">Part refunded</Chip> : s.fromServer ? <Chip>Other till</Chip> : null}</span><span className="pr">{fmt(s.totalMinor)}</span></button>; })}
      </div>
    </section>
    {sel && session && catalogue?.location
      ? <RefundPane key={sel.id + sel.lines.map((l) => l.refundedQty).join("")} sale={sel} sessionId={session.id} refundLimit={catalogue.location.cashierRefundLimitMinor} onClose={() => setSel(null)} onDone={async () => { setSel(null); await load(); void syncNow(); }} offline={sync.state === "offline"} />
      : <aside className="sheet-pane" aria-label="Sale details"><header><h2>Refund</h2></header><div className="pane-body"><span className="muted">Choose a sale to refund items from it.</span></div><div className="pane-foot" /></aside>}
  </>);
}

function RefundPane({ sale, sessionId, refundLimit, onClose, onDone, offline }: { sale: RefundableSale; sessionId: string; refundLimit: number; onClose(): void; onDone(): Promise<void>; offline: boolean }) {
  const { store, auth } = useApp();
  const first = sale.payments[0]?.tender; const defTender = first === "cash" || first === "card" ? first : "other";
  const [picks, setPicks] = useState<Record<number, Pick>>({}); const [reason, setReason] = useState<RefundReason | null>(null); const [tender, setTender] = useState<"cash" | "card" | "other" | "store_credit">(defTender as "cash" | "card" | "other");
  const [approving, setApproving] = useState(false); const [token, setToken] = useState<{ t: string; name: string } | null>(null); const [done, setDone] = useState<{ total: number } | null>(null); const [busy, setBusy] = useState(false);
  const list = Object.values(picks); const plan = useMemo(() => { try { return planRefund(sale, list); } catch { return { lines: [], totalMinor: 0, taxMinor: 0 }; } }, [sale, picks]); // eslint-disable-line react-hooks/exhaustive-deps
  const canApprove = !!auth?.canApprove; const needs = plan.totalMinor > refundLimit && !canApprove && !token;
  const setQty = (lineNo: number, qty: number) => setPicks((p) => ({ ...p, [lineNo]: { lineNo, qty, restock: p[lineNo]?.restock ?? true } }));
  const submit = async () => {
    if (!auth || !reason || busy) return; setBusy(true);
    try { await completeRefund(store, { sale, picks: list, tender, reason, sessionId, cashierId: auth.userId, approvalToken: token?.t }); setDone({ total: plan.totalMinor }); } finally { setBusy(false); }
  };
  if (approving) return <ApprovalPane kind="refund" onCancel={() => setApproving(false)} onApproved={(t, name) => { setToken({ t, name }); setApproving(false); }} />;
  if (done) return <aside className="sheet-pane" aria-label="Refund recorded"><header><h2>Refund recorded</h2></header><div className="pane-body"><div className="lead" style={{ width: "100%" }}><span>Give back</span><i /><b data-testid="refund-total" style={{ fontSize: 28 }}>{fmt(done.total)}</b></div><Callout tone="info">{tender === "cash" ? "Take the cash from the drawer." : "Return it on your terminal."} {offline ? "Offline: saved on this iPad and sent when it reconnects." : "Sending now."}</Callout></div><div className="pane-foot"><Button variant="primary" size="lg" style={{ minHeight: 60, fontSize: 20 }} onClick={() => void onDone()}>Done</Button></div></aside>;
  return (
    <aside className="sheet-pane" aria-label="Refund">
      <header><h2>Refund {sale.receiptNo}</h2><Button size="sm" variant="ghost" onClick={onClose} aria-label="Close refund"><X size={18} /></Button></header>
      <div className="pane-body">
        {sale.lines.map((l) => { const max = maxRefundable(l), p = picks[l.lineNo];
          return <div key={l.lineNo} className="stack" data-testid="refund-line" style={{ paddingBottom: 8, borderBottom: "1px solid var(--line)" }}>
            <div className="lead"><span><b>{l.title}</b> <span className="muted">{l.optionsLabel}</span></span><i /><b>{pos(l.totalMinor)}</b></div>
            {max === 0 ? <span className="muted">Already refunded ({l.refundedQty} of {l.qty}).</span> : <div className="row-flex" style={{ justifyContent: "space-between" }}>
              <Stepper label={`${l.title} refund quantity`} value={p?.qty ?? 0} min={0} max={max} onChange={(n) => setQty(l.lineNo, n)} decrementIcon={<Minus size={16} />} incrementIcon={<Plus size={16} />} />
              <Switch checked={p?.restock ?? true} onChange={(v) => setPicks((x) => ({ ...x, [l.lineNo]: { lineNo: l.lineNo, qty: x[l.lineNo]?.qty ?? 0, restock: v } }))}>Back on the shelf</Switch></div>}
            {l.refundedQty > 0 && max > 0 && <span className="muted" style={{ fontSize: 13 }}>{l.refundedQty} already refunded.</span>}
          </div>; })}
        <Segmented label="Refund method" value={tender} onChange={setTender} size="lg" options={[{ value: "cash", label: "Cash" }, { value: "card", label: "Card" }, ...(sale.customerName ? [{ value: "store_credit" as const, label: "Store credit" }] : []), { value: "other", label: "Other" }]} />
        <Select label="Refund reason" value={reason} onChange={setReason} options={REFUND_REASONS.map((r) => ({ value: r, label: { changed_mind: "Changed their mind", faulty: "Faulty", wrong_size: "Wrong size", other: "Other" }[r] }))} placeholder="Reason" chevron={<ChevronDown size={16} />} />
        {needs && <Callout tone="info">Refunds over {fmt(refundLimit)} need a manager's PIN.{offline ? " That needs the network." : ""}</Callout>}
        {token && <Chip tone="ok"><Check size={12} /> Approved by {token.name}</Chip>}
      </div>
      <div className="pane-foot">
        <div className="lead total"><span>Refund</span><i /><b data-testid="refund-plan-total" style={{ fontSize: 24 }}>{fmt(plan.totalMinor)}</b></div>
        {needs ? <Button variant="primary" size="lg" disabled={plan.totalMinor === 0 || !reason || offline} onClick={() => setApproving(true)}>Ask a manager</Button>
          : <Button variant="primary" size="lg" style={{ minHeight: 60, fontSize: 20 }} disabled={plan.totalMinor === 0 || !reason || busy} onClick={submit}>Refund {fmt(plan.totalMinor)}</Button>}
      </div>
    </aside>
  );
}

// ------------------------------------------------------------------ S10 Shift
/** My rostered shifts (published ones) and what has been recorded for me this week. Needs the network; says so quietly when it has none. */
function MyRoster() {
  const { auth, device, catalogue, sync } = useApp(); const [shifts, setShifts] = useState<{ id: string; date: string; startsAt: string; endsAt: string; role: string | null; location: string; timezone: string }[] | null>(null); const [mine, setMine] = useState<{ id: string; date: string; inAt: string; outAt: string | null; workedMinutes: number | null; lateMinutes: number; flags: string[] }[]>([]); const [off, setOff] = useState(false);
  const tz = catalogue?.location?.timezone; const day = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  useEffect(() => {
    if (!auth || !device || !tz) return; const today = day(new Date()); const to = day(new Date(Date.now() + 6 * 86_400_000)); const from = day(new Date(Date.now() - 6 * 86_400_000));
    void (async () => { try { setShifts(await apiCall(device.apiUrl, auth.token, `/shifts/mine?from=${today}&to=${to}`)); setMine(await apiCall(device.apiUrl, auth.token, `/timesheets/mine?locationId=${auth.locationId}&from=${from}&to=${today}`)); setOff(false); } catch { setOff(true); } })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth, device, tz, sync.lastSyncAt]);
  const t = (iso: string, z: string) => new Date(iso).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: z });
  if (off) return <p className="muted" style={{ margin: 0 }}>Your roster shows here when the iPad is online.</p>;
  if (shifts === null) return null;
  return (
    <div className="panel"><div className="pb" data-testid="my-roster"><b>My shifts</b>
      {shifts.length === 0 ? <p className="muted" style={{ margin: "6px 0 0" }}>No published shifts in the next week.</p> : shifts.slice(0, 5).map((x) => <div className="lead" key={x.id}><span>{x.date}{x.role ? ` · ${x.role}` : ""}</span><i /><b>{t(x.startsAt, x.timezone)}–{t(x.endsAt, x.timezone)}</b></div>)}
      {mine.length > 0 && <><b style={{ display: "block", marginTop: 12 }}>This week so far</b>{mine.slice(-4).map((x) => <div className="lead" key={x.id}><span>{x.date}{x.lateMinutes ? ` · ${x.lateMinutes} min late` : ""}{x.flags.includes("missing_out") ? " · no clock-out" : ""}</span><i /><b>{x.workedMinutes === null ? (x.outAt ? "—" : "working") : `${Math.floor(x.workedMinutes / 60)}h ${String(x.workedMinutes % 60).padStart(2, "0")}m`}</b></div>)}</>}
    </div></div>
  );
}

export function ShiftScreen({ onClose }: { onClose(): void }) {
  const { store, auth, device, session, syncNow, sync } = useApp(); const [local, setLocal] = useState<Punch | undefined>(); const [srv, setSrv] = useState<{ state: "in" | "out" | null; at: string | null; method: string | null; terminal: string | null } | null>(null);
  useEffect(() => { void clockState(store).then(setLocal); }, [store]);
  // what the server knows: a fingerprint terminal's punch shows up here after the next sync
  useEffect(() => { if (!auth || !device) return; void apiCall<any>(device.apiUrl, auth.token, `/punches/status?locationId=${auth.locationId}`).then(setSrv).catch(() => setSrv(null)); }, [auth, device, sync.lastSyncAt, sync.queued]);
  const serverNewer = !!srv?.state && !!srv.at && (!local || new Date(srv.at).getTime() > new Date(local.at).getTime());
  const last: (Punch & { via?: string }) | undefined = serverNewer ? { ...(local ?? ({} as Punch)), kind: srv!.state!, at: srv!.at!, via: srv!.method === "terminal_fp" ? `fingerprint terminal${srv!.terminal ? ` ${srv!.terminal}` : ""}` : srv!.method === "manual" ? "a manager's correction" : undefined } : local;
  const setLast = setLocal;
  const punch = async (kind: "in" | "out") => { if (!auth) return; setLast(await recordPunch(store, { actorId: auth.userId, kind })); void syncNow(); };
  return (
    <section className="pos-main" style={full} aria-label="Shift"><div className="stack" style={{ maxWidth: 620 }}>
      <h1 style={{ margin: 0, fontSize: 26 }}>Shift</h1>
      <div className="panel"><div className="pb">
        <div className="lead"><span>Cashier</span><i /><b>{auth?.name}</b></div>
        <div className="lead"><span>Clock</span><i /><b data-testid="clock-state">{last ? `Clocked ${last.kind} at ${hr(last.at)}${(last as { via?: string }).via ? ` · ${(last as { via?: string }).via}` : ""}` : "No punch yet"}</b></div>
        <div className="lead"><span>Register open since</span><i /><b>{session ? hr(session.openedAt) : "—"}</b></div>
      </div></div>
      <MyRoster />
      <div className="row-flex"><Button variant="primary" size="lg" disabled={last?.kind === "in"} onClick={() => punch("in")}>Clock in</Button><Button size="lg" disabled={last?.kind !== "in"} onClick={() => punch("out")}>Clock out</Button></div>
      <Callout tone="info">Clocking here is recorded with your PIN. Fingerprint terminals arrive in phase 2 and will clock you in automatically.</Callout>
      <div className="row-flex" style={{ borderTop: "1px solid var(--line)", paddingTop: 16 }}><span className="grow"><b>End of day</b><br /><span className="muted">Count the drawer and close this register.</span></span><Button size="lg" onClick={onClose}>Close register…</Button></div>
    </div></section>
  );
}

// ------------------------------------------------------------------ S09 Close register
export function CloseScreen({ onCancel }: { onCancel(): void }) {
  const { store, session, closeSession, catalogue, auth } = useApp();
  const [counts, setCounts] = useState<Record<string, number>>({}); const [stage, setStage] = useState<"count" | "review">("count");
  const [z, setZ] = useState<ProvisionalZ | null>(null); const [approving, setApproving] = useState(false); const [token, setToken] = useState<{ t: string; name: string } | null>(null); const [busy, setBusy] = useState(false);
  const total = DENOMS.reduce((a, d) => a + d.c * (counts[d.c] ?? 0), 0);
  const limit = catalogue?.location?.cashVarianceLimitMinor ?? 500; const variance = z ? total - z.expectedMinor : 0; const over = Math.abs(variance) > limit; const needsApproval = over && !auth?.canApprove && !token;
  if (!session) return null;
  if (approving) return <ApprovalPane kind="variance" onCancel={() => setApproving(false)} onApproved={(t, name) => { setToken({ t, name }); setApproving(false); }} />;
  return (<>
    <section className="pos-main" aria-label="Close register" style={{ gridTemplateRows: "auto 1fr", overflow: "auto" }}>
      <div className="row-flex"><h1 style={{ margin: 0, fontSize: 26 }}>Close the register</h1><span className="muted">{stage === "count" ? "Count the drawer first. The expected amount stays hidden until you have counted." : "Check the difference, then close."}</span></div>
      <div className="denoms">{DENOMS.map((d) => <div className="denom" key={d.c}><span>{d.n}</span><Stepper label={`${d.n} count`} value={counts[d.c] ?? 0} onChange={(n) => { setCounts((c) => ({ ...c, [d.c]: n })); setStage("count"); setToken(null); }} min={0} max={999} decrementIcon={<Minus size={16} />} incrementIcon={<Plus size={16} />} /><b className="num">{fmt(d.c * (counts[d.c] ?? 0))}</b></div>)}</div>
    </section>
    <aside className="sheet-pane" aria-label="Close sheet">
      <header><h2>Close sheet</h2><Button size="sm" variant="ghost" onClick={onCancel}>Back</Button></header>
      <div className="pane-body">
        <div className="lead total"><span>Counted</span><i /><b data-testid="close-counted" style={{ fontSize: 26 }}>{fmt(total)}</b></div>
        {stage === "review" && z && <>
          <Leaders z={z} counted={total} />
          {over && <Callout tone="warn">The count is {fmt(Math.abs(variance))} {variance < 0 ? "short" : "over"}, past the {fmt(limit)} limit.{needsApproval ? " A manager should approve it." : ""}</Callout>}
          {token && <Chip tone="ok"><Check size={12} /> Approved by {token.name}</Chip>}
        </>}
      </div>
      <div className="pane-foot">
        {stage === "count" ? <Button variant="primary" size="lg" style={{ minHeight: 60, fontSize: 20 }} onClick={async () => { setZ(await provisionalZ(store, session)); setStage("review"); }}>See the difference</Button> : <>
          {needsApproval && <Button size="lg" onClick={() => setApproving(true)}>Manager approval</Button>}
          <Button variant="primary" size="lg" style={{ minHeight: 60, fontSize: 20 }} disabled={busy} onClick={async () => { setBusy(true); try { await closeSession(total, Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0)), token?.t); } finally { setBusy(false); } }}>{needsApproval ? "Close without approval" : "Close register"}</Button></>}
      </div>
    </aside>
  </>);
}

export function ClosedScreen() {
  const { session, store, device, auth, sync, clearSession, signOut } = useApp();
  const [z, setZ] = useState<ProvisionalZ | null>(null); const [server, setServer] = useState<ServerSession | null>(null);
  useEffect(() => { if (session) void provisionalZ(store, session).then(setZ); }, [store, session]);
  useEffect(() => {
    if (!session || !device || !auth) return; let stop = false;
    const tick = async () => { try { const s = await getSession(device.apiUrl, auth.token, session.id); if (!stop && s.status !== "open") setServer(s); } catch (e) { if (!(e instanceof OfflineError) && !(e instanceof ApiError)) throw e; } };
    void tick(); const t = setInterval(() => { if (!server) void tick(); }, 3000); return () => { stop = true; clearInterval(t); };
  }, [session, device, auth, server]);
  if (!session) return null;
  const final = !!server; const expected = server?.expectedMinor ?? session.provisionalExpectedMinor ?? 0; const counted = server?.countedMinor ?? session.countedMinor ?? 0;
  const zShown = server?.z ? ({ ...server.z, openingFloatMinor: session.openingFloatMinor } as ProvisionalZ) : z;
  return (
    <main className="screen-center"><div className="card-auth" style={{ width: "min(640px,100%)" }}>
      <div className="row-flex"><h1 style={{ margin: 0 }}>Register closed</h1><span className="grow" />{final ? <Chip tone="ok"><Check size={12} /> Final</Chip> : <Chip tone="warn">Provisional · {sync.queued > 0 ? "waiting to send" : "checking"}</Chip>}</div>
      <p className="muted" style={{ margin: 0 }}>{session.cashierName} · opened {hr(session.openedAt)} · closed {session.closedAt ? hr(session.closedAt) : ""}</p>
      {zShown && <Leaders z={zShown} counted={counted} />}
      <div className="lead"><span>Server's figure for the difference</span><i /><b data-testid="final-variance">{final ? sgn((server!.varianceMinor ?? 0)) : "waiting"}</b></div>
      {final && (server!.flags.length > 0) && <Callout tone="warn">The server flagged this close: {server!.flags.join(", ")}. A manager will review it.</Callout>}
      <div className="row-flex"><span className="grow" /><Button variant="primary" size="lg" disabled={sync.queued > 0 && !final} onClick={async () => { await clearSession(); signOut(); }}>Done</Button></div>
      {expected === 0 && counted === 0 && null}
    </div></main>
  );
}
