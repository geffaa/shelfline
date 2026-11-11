import { useEffect, useMemo, useState } from "react";
import { Banknote, Check, ChevronDown, CreditCard, Delete, Minus, Plus, Printer, Search, Trash2, UserRound, WifiOff, X } from "lucide-react";
import { Button, Callout, Chip, Keypad, PinDots, Segmented, Select, Stepper, Switch } from "@shelfline/ui";
import { SCHEMA_V } from "@shelfline/contracts";
import { uuidv7 } from "@shelfline/sync-client";
import { ApiError, apiCall, lookupPickup, OfflineError, printProblem, requestApproval, type PickupOrder } from "../lib/api";
import { lineDiscountMinor, type Cart, type CartLine } from "../lib/cart";
import type { Catalogue, CustomerView, VariantView } from "../lib/catalogue";
import { clockTime, fmt } from "../lib/format";
import type { LocalSale, PaymentInput, Tender } from "../lib/sales";
import { useApp } from "../state/app";

const REASONS = [{ value: "price_match", label: "Price match" }, { value: "damaged_box", label: "Damaged box" }, { value: "staff", label: "Staff or friends and family" }, { value: "loyalty", label: "Loyalty" }, { value: "other", label: "Other" }];
const REASON_LABEL = Object.fromEntries(REASONS.map((r) => [r.value, r.label]));
const PCTS = [{ value: "0", label: "None" }, { value: "500", label: "5%" }, { value: "1000", label: "10%" }, { value: "1500", label: "15%" }, { value: "2000", label: "20%" }];

export interface CartPaneProps {
  cart: Cart; catalogue: Catalogue; totals: { subtotal: number; discount: number; tax: number; total: number }; lines: { line: CartLine; v: VariantView | undefined; total: number; promo: number }[];
  customer: CustomerView | null; parkedCount: number; limitBp: number; canApprove: boolean;
  onQty(key: string, qty: number): void; onRemove(key: string): void; onDiscount(key: string, bp: number, reason?: string): void; onNeedApproval(key: string, bp: number, reason: string): void;
  onCustomer(): void; onPark(): void; onParked(): void; onPay(): void; onClear(): void;
}

export function CartPane(p: CartPaneProps) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <aside className="cart" aria-label="Current sale">
      <header><h2>Current sale</h2><div className="row-flex" style={{ gap: 6 }}>{p.parkedCount > 0 && <Button size="sm" onClick={p.onParked}>Parked ({p.parkedCount})</Button>}<Chip>{p.lines.reduce((a, l) => a + l.line.qty, 0)} items</Chip></div></header>
      <div style={{ display: "grid", gridTemplateRows: "auto 1fr", minHeight: 0 }}>
        <div className="cust"><UserRound size={18} />
          <div style={{ flex: 1, lineHeight: 1.2 }}>{p.customer ? <><b>{p.customer.name}</b><br /><span className="muted" style={{ fontSize: 13 }}>{p.customer.phone ?? p.customer.email ?? "No contact details"}</span></> : <span className="muted">No customer</span>}</div>
          <Button size="sm" variant="ghost" onClick={p.onCustomer}>{p.customer ? "Change" : "Add customer"}</Button></div>
        <div className="lines">
          {p.lines.length === 0 && <p className="muted" style={{ padding: 16, margin: 0 }}>Scan an item or search for one to start a sale.</p>}
          {p.lines.map(({ line, v, total, promo }) => (
            <div className="line" key={line.key} data-testid="cart-line">
              <span><span className="t">{v?.title ?? "Unknown item"}</span><br /><span className="v">{v?.optionsLabel}</span></span><span className="amt">{(total / 100).toFixed(2)}</span>
              <div className="ctl">
                <Stepper label={`${v?.title ?? "item"} quantity`} value={line.qty} min={1} max={999} onChange={(n) => p.onQty(line.key, n)} decrementIcon={<Minus size={16} />} incrementIcon={<Plus size={16} />} />
                <span className="row-flex" style={{ gap: 4 }}>
                  <Button size="sm" variant="ghost" aria-expanded={editing === line.key} onClick={() => setEditing(editing === line.key ? null : line.key)}>{line.discountBp ? `${line.discountBp / 100}% off` : "Discount"}</Button>
                  <Button size="sm" variant="ghost" aria-label={`Remove ${v?.title ?? "item"}`} onClick={() => p.onRemove(line.key)}><Trash2 size={16} /></Button>
                </span>
              </div>
              {promo > 0 && <div className="disc" style={{ gridColumn: "1/3" }} data-testid="promo-line">{`Promotion −${(promo / 100).toFixed(2)}`}</div>}
              {line.discountBp > 0 && <div className="disc" style={{ gridColumn: "1/3" }}>{`−${(lineDiscountMinor(line) / 100).toFixed(2)}`} · {REASON_LABEL[line.discountReason ?? ""] ?? line.discountReason}{line.approverName ? ` · approved by ${line.approverName}` : ""}</div>}
              {editing === line.key && <DiscountEditor line={line} limitBp={p.limitBp} canApprove={p.canApprove} onApply={(bp, reason) => { setEditing(null); if (bp > p.limitBp && !p.canApprove && bp !== 0) p.onNeedApproval(line.key, bp, reason); else p.onDiscount(line.key, bp, reason); }} />}
            </div>))}
        </div>
      </div>
      <div className="totals">
        <div className="lead"><span>Subtotal</span><i /><b>{(p.totals.subtotal / 100).toFixed(2)}</b></div>
        {p.totals.discount > 0 && <div className="lead gain"><span>Discount</span><i /><b>{`−${(p.totals.discount / 100).toFixed(2)}`}</b></div>}
        <div className="lead sub"><span>GST included</span><i /><b>{(p.totals.tax / 100).toFixed(2)}</b></div>
        <div className="grand"><span>Total</span><b data-testid="cart-total">{fmt(p.totals.total)}</b></div>
        <div className="acts"><Button onClick={p.onPark} disabled={p.lines.length === 0}>Park</Button><Button onClick={p.onClear} disabled={p.lines.length === 0}>Clear</Button><Button onClick={p.onCustomer}>Customer</Button></div>
        <Button variant="primary" size="lg" style={{ width: "100%", minHeight: 60, fontSize: 20 }} disabled={p.lines.length === 0} onClick={p.onPay}>Pay {fmt(p.totals.total)}</Button>
      </div>
    </aside>
  );
}

