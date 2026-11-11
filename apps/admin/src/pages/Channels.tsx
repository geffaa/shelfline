import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { Button, Callout, Chip, Select } from "@shelfline/ui";
import { API_URL, api, ApiError } from "../lib/api";
import { ago, dateTime, plain } from "../lib/format";
import { useAuth } from "../state/auth";
import { useLens, useLensLock } from "../state/lens";
import { Empty, ErrorBox, Field, PageHeader, Panel, Skeleton, TextInput } from "../ui";

interface Chan { id: string; name: string; shopDomain: string; status: "active" | "paused" | "disconnected"; hasToken: boolean; webhookPath: string; location: string; shopifyLocationId: string; lastPushAt: string | null; lastError: string | null; listings: number; orders: number; unmappedLines: number; apiVersion: string }
interface Listing { id: string; sku: string; lastPushedQty: number | null; lastPushedAt: string | null }
interface ChOrder { id: string; name: string; status: string; totalMinor: number; customerEmail: string | null; unmapped: number; importedAt: string }
const ERR: Record<string, string> = { shopify_token_refused: "Shopify refused that access token.", shopify_unreachable: "Could not reach that shop.", shop_already_connected: "That shop is already connected.", bad_shop_domain: "Use the shop's address ending in .myshopify.com." };

function Connect({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient(); const { locations } = useLens(); const stores = locations.filter((l) => l.type === "store" || l.type === "warehouse");
  const [name, setName] = useState(""); const [domain, setDomain] = useState(""); const [token, setToken] = useState(""); const [secret, setSecret] = useState(""); const [loc, setLoc] = useState<string | null>(stores[0]?.id ?? null); const [sl, setSl] = useState(""); const [err, setErr] = useState<string | null>(null);
  const save = useMutation({ mutationFn: () => api("/channels", { method: "POST", body: { name: name.trim(), shopDomain: domain.trim(), accessToken: token.trim(), webhookSecret: secret.trim(), locationId: loc, shopifyLocationId: sl.trim() } }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["channels"] }); onDone(); },
    onError: (e) => setErr(e instanceof ApiError ? ERR[e.code] ?? "Check the address, the numbers and the secrets." : "Could not connect.") });
  return (
    <Panel title="Connect a Shopify shop"><form className="stack" aria-label="Connect Shopify" onSubmit={(e) => { e.preventDefault(); setErr(null); save.mutate(); }}>
      <p className="muted" style={{ margin: 0 }}>Shelfline stays the master of stock: it sends this store's quantities to Shopify and takes Shopify's orders off them. Create a custom app in Shopify with permission to read products and read and write inventory, then paste its details here.</p>
      <div className="grid2"><Field id="ch-name" label="Name"><TextInput id="ch-name" value={name} onChange={setName} placeholder="Kestrel online" /></Field><Field id="ch-domain" label="Shop address"><TextInput id="ch-domain" value={domain} onChange={setDomain} placeholder="kestrel.myshopify.com" /></Field>
        <Field id="ch-token" label="Admin API access token"><TextInput id="ch-token" type="password" autoComplete="off" value={token} onChange={setToken} /></Field><Field id="ch-secret" label="Webhook signing secret" hint="Shopify signs every notice with this, so Shelfline can tell it is genuine"><TextInput id="ch-secret" type="password" autoComplete="off" value={secret} onChange={setSecret} /></Field>
        <Select label="Shelfline location whose stock is sold online" value={loc} onChange={setLoc} options={stores.map((l) => ({ value: l.id, label: l.name }))} chevron={<ChevronDown size={16} />} /><Field id="ch-loc" label="Shopify location id" hint="The number in the location's address in Shopify"><TextInput id="ch-loc" value={sl} onChange={setSl} inputMode="numeric" /></Field></div>
      {err && <p className="err" role="alert">{err}</p>}<div className="row-flex"><Button type="button" onClick={onDone}>Cancel</Button><span className="grow" /><Button variant="primary" type="submit" disabled={!domain.trim() || token.trim().length < 8 || secret.trim().length < 8 || !loc || !sl.trim() || save.isPending}>Connect shop</Button></div></form></Panel>
  );
}

