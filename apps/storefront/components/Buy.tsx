"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { money, optionsLabel, type ProductPage } from "@/lib/shop";
import { useShop } from "./Cart";
import { Stepper, Tiles } from "./ui";

/** Choose a size or colour, see which stores have it, add it to the basket. Out of stock sizes are shown, not hidden. */
export function Buy({ product }: { product: ProductPage }) {
  const { add } = useShop(); const [variantId, setVariantId] = useState<string | null>(product.variants.find((v) => v.availability.some((a) => a.available > 0))?.id ?? product.variants[0]?.id ?? null); const [qty, setQty] = useState(1); const [added, setAdded] = useState(false);
  const v = product.variants.find((x) => x.id === variantId) ?? null; const total = useMemo(() => v?.availability.reduce((a, s) => a + s.available, 0) ?? 0, [v]);
  return (
    <div className="stack">
      {v && <div className="price big-price" data-testid="pdp-price">{money(v.priceMinor)}</div>}
      <div><div className="lbl" id="vlabel">Choose an option</div>
        <Tiles label="Option" value={variantId} onChange={(x) => { setVariantId(x); setAdded(false); setQty(1); }} options={product.variants.map((x) => ({ value: x.id, label: optionsLabel(x.options) || x.sku, sub: x.availability.reduce((a, s) => a + s.available, 0) > 0 ? money(x.priceMinor) : "Out of stock", disabled: false }))} columns={Math.min(4, Math.max(2, product.variants.length))} /></div>
      {v && <div><div className="lbl">Where you can collect it</div>
        {product.stores.length === 0 ? <p className="muted">No store is taking online pickups yet.</p> : <ul className="stores" data-testid="availability">{v.availability.map((a) => <li key={a.locationId}><span>{a.store}</span><span className={a.available > 0 ? "in" : "none"}>{a.available > 9 ? "In stock" : a.available > 0 ? `${a.available} left` : "Out of stock"}</span></li>)}</ul>}</div>}
      <div className="row"><Stepper label="Quantity" value={qty} max={Math.max(1, Math.min(20, total))} onChange={setQty} />
        <button type="button" className="btn primary" disabled={!v || total === 0} onClick={() => { if (!v) return; add({ variantId: v.id, productId: product.id, title: product.title, options: optionsLabel(v.options), priceMinor: v.priceMinor }, qty); setAdded(true); }}>{total === 0 ? "Out of stock" : "Add to basket"}</button></div>
      {added && <p role="status" className="ok" data-testid="added">Added. <Link href="/cart">View basket</Link></p>}
    </div>
  );
}
