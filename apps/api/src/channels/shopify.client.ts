/** The few Shopify Admin REST calls the channel needs. Written from Shopify's public documentation and exercised against a stand-in server; it has not been run against a real shop (V21). */
export interface ShopifyVariant { id: string; sku: string; inventoryItemId: string; title: string }
export interface ShopifyProduct { id: string; title: string; variants: ShopifyVariant[] }
export class ShopifyError extends Error { constructor(public status: number, message: string) { super(message); this.name = "ShopifyError"; } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ShopifyClient {
  constructor(private o: { domain: string; token: string; version: string; base?: string; fetchFn?: typeof fetch; maxRetries?: number; sleepFn?: (ms: number) => Promise<void> }) {}
  private url(path: string) { return `${this.o.base || `https://${this.o.domain}`}/admin/api/${this.o.version}${path}`; }
  private async call<T>(method: "GET" | "POST", path: string, body?: unknown, rawUrl?: string): Promise<{ data: T; link: string | null }> {
    const f = this.o.fetchFn ?? fetch; const retries = this.o.maxRetries ?? 3; const wait = this.o.sleepFn ?? sleep;
    for (let attempt = 0; ; attempt++) {
      const res = await f(rawUrl ?? this.url(path), { method, headers: { "x-shopify-access-token": this.o.token, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
      if (res.status === 429 && attempt < retries) { const s = Number(res.headers.get("retry-after") ?? "1"); await wait(Math.min(10, Number.isFinite(s) && s > 0 ? s : 1) * 1000); continue; }       // Shopify says how long to wait: do
      if (!res.ok) throw new ShopifyError(res.status, `shopify ${res.status}: ${(await res.text().catch(() => "")).slice(0, 120)}`);
      return { data: (await res.json()) as T, link: res.headers.get("link") };
    }
  }
  async shop() { return (await this.call<{ shop: { name: string; myshopify_domain?: string } }>("GET", "/shop.json")).data.shop; }
  /** Every product, following Shopify's page links. */
  async products(): Promise<ShopifyProduct[]> {
    const out: ShopifyProduct[] = []; let next: string | null = null; let first = true;
    for (let page = 0; page < 200 && (first || next); page++) {
      const r: { data: { products: { id: number | string; title: string; variants: { id: number | string; sku: string | null; inventory_item_id: number | string; title: string }[] }[] }; link: string | null } = first ? await this.call("GET", "/products.json?limit=250&fields=id,title,variants") : await this.call("GET", "", undefined, next!);
      first = false; for (const p of r.data.products) out.push({ id: String(p.id), title: p.title, variants: p.variants.map((v) => ({ id: String(v.id), sku: (v.sku ?? "").trim(), inventoryItemId: String(v.inventory_item_id), title: v.title })) });
      const m = r.link ? /<([^>]+)>;\s*rel="next"/.exec(r.link) : null; next = m ? m[1]! : null;
    }
    return out;
  }
  /** Sets the quantity, absolutely. Pushing the number we hold, never "add 2" or "take 1", is what makes a repeated push harmless. */
  async setInventory(locationId: string, inventoryItemId: string, available: number) { await this.call("POST", "/inventory_levels/set.json", { location_id: Number(locationId), inventory_item_id: Number(inventoryItemId), available }); }
  async levels(locationId: string, inventoryItemIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (let i = 0; i < inventoryItemIds.length; i += 50) {
      const ids = inventoryItemIds.slice(i, i + 50); const r = await this.call<{ inventory_levels: { inventory_item_id: number | string; available: number | null }[] }>("GET", `/inventory_levels.json?location_ids=${encodeURIComponent(locationId)}&inventory_item_ids=${ids.join(",")}&limit=250`);
      for (const l of r.data.inventory_levels) out.set(String(l.inventory_item_id), l.available ?? 0);
    }
    return out;
  }
}
