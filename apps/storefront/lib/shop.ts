/** Talking to the Shelfline API from the server (to render) and from the browser (to order). The address and the shop come from the environment at run time, never baked in at build time. */
export interface ShopConfig { apiUrl: string; orgId: string }
const serverApi = () => process.env.SHELFLINE_API_URL ?? "http://localhost:8200";
const publicApi = () => process.env.PUBLIC_API_URL ?? serverApi();

export async function shopConfig(): Promise<ShopConfig> {
  let orgId = process.env.SHELFLINE_ORG_ID;
  if (!orgId) { const r = await fetch(`${serverApi()}/shop-default`, { cache: "no-store" }); if (!r.ok) throw new Error("No shop is configured: set SHELFLINE_ORG_ID, or run with a single organisation."); orgId = ((await r.json()) as { orgId: string }).orgId; }
  return { apiUrl: publicApi(), orgId };
}
async function get<T>(path: string): Promise<T | null> {
  const { orgId } = await shopConfig(); const r = await fetch(`${serverApi()}/shop/${orgId}${path}`, { cache: "no-store" }); if (r.status === 404) return null; if (!r.ok) throw new Error(`Shop API ${r.status}`); return (await r.json()) as T;
}
export interface Store { id: string; name: string; timezone: string }
export interface Front { name: string; currency: string; stores: Store[]; categories: { id: string; name: string }[] }
export interface Card { id: string; title: string; brand: string | null; categoryId: string | null; fromPriceMinor: number; toPriceMinor: number; variants: number; available: number; inStock: boolean }
export interface Variant { id: string; sku: string; options: Record<string, string>; priceMinor: number; availability: { locationId: string; store: string; available: number }[] }
export interface ProductPage { id: string; title: string; brand: string | null; stores: Store[]; variants: Variant[] }
export interface OrderView { id: string; number: string; status: "placed" | "ready" | "collected" | "cancelled" | "expired"; store: string; name: string; totalMinor: number; taxMinor: number; currency: string; placedAt: string; expiresAt: string; readyAt: string | null; lines: { title: string; options: string; qty: number; totalMinor: number }[] }
export const front = () => get<Front>("");
export const catalog = (q: string, categoryId: string) => get<{ products: Card[] }>(`/products?${new URLSearchParams({ ...(q ? { q } : {}), ...(categoryId ? { categoryId } : {}) })}`);
export const productPage = (id: string) => get<ProductPage>(`/products/${id}`);
export const orderView = (id: string, token: string) => get<OrderView>(`/orders/${id}?t=${encodeURIComponent(token)}`);
export const money = (minor: number, currency = "AUD") => new Intl.NumberFormat("en-AU", { style: "currency", currency }).format(minor / 100);
export const optionsLabel = (o: Record<string, string>) => Object.values(o).join(" · ");
