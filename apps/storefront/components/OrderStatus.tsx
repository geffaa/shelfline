"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { money, type OrderView } from "@/lib/shop";
import { useShop } from "./Cart";

const TEXT: Record<OrderView["status"], { title: string; body: (o: OrderView) => string }> = {
  placed: { title: "Reserved", body: (o) => `We are getting it ready at ${o.store}. We will email you when it is ready to collect.` },
  ready: { title: "Ready to collect", body: (o) => `It is waiting for you at ${o.store}. Bring your code and pay at the counter.` },
  collected: { title: "Collected", body: () => "Thanks for shopping with us." },
  cancelled: { title: "Cancelled", body: () => "This order was cancelled and nothing was charged." },
  expired: { title: "Expired", body: () => "It was not collected in time, so it has gone back on the shelf. You can order again." },
};
/** S83: the order, its status (refreshed every 15 seconds), the pickup code (shown here once, and emailed), and a way to cancel. */
export function OrderStatus({ initial, token }: { initial: OrderView; token: string }) {
  const { apiUrl, orgId } = useShop(); const [o, setO] = useState(initial); const [code, setCode] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { try { const c = sessionStorage.getItem(`shelfline-code:${initial.id}`); if (c) setCode(c); } catch { /* ignore */ } }, [initial.id]);
  useEffect(() => { const t = setInterval(async () => { try { const r = await fetch(`${apiUrl}/shop/${orgId}/orders/${initial.id}?t=${encodeURIComponent(token)}`); if (r.ok) setO((await r.json()) as OrderView); } catch { /* try again next time */ } }, 15_000); return () => clearInterval(t); }, [apiUrl, orgId, initial.id, token]);
  const cancel = async () => { setBusy(true); setErr(null); try { const r = await fetch(`${apiUrl}/shop/${orgId}/orders/${initial.id}/cancel?t=${encodeURIComponent(token)}`, { method: "POST" }); if (r.ok) setO({ ...o, status: "cancelled" }); else setErr(r.status === 409 ? "That order has already been collected." : "Could not cancel the order."); } catch { setErr("We could not reach the shop."); } finally { setBusy(false); } };
  const open = o.status === "placed" || o.status === "ready";
  return (
    <article className="order">
      <p className="eyebrow">Order {o.number}</p><h1 data-testid="order-status">{TEXT[o.status].title}</h1><p>{TEXT[o.status].body(o)}</p>
      {open && <div className="code-box"><span className="lbl">Your pickup code</span>{code ? <b className="code" data-testid="pickup-code">{code}</b> : <span className="muted">It was sent to your email.</span>}<span className="small">Held until {new Date(o.expiresAt).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" })}</span></div>}
      <ul className="lines flat" data-testid="order-lines">{o.lines.map((l, i) => <li key={i}><div><b>{l.qty} × {l.title}</b><span className="muted">{l.options}</span></div><span className="price">{money(l.totalMinor, o.currency)}</span></li>)}</ul>
      <div className="total"><span>Total to pay in store, GST {money(o.taxMinor, o.currency)} included</span><b>{money(o.totalMinor, o.currency)}</b></div>
      {err && <p role="alert" className="err">{err}</p>}
      <div className="row">{open && <button type="button" className="btn" onClick={() => void cancel()} disabled={busy}>Cancel this order</button>}<Link href="/" className="btn">Keep shopping</Link></div>
    </article>
  );
}
