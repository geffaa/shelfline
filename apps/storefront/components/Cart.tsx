"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ShopConfig } from "@/lib/shop";

export interface CartLine { variantId: string; productId: string; title: string; options: string; priceMinor: number; qty: number }
interface Ctx extends ShopConfig { lines: CartLine[]; count: number; totalMinor: number; add(l: Omit<CartLine, "qty">, qty: number): void; setQty(variantId: string, qty: number): void; clear(): void; ready: boolean }
const C = createContext<Ctx | null>(null); const KEY = "shelfline-shop-cart";
export const useShop = () => { const c = useContext(C); if (!c) throw new Error("ShopProvider missing"); return c; };

/** The basket lives in this browser only. Nothing is reserved until the customer places the order. */
export function ShopProvider({ config, children }: { config: ShopConfig; children: ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>([]); const [ready, setReady] = useState(false);
  useEffect(() => { try { const raw = localStorage.getItem(KEY); if (raw) setLines(JSON.parse(raw) as CartLine[]); } catch { /* a blocked or empty store is an empty basket */ } setReady(true); }, []);
  useEffect(() => { if (ready) try { localStorage.setItem(KEY, JSON.stringify(lines)); } catch { /* ignore */ } }, [lines, ready]);
  const add = useCallback((l: Omit<CartLine, "qty">, qty: number) => setLines((cur) => { const i = cur.findIndex((x) => x.variantId === l.variantId); return i >= 0 ? cur.map((x, j) => (j === i ? { ...x, qty: Math.min(20, x.qty + qty) } : x)) : [...cur, { ...l, qty: Math.min(20, qty) }]; }), []);
  const setQty = useCallback((variantId: string, qty: number) => setLines((cur) => (qty <= 0 ? cur.filter((x) => x.variantId !== variantId) : cur.map((x) => (x.variantId === variantId ? { ...x, qty: Math.min(20, qty) } : x)))), []);
  const clear = useCallback(() => setLines([]), []);
  const value = useMemo<Ctx>(() => ({ ...config, lines, count: lines.reduce((a, l) => a + l.qty, 0), totalMinor: lines.reduce((a, l) => a + l.qty * l.priceMinor, 0), add, setQty, clear, ready }), [config, lines, add, setQty, clear, ready]);
  return <C.Provider value={value}>{children}</C.Provider>;
}