function DiscountEditor({ line, limitBp, canApprove, onApply }: { line: CartLine; limitBp: number; canApprove: boolean; onApply(bp: number, reason: string): void }) {
  const [pct, setPct] = useState(String(line.discountBp)); const [reason, setReason] = useState<string | null>(line.discountReason ?? null);
  const bp = Number(pct);
  return (
    <div className="stack" style={{ gridColumn: "1/3", padding: "8px 0" }}>
      <Segmented label="Discount percentage" value={pct} onChange={setPct} options={PCTS} size="lg" />
      <Select label="Discount reason" value={reason} onChange={setReason} options={REASONS} placeholder="Reason" chevron={<ChevronDown size={16} />} />
      {bp > limitBp && !canApprove && <Callout tone="info">Over {limitBp / 100}%: a manager must approve with their PIN.</Callout>}
      <Button variant="primary" disabled={bp > 0 && !reason} onClick={() => onApply(bp, reason ?? "other")}>{bp === 0 ? "Remove discount" : bp > limitBp && !canApprove ? "Ask a manager" : "Apply discount"}</Button>
    </div>
  );
}

export function ApprovalPane({ onApproved, onCancel, kind = "discount" }: { onApproved(token: string, approverName: string): void; onCancel(): void; kind?: "discount" | "variance" | "refund" }) {
  const { device, auth } = useApp();
  const [code, setCode] = useState(""); const [pin, setPin] = useState(""); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!device || !auth || !code || pin.length < 4) return; setBusy(true); setErr(null);
    try { const r = await requestApproval(device.apiUrl, auth.token, device.deviceKey, code.trim(), pin, kind); onApproved(r.approvalToken, r.approver.name); }
    catch (e) { setPin(""); setErr(e instanceof OfflineError ? "Manager approval needs the network. Wait until the iPad is back online, or ask the manager to do this on their own sign-in." : e instanceof ApiError && e.status === 403 ? "That person cannot approve discounts." : e instanceof ApiError && e.status === 423 ? "That PIN is locked." : "That code and PIN do not match."); } finally { setBusy(false); }
  };
  return (
    <aside className="sheet-pane" aria-label="Manager approval">
      <header><h2>{kind === "discount" ? "Manager approval" : kind === "refund" ? "Approve this refund" : "Approve the count"}</h2><Button size="sm" variant="ghost" onClick={onCancel} aria-label="Cancel approval"><X size={18} /></Button></header>
      <div className="pane-body">
        <div className="field-in"><label htmlFor="mcode">Manager employee code</label><div className="input"><input id="mcode" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="off" autoFocus /></div></div>
        <div className="stack" style={{ justifyItems: "center" }}><PinDots length={Math.max(4, pin.length)} filled={pin.length} label="Manager PIN" />
          <Keypad listen={false} disabled={busy} onDigit={(d) => setPin((x) => (x.length < 8 ? x + d : x))} onBackspace={() => setPin((x) => x.slice(0, -1))} onSubmit={pin.length >= 4 && code ? submit : undefined} submitLabel="Approve" backspaceIcon={<Delete size={22} />} submitIcon={<Check size={24} />} /></div>
        {err && <p className="err" role="alert" style={{ margin: 0 }}>{err}</p>}
      </div>
      <div className="pane-foot"><span className="muted">The approval is valid for 10 minutes on this iPad and is recorded with the sale or session.</span></div>
    </aside>
  );
}

