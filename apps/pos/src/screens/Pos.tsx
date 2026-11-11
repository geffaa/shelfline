import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Banknote, Boxes, Clock, Lock, Receipt, RefreshCw, ScanBarcode, Search, Store, WifiOff } from "lucide-react";
import { Button, Callout } from "@shelfline/ui";
import { uuidv7 } from "@shelfline/sync-client";
import { addVariant, approveLine, emptyCart, lineDiscountMinor, priceOf, removeLine, setCustomer, setDiscount, setQty, type Cart } from "../lib/cart";
import type { CustomerView, VariantView } from "../lib/catalogue";
import { clockTime, fmt } from "../lib/format";
import { requestPrint } from "../lib/api";
import { ScanBuffer } from "../lib/scanner";
import { completeSale, type LocalSale } from "../lib/sales";
import { useApp } from "../state/app";
import { ApprovalPane, CartPane, CustomerPane, ParkedPane, PayEntry, PaySummary, PickupPane, ReceiptPane, usePayment } from "./Panes";
import { CashScreen, CloseScreen, OrdersScreen, ShiftScreen } from "./Register";
import { StockScreen } from "./Stock";
import { SyncScreen } from "./SyncScreen";

type Pane = { kind: "cart" } | { kind: "pickup" } | { kind: "pay" } | { kind: "customer" } | { kind: "parked" } | { kind: "approve"; key: string; bp: number; reason: string } | { kind: "receipt"; sale: LocalSale };
interface Parked { id: string; at: string; cart: Cart }
const CASH_STEP = 5;
const localDate = (tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());