function Detail({ c }: { c: Chan }) {
  const qc = useQueryClient(); const [msg, setMsg] = useState<string | null>(null); const [unmatched, setUnmatched] = useState<{ sku: string; title: string }[]>([]);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["channels"] }); void qc.invalidateQueries({ queryKey: ["channel-listings", c.id] }); void qc.invalidateQueries({ queryKey: ["channel-orders", c.id] }); };
  const imp = useMutation({ mutationFn: () => api<{ shopifyVariants: number; added: number; unmatched: { sku: string; title: string }[] }>(`/channels/${c.id}/import`, { method: "POST" }), onSuccess: (r) => { setUnmatched(r.unmatched); setMsg(`Matched ${r.added} new product option${r.added === 1 ? "" : "s"} by SKU; ${r.unmatched.length} in Shopify had no match.`); refresh(); } });
  const push = useMutation({ mutationFn: () => api<{ pushed: number; skipped: number; failed: number }>(`/channels/${c.id}/push`, { method: "POST" }), onSuccess: (r) => { setMsg(`Sent ${r.pushed} quantit${r.pushed === 1 ? "y" : "ies"} to Shopify (${r.skipped} unchanged${r.failed ? `, ${r.failed} failed` : ""}).`); refresh(); } });
  const rec = useMutation({ mutationFn: () => api<{ checked: number; fixed: number }>(`/channels/${c.id}/reconcile`, { method: "POST" }), onSuccess: (r) => { setMsg(r.fixed ? `Checked ${r.checked}: ${r.fixed} had drifted in Shopify and were corrected.` : `Checked ${r.checked}: Shopify already matches Shelfline.`); refresh(); } });
  const status = useMutation({ mutationFn: (s: "active" | "paused" | "disconnected") => api(`/channels/${c.id}`, { method: "PATCH", body: { status: s } }), onSuccess: refresh });
  const hook = `${API_URL}${c.webhookPath}`;
  return (
    <Panel title={<>{c.name} <span className="muted" style={{ fontWeight: 400 }}>· {c.shopDomain}</span></>} right={<Chip tone={c.status === "active" ? "ok" : c.status === "paused" ? "warn" : "danger"}>{c.status === "active" ? "Connected" : c.status === "paused" ? "Paused" : "Disconnected"}</Chip>}>
      <div className="stack">
        <div className="lead"><span>Sells the stock of</span><i /><b>{c.location}</b></div><div className="lead"><span>Last sent to Shopify</span><i /><b>{c.lastPushAt ? ago(c.lastPushAt) : "never"}</b></div><div className="lead"><span>Options matched · orders taken</span><i /><b>{c.listings} · {c.orders}</b></div>
        {c.lastError && <Callout tone="warn"><span>The last send had a problem: {c.lastError}</span></Callout>}{c.unmappedLines > 0 && <Callout tone="warn"><span><b>{c.unmappedLines} order line{c.unmappedLines === 1 ? "" : "s"} could not be matched</b> to a Shelfline product, so no stock was taken for them. Match the SKU in Shopify and Shelfline.</span></Callout>}
        {c.hasToken && <div><span className="lbl">Register this address in Shopify for orders/create, orders/paid and orders/cancelled</span><br /><code className="mono" data-testid="webhook-url" style={{ wordBreak: "break-all" }}>{hook}</code></div>}
        {msg && <Callout tone="info"><span role="status">{msg}</span></Callout>}
        {c.status !== "disconnected" && <div className="row-flex"><Button onClick={() => imp.mutate()} disabled={imp.isPending}>Match products by SKU</Button><Button onClick={() => push.mutate()} disabled={push.isPending || c.status !== "active"}>Send stock now</Button><Button onClick={() => rec.mutate()} disabled={rec.isPending}>Check Shopify against Shelfline</Button><span className="grow" />
          <Button variant="ghost" onClick={() => status.mutate(c.status === "active" ? "paused" : "active")}>{c.status === "active" ? "Pause" : "Resume"}</Button><Button variant="ghost" onClick={() => { if (window.confirm("Disconnect this shop? The secrets are deleted and Shopify's notices are refused.")) status.mutate("disconnected"); }}>Disconnect</Button></div>}
        {unmatched.length > 0 && <details open><summary>{unmatched.length} Shopify option{unmatched.length === 1 ? "" : "s"} with no match</summary><ul className="plain" data-testid="unmatched" style={{ margin: "8px 0 0", paddingLeft: 18 }}>{unmatched.map((u, i) => <li key={i}><b>{u.sku || "no SKU"}</b> <span className="muted">{u.title}</span></li>)}</ul></details>}
      </div>
    </Panel>
  );
}