export function CustomerPane({ catalogue, onPick, onClose }: { catalogue: Catalogue; onPick(c: CustomerView | null): void; onClose(): void }) {
  const { store, reloadCatalogue, auth, syncNow } = useApp();
  const [q, setQ] = useState(""); const [creating, setCreating] = useState(false);
  const [name, setName] = useState(""); const [phone, setPhone] = useState(""); const [email, setEmail] = useState(""); const [consent, setConsent] = useState(false); const [err, setErr] = useState<string | null>(null);
  const results = useMemo(() => catalogue.searchCustomers(q), [catalogue, q]);
  const create = async () => {
    if (!auth) return; if (!name.trim()) { setErr("A name is needed."); return; }
    const id = uuidv7(); const data = { id, name: name.trim(), email: email.trim() || null, phone: phone.trim() || null };
    await store.transact(async (tx) => {
      await tx.applyItems([{ type: "customer", id, op: "upsert", data }]);   // visible on this iPad immediately, even offline
      await tx.enqueue({ type: "customer.create", payload: { customerId: id, name: data.name, ...(data.email ? { email: data.email } : {}), ...(data.phone ? { phone: data.phone } : {}), marketingConsent: { email: consent, sms: consent } }, actorId: auth.userId, schemaV: SCHEMA_V });
    });
    await reloadCatalogue(); void syncNow(); onPick({ id, name: data.name, email: data.email, phone: data.phone });
  };
  return (
    <aside className="sheet-pane" aria-label="Customer">
      <header><h2>{creating ? "New customer" : "Customer"}</h2><Button size="sm" variant="ghost" onClick={onClose} aria-label="Close customer"><X size={18} /></Button></header>
      <div className="pane-body">
        {!creating ? <>
          <label className="input"><Search size={16} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, phone or email" aria-label="Search customers" autoFocus /></label>
          {results.map((c) => <button key={c.id} className="list-btn" onClick={() => onPick(c)}><b>{c.name}</b><small>{c.phone ?? c.email ?? ""}</small></button>)}
          {results.length === 0 && <p className="muted" style={{ margin: 0 }}>No customer matches “{q}”.</p>}
          <Button onClick={() => { setCreating(true); setName(q); }}>Create a new customer</Button>
          <Button variant="ghost" onClick={() => onPick(null)}>Continue without a customer</Button>
        </> : <>
          <div className="field-in"><label htmlFor="cn">Name</label><div className="input"><input id="cn" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></div></div>
          <div className="field-in"><label htmlFor="cp">Phone</label><div className="input"><input id="cp" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" /></div></div>
          <div className="field-in"><label htmlFor="ce">Email</label><div className="input"><input id="ce" value={email} onChange={(e) => setEmail(e.target.value)} inputMode="email" autoCapitalize="none" /></div></div>
          <Switch checked={consent} onChange={setConsent}>Happy to receive offers</Switch>
          {err && <p className="err" role="alert" style={{ margin: 0 }}>{err}</p>}
          <div className="row-flex"><Button onClick={() => setCreating(false)}>Back</Button><span className="grow" /><Button variant="primary" onClick={create}>Save and use</Button></div>
        </>}
      </div>
      <div className="pane-foot"><span className="muted">New customers are saved on this iPad and sent when it is online.</span></div>
    </aside>
  );
}

