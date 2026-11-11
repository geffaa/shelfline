"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { money, type Store } from "@/lib/shop";
import { useShop } from "./Cart";
import { Stepper, Tiles } from "./ui";

/** The basket, the store to collect from, and who is collecting. Placing the order is what reserves the stock, all of it or none of it. */
export function Checkout({ stores, currency }: { stores: Store[]; currency: string }) {
  const { lines, totalMinor, setQty, clear, apiUrl, orgId, ready } = useShop(); const router = useRouter();
  const [store, setStore] = useState<string | null>(stores.length === 1 ? stores[0]!.id : null); const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [phone, setPhone] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const valid = lines.length > 0 && !!store && name.trim().length > 0 && /.+@.+\..+/.test(email);
  const place = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`${apiUrl}/shop/${orgId}/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: email.trim(), name: name.trim(), phone: phone.trim() || null, locationId: store, lines: lines.map((l) => ({ variantId: l.variantId, qty: l.qty })) }) });
      const b = await r.json().catch(() => ({})) as { id?: string; accessToken?: string; pickupCode?: string; code?: string; available?: number; variantId?: string };
      if (r.status === 201 && b.id) { try { sessionStorage.setItem(`shelfline-code:${b.id}`, b.pickupCode ?? ""); } catch { /* the email has it too */ } clear(); router.push(`/order/${b.id}?t=${b.accessToken}`); return; }
      if (b.code === "insufficient_stock") { const l = lines.find((x) => x.variantId === b.variantId); setErr(`Sorry, ${l ? `${l.title}${l.options ? ` (${l.options})` : ""}` : "an item"} ${b.available ? `has only ${b.available} left at this store` : "has just sold out at this store"}. Nothing has been reserved. ${b.available ? "Change the quantity" : "Remove it or choose another store"} and try again.`); if (l && b.available) setQty(l.variantId, b.available); }
      else if (r.status === 429) setErr("That is a lot of orders. Please wait a little and try again.");
      else if (b.code === "store_not_available_for_pickup") setErr("That store is not taking online pickups right now. Choose another.");
      else setErr("We could not place the order. Check your details and try again.");
    } catch { setErr("We could not reach the shop. Check your connection and try again."); } finally { setBusy(false); }
  };
  if (!ready) return <p className="muted">Loading your basket…</p>;
  if (lines.length === 0) return <div className="empty"><h1>Your basket is empty</h1><p>Find something and add it here.</p><Link href="/" className="btn primary">Browse products</Link></div>;
  return (
    <div className="checkout">
      <section aria-labelledby="bk"><h1 id="bk">Your basket</h1>
        <ul className="lines" data-testid="basket">{lines.map((l) => <li key={l.variantId}><div><b>{l.title}</b><span className="muted">{l.options}</span></div><Stepper label={`${l.title} quantity`} value={l.qty} min={0} onChange={(n) => setQty(l.variantId, n)} /><span className="price">{money(l.qty * l.priceMinor, currency)}</span></li>)}</ul>
        <div className="total"><span>Total, GST included</span><b data-testid="basket-total">{money(totalMinor, currency)}</b></div></section>
      <form onSubmit={(e) => { e.preventDefault(); void place(); }} aria-label="Reserve">
        <h2>Collect from</h2>{stores.length === 0 ? <p className="err">No store is taking online pickups yet.</p> : <Tiles label="Store" value={store} onChange={setStore} options={stores.map((s) => ({ value: s.id, label: s.name }))} columns={Math.min(3, stores.length)} />}
        <h2>Who is collecting</h2>
        <div className="field"><label htmlFor="n">Name</label><input id="n" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></div>
        <div className="field"><label htmlFor="e">Email</label><input id="e" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /><span className="hint">We email your pickup code here.</span></div>
        <div className="field"><label htmlFor="p">Phone (optional)</label><input id="p" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" inputMode="tel" /></div>
        {err && <p role="alert" className="err" data-testid="checkout-error">{err}</p>}
        <button type="submit" className="btn primary wide" disabled={!valid || busy}>{busy ? "Reserving…" : "Reserve and pay in store"}</button>
        <p className="muted small">Nothing is charged online. You pay when you collect.</p>
      </form>
    </div>
  );
}