export function Channels() {
  useLensLock(true);
  const { can } = useAuth(); const manage = can("channel:manage", null); const [add, setAdd] = useState(false);
  const list = useQuery({ queryKey: ["channels"], enabled: manage, refetchOnMount: "always", queryFn: () => api<Chan[]>("/channels") });
  if (!manage) return (<><PageHeader title="Sales channels" /><Empty title="Not available">Only owners and HQ managers connect sales channels.</Empty></>);
  return (<>
    <PageHeader title="Sales channels" sub="Sell the same stock on Shopify. Shelfline keeps the count." actions={<Button variant="primary" onClick={() => setAdd(true)}>Connect Shopify</Button>} />
    {add && <Connect onDone={() => setAdd(false)} />}
    {list.isLoading ? <Skeleton rows={3} /> : list.isError ? <ErrorBox error={list.error} retry={() => list.refetch()} /> : list.data!.length === 0 ? <Empty title="No channels yet">Connect a Shopify shop to share this stock with it.</Empty> : list.data!.map((c) => <div key={c.id} data-testid="channel"><Detail c={c} /><ListingsAndOrders c={c} /></div>)}
  </>);
}
function ListingsAndOrders({ c }: { c: Chan }) {
  const listings = useQuery({ queryKey: ["channel-listings", c.id], queryFn: () => api<Listing[]>(`/channels/${c.id}/listings`) }); const orders = useQuery({ queryKey: ["channel-orders", c.id], refetchInterval: 20_000, queryFn: () => api<ChOrder[]>(`/channels/${c.id}/orders`) });
  return (<div className="grid2" style={{ alignItems: "start", marginBottom: 16 }}>
    <Panel title="Matched options" flush>{(listings.data ?? []).length === 0 ? <Empty title="Nothing matched yet">Use “Match products by SKU”.</Empty> : <div className="tbl-wrap"><table className="tbl" data-testid="listings-table"><thead><tr><th>SKU</th><th className="n">Last sent</th><th /></tr></thead><tbody>{listings.data!.slice(0, 50).map((l) => <tr key={l.id}><td className="mono">{l.sku}</td><td className="n">{l.lastPushedQty ?? "—"}</td><td className="n muted">{l.lastPushedAt ? ago(l.lastPushedAt) : ""}</td></tr>)}</tbody></table></div>}</Panel>
    <Panel title="Orders from Shopify" flush>{(orders.data ?? []).length === 0 ? <Empty title="No orders yet">They appear as Shopify sends them.</Empty> : <div className="tbl-wrap"><table className="tbl" data-testid="channel-orders-table"><thead><tr><th>Order</th><th>When</th><th className="n">Total</th><th /></tr></thead><tbody>{orders.data!.slice(0, 30).map((o) => <tr key={o.id}><td><b>{o.name}</b><br /><span className="muted" style={{ fontSize: 12 }}>{o.customerEmail}</span></td><td>{dateTime(o.importedAt)}</td><td className="n">{plain(o.totalMinor)}</td><td>{o.status === "cancelled" ? <Chip tone="danger">Cancelled</Chip> : o.unmapped ? <Chip tone="warn">{o.unmapped} unmatched</Chip> : <Chip tone="ok">Taken off stock</Chip>}</td></tr>)}</tbody></table></div>}</Panel></div>);
}
