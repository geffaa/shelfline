import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { Chip } from "@shelfline/ui";
import { api, qs } from "../lib/api";

export const PO_STATUS: Record<string, { label: string; tone?: "ok" | "warn" | "danger" | "info" }> = {
  draft: { label: "Draft" }, sent: { label: "Sent", tone: "info" }, partial: { label: "Part received", tone: "warn" }, received: { label: "Received", tone: "ok" }, closed: { label: "Closed" }, cancelled: { label: "Cancelled", tone: "danger" },
};
export const poChip = (s: string) => <Chip tone={PO_STATUS[s]?.tone}>{PO_STATUS[s]?.label ?? s}</Chip>;
export const BILL_STATUS: Record<string, { label: string; tone?: "ok" | "warn" | "danger" | "info" }> = {
  held: { label: "On hold", tone: "warn" }, open: { label: "Open", tone: "info" }, partially_paid: { label: "Part paid", tone: "info" }, paid: { label: "Paid", tone: "ok" }, void: { label: "Void", tone: "danger" },
};
export const billChip = (s: string) => <Chip tone={BILL_STATUS[s]?.tone}>{BILL_STATUS[s]?.label ?? s}</Chip>;
export const HOLD_TEXT: Record<string, string> = { over_billed: "billed for more than has arrived", price_variance: "price differs from the order" };
export const METHODS = [{ value: "bank_transfer", label: "Bank transfer" }, { value: "card", label: "Card" }, { value: "cash", label: "Cash" }, { value: "other", label: "Other" }];
export const optText = (o: Record<string, string> | null | undefined) => Object.values(o ?? {}).join(" · ");

export interface VariantHit { id: string; sku: string; title: string; brand: string | null; options: Record<string, string>; basePriceMinor: number }
/** Type-ahead over stocked variants. Results are a list of buttons under the field; Escape closes it. */
export function VariantPicker({ onPick, label = "Add a product" }: { onPick: (v: VariantHit) => void; label?: string }) {
  const [q, setQ] = useState(""); const [open, setOpen] = useState(false); const root = useRef<HTMLDivElement>(null);
  const hits = useQuery({ queryKey: ["variant-search", q], enabled: q.trim().length >= 2, queryFn: () => api<VariantHit[]>(`/variants/search${qs({ q: q.trim(), limit: 12 })}`) });
  useEffect(() => { const off = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); }; document.addEventListener("pointerdown", off); return () => document.removeEventListener("pointerdown", off); }, []);
  return (
    <div ref={root} style={{ position: "relative" }}>
      <label className="input"><Search size={16} /><input aria-label={label} placeholder="Title, SKU or barcode" value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }} /></label>
      {open && q.trim().length >= 2 && (
        <div className="menu" role="listbox" aria-label="Matching products" style={{ position: "absolute", zIndex: 20, left: 0, right: 0, top: "calc(100% + 4px)", maxHeight: 280, overflow: "auto" }}>
          {hits.isLoading ? <div className="pb muted">Searching…</div> : (hits.data ?? []).length === 0 ? <div className="pb muted">Nothing matches “{q.trim()}”.</div> : hits.data!.map((v) => (
            <button type="button" role="option" aria-selected={false} key={v.id} className="menu-item" onClick={() => { onPick(v); setQ(""); setOpen(false); }}><b>{v.title}</b> <span className="muted">{optText(v.options)} · {v.sku}</span></button>
          ))}
        </div>
      )}
    </div>
  );
}

export const TR_STATUS: Record<string, { label: string; tone?: "ok" | "warn" | "danger" | "info" }> = { draft: { label: "Draft" }, sent: { label: "In transit", tone: "info" }, partial: { label: "Part received", tone: "warn" }, received: { label: "Received", tone: "ok" }, cancelled: { label: "Cancelled", tone: "danger" } };
export const trChip = (s: string) => <Chip tone={TR_STATUS[s]?.tone}>{TR_STATUS[s]?.label ?? s}</Chip>;
export const COUNT_STATUS: Record<string, { label: string; tone?: "ok" | "warn" | "danger" | "info" }> = { counting: { label: "Counting", tone: "info" }, review: { label: "In review", tone: "warn" }, committed: { label: "Committed", tone: "ok" }, cancelled: { label: "Cancelled", tone: "danger" } };
export const countChip = (s: string) => <Chip tone={COUNT_STATUS[s]?.tone}>{COUNT_STATUS[s]?.label ?? s}</Chip>;