export function ParkedPane({ items, onRecall, onDelete, onClose }: { items: { id: string; at: string; lines: number; total: number }[]; onRecall(id: string): void; onDelete(id: string): void; onClose(): void }) {
  return (
    <aside className="sheet-pane" aria-label="Parked sales">
      <header><h2>Parked sales</h2><Button size="sm" variant="ghost" onClick={onClose} aria-label="Close parked sales"><X size={18} /></Button></header>
      <div className="pane-body">{items.length === 0 && <p className="muted" style={{ margin: 0 }}>Nothing is parked.</p>}
        {items.map((i) => <div key={i.id} className="list-btn"><span><b>{i.lines} item{i.lines === 1 ? "" : "s"}</b> · {fmt(i.total)}<br /><small>Parked at {clockTime(new Date(i.at))}</small></span><span className="row-flex" style={{ gap: 4 }}><Button size="sm" variant="primary" onClick={() => onRecall(i.id)}>Recall</Button><Button size="sm" variant="ghost" aria-label="Delete parked sale" onClick={() => onDelete(i.id)}><Trash2 size={16} /></Button></span></div>)}</div>
      <div className="pane-foot"><span className="muted">Parked sales stay on this iPad; they are not sent to other tills.</span></div>
    </aside>
  );
}

/** Payment state shared by the entry area (left) and the summary pane (right). */
export function usePayment(totalNoRounding: number, totalCashRounded: number) {
  const [payments, setPayments] = useState<PaymentInput[]>([]); const [tender, setTender] = useState<Tender>("cash"); const [digits, setDigits] = useState(""); const [ref, setRef] = useState("");
  const cashOnly = payments.every((p) => p.tender === "cash") && (payments.length > 0 ? true : tender === "cash");
  const payable = cashOnly ? totalCashRounded : totalNoRounding;
  const applied = payments.reduce((a, p) => a + p.amountMinor, 0);
  const remaining = Math.max(0, payable - applied);
  const entered = digits ? Number(digits) : 0;                     // cents-entry: typing 5 0 0 0 means 50.00
  const amount = entered > 0 ? entered : remaining;
  const change = payments.reduce((a, p) => a + (p.tender === "cash" && p.tenderedMinor !== undefined ? Math.max(0, p.tenderedMinor - p.amountMinor) : 0), 0);
  const add = (t: Tender, tendered: number, reference?: string) => {
    if (remaining <= 0) return;
    if (t !== "cash" && tendered > remaining) return;           // only cash can be over-tendered (change is given)
    const apply = Math.min(tendered, remaining); const r = reference ?? ref.trim();
    setPayments((p) => [...p, { tender: t, amountMinor: apply, ...(t === "cash" ? { tenderedMinor: tendered } : {}), ...(t !== "cash" && r ? { reference: r } : {}) }]);
    setDigits(""); setRef("");
  };
  const reset = () => { setPayments([]); setTender("cash"); setDigits(""); setRef(""); };
  return { payments, setPayments, tender, setTender, digits, setDigits, ref, setRef, cashOnly, payable, remaining, amount, entered, change, add, reset, rounding: cashOnly && totalCashRounded !== totalNoRounding, totalNoRounding };
}
export type PaymentApi = ReturnType<typeof usePayment>;

/** Left area while paying: method, amount, quick cash buttons and the number pad. Big and unhurried; the empty product area is the room for it. */
const TENDER_LABEL: Record<string, string> = { cash: "Cash", card: "Card", other: "Other", gift_card: "Gift card", store_credit: "Store credit" };
const shown = (p: PaymentInput) => (p.tender === "gift_card" ? `Gift card …${(p.reference ?? "").replace(/[^A-Za-z0-9]/g, "").slice(-4).toUpperCase()}` : TENDER_LABEL[p.tender] ?? p.tender);
const sha = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).map((b) => b.toString(16).padStart(2, "0")).join("");