export function Pos() {
  const { store, device, catalogue, auth, session, sync, syncNow, signOut, reloadCatalogue } = useApp();
  const [view, setView] = useState<"sell" | "orders" | "cash" | "stock" | "shift" | "close" | "sync">("sell");
  const [cart, setCart] = useState<Cart>(emptyCart()); const [pane, setPane] = useState<Pane>({ kind: "cart" });
  const [query, setQuery] = useState(""); const [parked, setParked] = useState<Parked[]>([]); const [flash, setFlash] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null); const loaded = useRef(false);

  // The cart survives a reload or a crash: it is a draft in the local store, never only in memory.
  useEffect(() => { void (async () => { const d = await store.get<Cart>("draft", "cart"); if (d) setCart(d); const pk = await store.list<Parked>("parked"); setParked(pk.map((x) => x.value)); loaded.current = true; })(); }, [store]);
  useEffect(() => { if (loaded.current) void store.transact((tx) => (cart.lines.length || cart.customerId ? tx.put("draft", "cart", cart) : tx.del("draft", "cart"))); }, [cart, store]);
  useEffect(() => { if (flash) { const t = setTimeout(() => setFlash(null), 2500); return () => clearTimeout(t); } }, [flash]);

  const cat = catalogue!; const loc = cat.location; const date = loc ? localDate(loc.timezone) : new Date().toISOString().slice(0, 10);
  const rule = useCallback((vid: string) => cat.taxRuleFor(vid, date), [cat, date]);
  const promoFor = useCallback((ls: Parameters<typeof cat.promotionsFor>[0]) => cat.promotionsFor(ls, date), [cat, date]);
  const priced = useMemo(() => priceOf(cart, rule, null, promoFor), [cart, rule, promoFor]);
  const pricedCash = useMemo(() => priceOf(cart, rule, CASH_STEP, promoFor), [cart, rule, promoFor]);
  const lines = cart.lines.map((line, i) => ({ line, v: cat.variants.get(line.variantId), total: priced.result.lines[i]!.totalMinor, promo: priced.promos[i]!.discountMinor }));
  const customer = cart.customerId ? (cat.customers.find((c) => c.id === cart.customerId) ?? null) : null;
  const results = useMemo(() => cat.search(query), [cat, query]);
  const pay = usePayment(priced.result.totalMinor, pricedCash.result.payableMinor);

  const add = (v: VariantView) => { setCart((c) => addVariant(c, v, 1, cat.priceFor(v.id, date))); setQuery(""); setPane((p) => (p.kind === "receipt" ? { kind: "cart" } : p)); input.current?.focus(); };
  // a barcode scanner paired as a keyboard: a fast burst ending in Enter adds the item wherever the focus happens to be (not while typing in another field)
  const wedge = useRef(new ScanBuffer());
  const addRef = useRef(add); addRef.current = add; const catRef = useRef(cat); catRef.current = cat;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const r = wedge.current.push(e.key, e.timeStamp); if (!r.scan) return;
      const el = e.target as HTMLElement | null; const typing = !!el && (el.tagName === "TEXTAREA" || el.isContentEditable || (el.tagName === "INPUT" && el !== input.current));
      if (typing || el === input.current) return;                          // the search box and other fields deal with their own Enter
      e.preventDefault(); const v = catRef.current.byCode(r.scan); if (v) addRef.current(v); else setFlash(`Nothing found for “${r.scan}”`);
    };
    window.addEventListener("keydown", onKey, true); return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  const scan = () => {
    const q = query.trim(); if (!q) return;
    const exact = cat.byCode(q); if (exact) return add(exact);
    if (results.length === 1) return add(results[0]!);
    if (results.length === 0) setFlash(`Nothing found for “${q}”`);
  };

  /** Open the drawer for a cash sale. Best effort: the sale is already safe on the till, so a printer that cannot be reached must never get in the way. */
  const kick = (reason: "cash_sale" | "no_sale") => { if (device && auth && navigator.onLine) void requestPrint(device.apiUrl, auth.token, { kind: "drawer", reason }).catch(() => undefined); };
  const finish = async (payments: Parameters<typeof completeSale>[1]["payments"]) => {
    if (!auth || !session || !cat.register) return;
    const cashOnly = payments.every((p) => p.tender === "cash");
    const use = cashOnly ? pricedCash : priced;
    const sale = await completeSale(store, { cart, priced: use, pricingVersion: cat.pricingVersion, payments, cashRoundingStep: cashOnly ? CASH_STEP : null, session, cashier: { id: auth.userId, name: auth.name }, register: { id: cat.register.id, code: cat.register.code }, customer: customer ? { id: customer.id, name: customer.name } : null, variants: cat.variants });
    setCart(emptyCart()); pay.reset(); setPane({ kind: "receipt", sale }); if (payments.some((p) => p.tender === "cash")) kick("cash_sale"); await reloadCatalogue(); void syncNow();
  };
  /** Puts an online order's goods in the cart, tied to the order so the sale collects it. Only into an empty cart, so two customers never end up in one sale. */
  const loadPickup = (o: import("../lib/api").PickupOrder): { ok: boolean; why?: string } => {
    if (cart.lines.length) return { ok: false, why: "Finish or park the current sale first." };
    let c: Cart = { ...emptyCart(), onlineOrderId: o.id };
    for (const l of o.lines) { const v = cat.variants.get(l.variantId); if (!v) return { ok: false, why: `${l.title} is not in this till's catalogue yet. Sync, then try again.` }; c = addVariant(c, v, l.qty, cat.priceFor(v.id, date)); }
    setCart(c); setPane({ kind: "cart" }); setFlash(`Order ${o.number} loaded for ${o.customer}`); return { ok: true };
  };
  const refreshParked = async () => setParked((await store.list<Parked>("parked")).map((x) => x.value));
  const park = async () => { if (!cart.lines.length) return; const p: Parked = { id: uuidv7(), at: new Date().toISOString(), cart }; await store.transact((tx) => tx.put("parked", p.id, p)); await refreshParked(); setCart(emptyCart()); setFlash("Sale parked"); };
  const recall = async (id: string) => {
    const p = parked.find((x) => x.id === id); if (!p) return;
    await store.transact(async (tx) => { if (cart.lines.length) { const cur: Parked = { id: uuidv7(), at: new Date().toISOString(), cart }; await tx.put("parked", cur.id, cur); } await tx.del("parked", id); });   // a sale in progress is parked, not lost
    setCart(p.cart); await refreshParked(); setPane({ kind: "cart" });
  };
  const unpark = async (id: string) => { await store.transact((tx) => tx.del("parked", id)); setParked((x) => x.filter((p) => p.id !== id)); };

  const limit = loc?.cashierDiscountLimitBp ?? 1000; const canApprove = !!auth?.canApprove;
  const recent = useMemo(() => [] as VariantView[], []);
  void recent;

  const paneEl = (() => {
    switch (pane.kind) {
      case "pickup": return <PickupPane onClose={() => setPane({ kind: "cart" })} onLoad={loadPickup} />;
      case "pay": return <PaySummary pay={pay} onBack={() => setPane({ kind: "cart" })} onComplete={finish} />;
      case "customer": return <CustomerPane catalogue={cat} onClose={() => setPane({ kind: "cart" })} onPick={(c: CustomerView | null) => { setCart((x) => setCustomer(x, c?.id ?? null)); setPane({ kind: "cart" }); }} />;
      case "parked": return <ParkedPane items={parked.map((p) => ({ id: p.id, at: p.at, lines: p.cart.lines.reduce((a, l) => a + l.qty, 0), total: priceOf(p.cart, rule, null, promoFor).result.totalMinor }))} onRecall={recall} onDelete={unpark} onClose={() => setPane({ kind: "cart" })} />;
      case "approve": return <ApprovalPane onCancel={() => setPane({ kind: "cart" })} onApproved={(token, name) => { setCart((c) => approveLine(setDiscount(c, pane.key, pane.bp, pane.reason), pane.key, token, name)); setPane({ kind: "cart" }); }} />;
      case "receipt": return <ReceiptPane sale={pane.sale} queued={sync.queued > 0} onPrint={() => (device && auth ? requestPrint(device.apiUrl, auth.token, { kind: "receipt", saleId: pane.sale.id }) : Promise.reject(new Error("not paired")))} onNew={() => { setPane({ kind: "cart" }); input.current?.focus(); }} />;
      default: return <CartPane cart={cart} catalogue={cat} lines={lines} totals={{ subtotal: priced.result.subtotalMinor, discount: priced.result.discountMinor, tax: priced.result.taxMinor, total: priced.result.totalMinor }} customer={customer} parkedCount={parked.length} limitBp={limit} canApprove={canApprove}
        onQty={(k, n) => setCart((c) => setQty(c, k, n))} onRemove={(k) => setCart((c) => removeLine(c, k))} onDiscount={(k, bp, r) => setCart((c) => setDiscount(c, k, bp, r))} onNeedApproval={(key, bp, reason) => setPane({ kind: "approve", key, bp, reason })}
        onCustomer={() => setPane({ kind: "customer" })} onPark={park} onParked={() => setPane({ kind: "parked" })} onPay={() => { pay.reset(); setPane({ kind: "pay" }); }} onClear={() => setCart(emptyCart())} />;
    }
  })();

  return (
    <div className="pos">
      <nav className="pos-bar" aria-label="POS">
        <span className="mk"><Store size={24} /></span>
        <a href="#sell" aria-current={view === "sell" ? "page" : undefined} onClick={(e) => { e.preventDefault(); setView("sell"); }}><ScanBarcode />Sell</a>
        <a href="#orders" aria-current={view === "orders" ? "page" : undefined} onClick={(e) => { e.preventDefault(); setView("orders"); }}><Receipt />Orders</a>
        <a href="#cash" aria-current={view === "cash" ? "page" : undefined} onClick={(e) => { e.preventDefault(); setView("cash"); }}><Banknote />Cash</a>
        <a href="#stock" aria-current={view === "stock" ? "page" : undefined} onClick={(e) => { e.preventDefault(); setView("stock"); }}><Boxes />Stock</a>
        <a href="#shift" aria-current={view === "shift" || view === "close" ? "page" : undefined} onClick={(e) => { e.preventDefault(); setView("shift"); }}><Clock />Shift</a>
        <span className="sp" />
        <a href="#sync" aria-current={view === "sync" ? "page" : undefined} onClick={(e) => { e.preventDefault(); setView("sync"); }}><RefreshCw />Sync{sync.queued > 0 && <span className="bdg" data-testid="queue-badge">{sync.queued}</span>}</a>
        <a href="#lock" onClick={(e) => { e.preventDefault(); signOut(); }}><Lock />Lock</a>
      </nav>
      <header className="pos-head">
        <div className="ctx"><div><small>Location</small><b>{loc?.name}</b></div><div><small>Register</small><b>{cat.register?.code}</b></div><div><small>Cashier</small><b>{auth?.name}</b></div><div><small>Session</small><b className="mono">since {session ? clockTime(new Date(session.openedAt)) : "—"}</b></div></div>
        <span className={`sync ${sync.state === "offline" ? "" : "ok"}`} role="status" data-testid="sync-pill">{sync.state === "offline" ? <WifiOff size={18} /> : <RefreshCw size={18} />}{sync.state === "offline" ? `Offline${sync.queued ? ` · ${sync.queued} saved` : ""}` : sync.state === "syncing" ? "Syncing…" : sync.queued ? `Online · ${sync.queued} sending` : "Online"}</span>
      </header>
      {view === "sync" ? <SyncScreen /> : view === "stock" ? <StockScreen /> : view === "orders" ? <OrdersScreen /> : view === "cash" ? <CashScreen /> : view === "shift" ? <ShiftScreen onClose={() => setView("close")} /> : view === "close" ? <CloseScreen onCancel={() => setView("shift")} /> : <>
        {pane.kind === "pay" ? <PayEntry pay={pay} customerId={customer?.id ?? null} /> : <section className="pos-main" aria-label="Products">
          {sync.state === "offline" && <div className="offline-banner" role="status"><WifiOff size={18} /><div><b>You can keep selling.</b> Sales are saved on this iPad and send on their own when it reconnects. Stock shown is as of the last sync{sync.lastSyncAt ? ` (${clockTime(new Date(sync.lastSyncAt))})` : ""}.</div></div>}
          <form className="scan" onSubmit={(e) => { e.preventDefault(); scan(); }}>
            <label className="input" style={{ flex: 1 }}><Search size={18} /><input ref={input} autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Scan a barcode or search products" aria-label="Scan barcode or search products" autoComplete="off" autoCapitalize="none" /></label>
            <Button type="submit" size="lg"><ScanBarcode size={20} />Add</Button>
            <Button type="button" size="lg" onClick={() => setPane({ kind: "pickup" })} aria-label="Online pickup"><Store size={20} />Pickup</Button>
          </form>
          <div className="results" role="list" aria-label="Search results">
            {query.trim() === "" ? <p className="muted" style={{ padding: 20, margin: 0 }}>Scan a barcode, or type a product, size or colour.</p> : <>
              <div className="rh"><span>{results.length} match{results.length === 1 ? "" : "es"} for “{query.trim()}” · {loc?.name} stock</span></div>
              {results.length === 0 && <p className="muted" style={{ padding: 20, margin: 0 }}>Nothing matches. Check the spelling or scan the barcode.</p>}
              {results.map((v) => (
                <button key={v.id} role="listitem" className="row" data-testid="result" onClick={() => add(v)}>
                  <span><span className="t">{v.title}</span><br /><span className="v">{v.optionsLabel}{v.brand ? ` · ${v.brand}` : ""}</span></span>
                  <span className={`stk${v.onHand !== null && v.onHand <= 2 ? " low" : ""}`}>{v.onHand === null ? <b>—</b> : <b>{v.onHand}</b>}in stock</span>
                  <span className="pr">{fmt(v.basePriceMinor)}</span>
                </button>))}
            </>}
          </div>
          {flash && <Callout tone="info">{flash}</Callout>}
        </section>}
        {paneEl}
      </>}
    </div>
  );
}
void lineDiscountMinor;