/** Gift card and store credit. Online it asks the server what is on the card; offline it is allowed only where the location's policy says so, up to its cap, once per card per iPad. */
function GiftEntry({ pay, kind, customerId }: { pay: PaymentApi; kind: "gift_card" | "store_credit"; customerId: string | null }) {
  const { device, auth, catalogue, store } = useApp(); const { remaining, add } = pay; const [code, setCode] = useState(""); const [info, setInfo] = useState<{ balanceMinor: number; status?: string; expired?: boolean } | null>(null); const [msg, setMsg] = useState<string | null>(null); const [offline, setOffline] = useState(false);
  const policy = catalogue?.location; const allowOffline = !!policy?.giftCardOffline && kind === "gift_card"; const cap = policy?.giftCardOfflineCapMinor ?? 0;
  useEffect(() => { setInfo(null); setMsg(null); setOffline(false); if (kind === "store_credit" && customerId) void check(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [kind, customerId]);
  async function check() {
    setMsg(null); setInfo(null);
    try {
      const r = kind === "gift_card" ? await apiCall<any>(device!.apiUrl, auth!.token, `/gift-cards/lookup?code=${encodeURIComponent(code.trim())}`) : await apiCall<any>(device!.apiUrl, auth!.token, `/customers/${customerId}/credit`);
      setOffline(false); setInfo(r); if (r.status === "void") setMsg("This card has been cancelled."); else if (r.expired) setMsg("This card has expired."); else if (r.balanceMinor <= 0) setMsg("There is nothing left on this card.");
    } catch (e) { if (e instanceof OfflineError) { setOffline(true); setMsg(kind === "store_credit" ? "Store credit needs a connection." : allowOffline ? `Offline: this store accepts a gift card up to ${fmt(cap)}, once per card, without checking the balance.` : "Gift cards need a connection at this store."); } else setMsg(e instanceof ApiError && e.status === 404 ? "That card was not found. Check the code." : "Could not check the card."); }
  }
  const usable = info && info.status !== "void" && !info.expired && info.balanceMinor > 0;
  const useOnline = () => add(kind, Math.min(info!.balanceMinor, remaining), kind === "gift_card" ? code.trim() : undefined);
  const useOffline = async () => {
    const h = await sha(code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "")); const used: string[] = JSON.parse((await store.getMeta("offlineGiftUsed")) ?? "[]");
    if (used.includes(h)) { setMsg("This card was already used offline on this iPad. It can be used again once the iPad is back online."); return; }
    await store.transact((tx) => tx.setMeta("offlineGiftUsed", JSON.stringify([...used, h]))); add("gift_card", Math.min(cap, remaining), code.trim());
  };
  return (
    <div className="stack">
      {kind === "gift_card" && <div className="field-in"><label htmlFor="gcode">Gift card code</label><div className="row-flex"><div className="input grow"><input id="gcode" value={code} onChange={(e) => { setCode(e.target.value); setInfo(null); setMsg(null); }} placeholder="XXXX-XXXX-XXXX-XXXX" autoCapitalize="characters" autoComplete="off" /></div><Button onClick={() => void check()} disabled={code.replace(/[^A-Za-z0-9]/g, "").length < 8}>Check card</Button></div></div>}
      {kind === "store_credit" && !customerId && <Callout tone="info">Add the customer to the sale first. Store credit belongs to a customer.</Callout>}
      {info && <div className="lead"><span>{kind === "gift_card" ? `Card …${(info as any).last4 ?? ""}` : "Store credit"}</span><i /><b data-testid="gift-balance">{fmt(Math.max(0, info.balanceMinor))}</b></div>}
      {msg && <p className="muted" role="status" style={{ margin: 0 }} data-testid="gift-msg">{msg}</p>}
      {usable && <Button variant="primary" size="lg" onClick={useOnline}>{`Use ${fmt(Math.min(info!.balanceMinor, remaining))}`}</Button>}
      {offline && allowOffline && code.replace(/[^A-Za-z0-9]/g, "").length >= 8 && <Button variant="primary" size="lg" onClick={() => void useOffline()}>{`Use ${fmt(Math.min(cap, remaining))} without checking`}</Button>}
    </div>
  );
}


interface CardState { id: string; amountMinor: number; status: "processing" | "succeeded" | "failed" | "canceled"; failure: string | null; reference: string; last4: string | null; brand: string | null }
const DECLINE: Record<string, string> = { card_declined: "The card was declined.", timed_out: "No card was presented in time.", insufficient_funds: "Not enough funds on the card." };
/** Sends the amount to the card terminal on the counter and waits for the customer to tap or insert. The sale is only recorded as card-paid once the terminal has said yes. */
function CardTerminal({ pay }: { pay: PaymentApi }) {
  const { device, auth, sync } = useApp(); const [card, setCard] = useState<CardState | null>(null); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false); const amount = Math.min(pay.amount, pay.remaining);
  const online = sync.state !== "offline";
  useEffect(() => {
    if (!card || card.status !== "processing" || !device || !auth) return; let live = true;
    const t = setInterval(async () => {
      try { const r = await apiCall<CardState>(device.apiUrl, auth.token, `/pos/card/${card.id}`); if (!live) return; if (r.status === "succeeded") { setCard(null); setBusy(false); pay.add("card", r.amountMinor ?? amount, r.reference); setMsg(`Approved${r.brand ? ` ${r.brand}` : ""}${r.last4 ? ` ending ${r.last4}` : ""}.`); } else if (r.status !== "processing") { setCard(null); setBusy(false); setMsg(r.status === "canceled" ? "Payment cancelled." : DECLINE[r.failure ?? ""] ?? "The payment did not go through."); } }
      catch { /* keep asking: a dropped request is not a declined card */ }
    }, 1000);
    return () => { live = false; clearInterval(t); };
  }, [card?.id, card?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const begin = async () => {
    if (!device || !auth || amount <= 0) return; setBusy(true); setMsg(null);
    try { setCard(await apiCall<CardState>(device.apiUrl, auth.token, "/pos/card/start", "POST", { amountMinor: amount, idempotencyKey: uuidv7() })); }
    catch (e) { setBusy(false); setMsg(e instanceof ApiError && e.code === "no_reader" ? "No card terminal is set up for this register. Take the payment on your own terminal and add it below." : e instanceof OfflineError ? "The card terminal needs a connection. Take the payment on your own terminal and add it below." : "Could not reach the card terminal."); }
  };
  const cancel = async () => { if (!card || !device || !auth) return; try { await apiCall(device.apiUrl, auth.token, `/pos/card/${card.id}/cancel`, "POST"); } catch { /* the next poll will say */ } };
  return (
    <div className="stack" data-testid="card-terminal">
      {card ? <Callout tone="info" icon={<CreditCard size={18} />}><span role="status"><b>Waiting for the customer.</b> {fmt(card.status === "processing" ? amount : 0)} is on the card terminal. Ask them to tap, insert or swipe.</span></Callout> : null}
      <div className="row-flex"><Button variant="primary" size="lg" style={{ minHeight: 64, fontSize: 20 }} onClick={() => void begin()} disabled={busy || !online || amount <= 0}><CreditCard size={20} /> Charge {fmt(amount)} on the card terminal</Button>{card && <Button size="lg" onClick={() => void cancel()}>Cancel</Button>}</div>
      {!online && <span className="muted" style={{ fontSize: 13 }}>The card terminal needs a connection.</span>}{msg && <span role="status" className={/Approved/.test(msg) ? "" : "err"} data-testid="card-msg">{msg}</span>}
    </div>
  );
}

export function PayEntry({ pay, customerId = null }: { pay: PaymentApi; customerId?: string | null }) {
  const { tender, setTender, remaining, amount, entered, digits, setDigits, ref, setRef, add } = pay;
  const quick = useMemo(() => { const set = new Set<number>([remaining]); for (const n of [500, 1000, 2000, 5000, 10000]) if (n > remaining) set.add(n); return [...set].sort((a, b) => a - b).slice(0, 5); }, [remaining]);
  if (remaining <= 0) return <section className="pos-main" aria-label="Payment entry"><div className="panel"><div className="pb"><b>The sale is fully paid.</b><span className="muted"> Check the change on the right, then complete the sale.</span></div></div></section>;
  return (
    <section className="pos-main" aria-label="Payment entry" style={{ gridTemplateRows: "auto auto 1fr", alignContent: "start", overflow: "auto" }}>
      <Segmented label="Payment method" value={tender} onChange={setTender} size="lg" options={[{ value: "cash", label: "Cash" }, { value: "card", label: "Card" }, { value: "gift_card", label: "Gift card" }, ...(customerId ? [{ value: "store_credit" as const, label: "Store credit" }] : []), { value: "other", label: "Other" }]} />
      <div className="stack">
        <div className="lead"><span>{entered ? "Amount" : "Remaining"}</span><i /><b data-testid="pay-remaining" style={{ fontSize: 28 }}>{fmt(amount)}</b></div>
        {tender === "gift_card" || tender === "store_credit" ? <GiftEntry pay={pay} kind={tender} customerId={customerId} /> : tender === "cash" ? <div className="row-flex" style={{ gap: 8 }}>{quick.map((q) => <Button key={q} size="lg" onClick={() => add("cash", q)}>{q === remaining ? "Exact" : fmt(q)}</Button>)}</div>
          : <>
            {tender === "card" && <CardTerminal pay={pay} />}
            <Callout tone="info" icon={<CreditCard size={18} />}>{tender === "card" ? "No card terminal, or it is not working? Take the payment on your own terminal first, then record it below." : "Card and other payments are recorded here, not processed. Take the payment on your terminal first, then add it."}</Callout>
            <div className="field-in"><label htmlFor="ref">Reference (optional)</label><div className="input"><input id="ref" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Terminal receipt or last 4 digits" /></div></div></>}
      </div>
      {tender !== "gift_card" && tender !== "store_credit" && <div className="row-flex" style={{ alignItems: "start", gap: 24 }}>
        <div style={{ width: 300 }}><Keypad listen onDigit={(d) => setDigits((x) => (x.length < 8 ? x + d : x).replace(/^0+/, ""))} onBackspace={() => setDigits((x) => x.slice(0, -1))} onSubmit={() => add(tender, amount)} submitLabel={`Add ${tender}`} backspaceIcon={<Delete size={22} />} submitIcon={<Check size={24} />} /></div>
        <div className="grow stack"><Button variant="primary" size="lg" style={{ minHeight: 64, fontSize: 20 }} onClick={() => add(tender, amount)} disabled={tender !== "cash" && amount > remaining}>{`Add ${tender} ${fmt(tender === "cash" ? amount : Math.min(amount, remaining))}`}</Button>
          {digits && <Button variant="ghost" onClick={() => setDigits("")}>Clear amount</Button>}</div>
      </div>}
    </section>
  );
}

export function PaySummary({ pay, onBack, onComplete }: { pay: PaymentApi; onBack(): void; onComplete(payments: PaymentInput[]): Promise<void> }) {
  const { sync } = useApp(); const [busy, setBusy] = useState(false);
  const { payments, setPayments, payable, remaining, change, rounding, totalNoRounding } = pay;
  return (
    <aside className="sheet-pane" aria-label="Payment">
      <header><h2>Payment</h2><Button size="sm" variant="ghost" onClick={onBack} disabled={busy}>Back to sale</Button></header>
      <div className="pane-body">
        <div className="lead total"><span>To pay</span><i /><b data-testid="pay-total" style={{ fontSize: 28 }}>{fmt(payable)}</b></div>
        {rounding && <div className="muted" style={{ fontSize: 13 }}>Cash total rounded to the nearest 5c from {fmt(totalNoRounding)}.</div>}
        {payments.length === 0 && <span className="muted">No payment added yet.</span>}
        {payments.map((p, i) => <div className="tender-line" key={i} data-testid="tender-line"><span>{p.tender === "cash" ? <Banknote size={16} /> : <CreditCard size={16} />} {shown(p)}{p.reference && p.tender !== "gift_card" ? ` · ${p.reference}` : ""}</span><span className="row-flex" style={{ gap: 6 }}><b className="num">{fmt(p.amountMinor)}</b><Button size="sm" variant="ghost" aria-label={`Remove ${p.tender} payment`} onClick={() => setPayments((x) => x.filter((_, j) => j !== i))}><X size={14} /></Button></span></div>)}
        {remaining > 0 ? <div className="lead"><span>Still to pay</span><i /><b>{fmt(remaining)}</b></div> : change > 0 ? <div className="lead"><span>Change due</span><i /><b data-testid="change-due" style={{ fontSize: 28 }}>{fmt(change)}</b></div> : null}
        {remaining <= 0 && sync.state === "offline" && <Callout tone="warn" icon={<WifiOff size={18} />}>Offline: the sale will be saved here and sent when the iPad reconnects.</Callout>}
      </div>
      <div className="pane-foot"><Button variant="primary" size="lg" style={{ minHeight: 60, fontSize: 20 }} disabled={remaining > 0 || busy} onClick={async () => { setBusy(true); try { await onComplete(payments); } finally { setBusy(false); } }}>Complete sale</Button></div>
    </aside>
  );
}

export function ReceiptPane({ sale, queued, onPrint, onNew }: { sale: LocalSale; queued: boolean; onPrint(): Promise<{ printer: string; copy?: number }>; onNew(): void }) {
  const t = sale.totals; const [printMsg, setPrintMsg] = useState<{ ok: boolean; text: string } | null>(null); const [printing, setPrinting] = useState(false);
  const print = async () => { setPrinting(true); setPrintMsg(null); try { const r = await onPrint(); setPrintMsg({ ok: true, text: `Sent to ${r.printer}${r.copy && r.copy > 1 ? ` (copy ${r.copy})` : ""}.` }); } catch (e) { setPrintMsg({ ok: false, text: printProblem(e) }); } finally { setPrinting(false); } };
  useEffect(() => { document.getElementById("new-sale")?.focus(); }, []);
  return (
    <aside className="sheet-pane" aria-label="Receipt">
      <header><h2>Sale complete</h2>{queued ? <Chip tone="warn"><WifiOff size={12} /> Waiting to send</Chip> : <Chip tone="ok"><Check size={12} /> Sent</Chip>}</header>
      <div className="pane-body" style={{ justifyItems: "center" }}>
        {sale.changeMinor > 0 && <div className="lead" style={{ width: "100%" }}><span>Change due</span><i /><b data-testid="change-due" style={{ fontSize: 28 }}>{fmt(sale.changeMinor)}</b></div>}
        <div className="receipt" data-testid="receipt">
          <h2>Kestrel Run Co.</h2><div className="c">{sale.registerCode} · {sale.receiptNo}</div><div className="c">{new Date(sale.at).toLocaleString("en-AU")} · {sale.cashierName}</div>{sale.customerName && <div className="c">{sale.customerName}</div>}<hr className="perf" />
          {sale.lines.map((l, i) => <div key={i}><div className="lead"><span>{l.qty} × {l.title}{l.optionsLabel ? ` ${l.optionsLabel}` : ""}</span><i /><b>{(l.totalMinor / 100).toFixed(2)}</b></div>{l.discountMinor > 0 && <div className="lead sub"><span>discount</span><i /><b>{`−${(l.discountMinor / 100).toFixed(2)}`}</b></div>}</div>)}
          <div className="lead total"><span>Total</span><i /><b>{(t.totalMinor / 100).toFixed(2)}</b></div>
          {t.roundingMinor !== 0 && <div className="lead sub"><span>Cash rounding</span><i /><b>{(t.roundingMinor / 100).toFixed(2)}</b></div>}
          <div className="lead sub"><span>GST included</span><i /><b>{(t.taxMinor / 100).toFixed(2)}</b></div><hr className="perf" />
          {sale.payments.map((p, i) => <div className="lead" key={i}><span>{shown(p)}</span><i /><b>{((p.tenderedMinor ?? p.amountMinor) / 100).toFixed(2)}</b></div>)}
          {sale.changeMinor > 0 && <div className="lead"><span>Change</span><i /><b>{(sale.changeMinor / 100).toFixed(2)}</b></div>}
        </div>
        <div style={{ display: "grid", gap: 6, justifyItems: "center", width: "100%" }}>
          <Button size="lg" onClick={() => void print()} disabled={queued || printing} aria-describedby="print-hint"><Printer size={18} /> Print receipt</Button>
          <span id="print-hint" role="status" className={printMsg && !printMsg.ok ? "err" : "muted"} style={{ fontSize: 13 }}>{printMsg ? printMsg.text : queued ? "You can print once the sale has been sent." : "Prints on this register's receipt printer."}</span>
        </div>
      </div>
      <div className="pane-foot"><Button id="new-sale" variant="primary" size="lg" style={{ minHeight: 60, fontSize: 20 }} onClick={onNew}>New sale</Button></div>
    </aside>
  );
}

/** Collecting an online order: type the code the customer shows, check what is in it, and load it into the sale. The customer pays here, as for any sale. */
export function PickupPane({ onClose, onLoad }: { onClose(): void; onLoad(o: PickupOrder): { ok: boolean; why?: string } }) {
  const { device, auth, sync } = useApp(); const [code, setCode] = useState(""); const [order, setOrder] = useState<PickupOrder | null>(null); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const find = async () => { if (!device || !auth || code.trim().length < 4) return; setBusy(true); setMsg(null); setOrder(null);
    try { setOrder(await lookupPickup(device.apiUrl, auth.token, code)); } catch (e) { setMsg(e instanceof OfflineError ? "Looking up an online order needs a connection." : e instanceof ApiError && e.status === 404 ? "No open order has that code at this store." : "Could not look that order up."); } finally { setBusy(false); } };
  return (
    <aside className="sheet-pane" aria-label="Online pickup">
      <header><h2>Online pickup</h2><Button size="sm" variant="ghost" onClick={onClose} aria-label="Close"><X size={18} /></Button></header>
      <div className="pane-body">
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void find(); }}>
          <div className="field-in"><label htmlFor="pickup-code">Pickup code</label><div className="input"><input id="pickup-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))} autoFocus autoComplete="off" placeholder="6 characters" style={{ fontFamily: "var(--f-mono)", letterSpacing: 4, fontSize: 22 }} /></div></div>
          <Button variant="primary" size="lg" type="submit" disabled={busy || code.length < 4 || sync.state === "offline"}>Find order</Button>
        </form>
        {msg && <p className="err" role="alert">{msg}</p>}
        {order && <div className="stack" data-testid="pickup-order"><div className="lead"><span><b>{order.number}</b> · {order.customer}</span><i /><b>{fmt(order.totalMinor)}</b></div>
          {order.lines.map((l) => <div className="lead" key={l.variantId}><span>{l.qty} × {l.title}{l.options ? ` ${l.options}` : ""}</span><i /><b>{fmt(l.totalMinor)}</b></div>)}
          <Button variant="primary" size="lg" onClick={() => { const r = onLoad(order); if (!r.ok) setMsg(r.why ?? "Could not load that order."); }}>Load into sale</Button>
          <span className="muted" style={{ fontSize: 13 }}>The customer pays here. The sale uses today's prices; any difference from the order is recorded.</span></div>}
      </div>
    </aside>
  );
}
