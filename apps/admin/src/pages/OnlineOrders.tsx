import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Callout, Chip, Segmented } from "@shelfline/ui";
import { api, ApiError, qs } from "../lib/api";
import { ago, dateTime, money } from "../lib/format";
import { useLens, useLensId } from "../state/lens";
import { Empty, ErrorBox, Field, PageHeader, Panel, Skeleton, TextInput } from "../ui";

interface Order { id: string; number: string; status: "placed" | "ready" | "collected" | "cancelled" | "expired"; store: string; customer: string; email: string; phone: string | null; totalMinor: number; placedAt: string; expiresAt: string; readyAt: string | null; collectedAt: string | null; cancelReason: string | null; saleId: string | null; lines: { lineNo: number; title: string; options: string; qty: number; totalMinor: number }[] }
const STATUS = { placed: { label: "To prepare", tone: "warn" }, ready: { label: "Ready to collect", tone: "info" }, collected: { label: "Collected", tone: "ok" }, cancelled: { label: "Cancelled", tone: "danger" }, expired: { label: "Expired", tone: "danger" } } as const;
type Filter = "open" | "collected" | "ended" | "all";

/** S45: what customers have reserved online for collection, store by store. */
export function OnlineOrders() {
  const lensId = useLensId(); const { selected } = useLens(); const qc = useQueryClient(); const [filter, setFilter] = useState<Filter>("open"); const [cancelling, setCancelling] = useState<string | null>(null); const [reason, setReason] = useState(""); const [msg, setMsg] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["online-orders", lensId ?? "all"], refetchInterval: 20_000, queryFn: () => api<Order[]>(`/online-orders${qs({ locationId: lensId })}`) });
  const done = () => { void qc.invalidateQueries({ queryKey: ["online-orders"] }); };
  const ready = useMutation({ mutationFn: (id: string) => api(`/online-orders/${id}/ready`, { method: "POST" }), onSuccess: () => { setMsg("The customer has been told it is ready."); done(); } });
  const cancel = useMutation({ mutationFn: (id: string) => api(`/online-orders/${id}/cancel`, { method: "POST", body: { reason: reason.trim() } }), onSuccess: () => { setCancelling(null); setReason(""); setMsg("Cancelled. The stock is back on the shelf."); done(); }, onError: (e) => setMsg(e instanceof ApiError && e.code === "already_collected" ? "That order was already collected." : "Could not cancel that order.") });
  const rows = (q.data ?? []).filter((o) => filter === "all" || (filter === "open" ? o.status === "placed" || o.status === "ready" : filter === "collected" ? o.status === "collected" : o.status === "cancelled" || o.status === "expired"));
  const open = (q.data ?? []).filter((o) => o.status === "placed" || o.status === "ready").length;
  return (<>
    <PageHeader title="Online orders" sub={<>Reserved online, collected and paid for in store{selected ? ` · ${selected.name}` : ""}. Stock is held until collection, then released after 48 hours.</>} />
    <div className="filters"><Segmented label="Show" value={filter} onChange={setFilter} options={[{ value: "open", label: `Open${open ? ` (${open})` : ""}` }, { value: "collected", label: "Collected" }, { value: "ended", label: "Cancelled or expired" }, { value: "all", label: "All" }]} /></div>
    {msg && <Callout tone="info"><span>{msg}</span></Callout>}
    <Panel flush>{q.isLoading ? <Skeleton rows={4} /> : q.isError ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : rows.length === 0 ? <Empty title={filter === "open" ? "Nothing to prepare" : "No orders here"}>{filter === "open" ? "New reservations appear here as customers place them." : "Try another filter."}</Empty> :
      <div className="tbl-wrap"><table className="tbl" data-testid="online-orders-table"><thead><tr><th>Order</th><th>Customer</th><th>Items</th><th className="n">Total</th><th>Status</th><th /></tr></thead><tbody>
        {rows.flatMap((o) => [<tr key={o.id}><td><b>{o.number}</b><br /><span className="muted" style={{ fontSize: 12 }}>{o.store} · {ago(o.placedAt)}</span></td><td>{o.customer}<br /><span className="muted" style={{ fontSize: 12 }}>{o.email}{o.phone ? ` · ${o.phone}` : ""}</span></td>
          <td>{o.lines.map((l) => <div key={l.lineNo}>{l.qty} × {l.title}{l.options ? <span className="muted"> {l.options}</span> : null}</div>)}</td><td className="n">{money(o.totalMinor)}</td>
          <td><Chip tone={STATUS[o.status].tone}>{STATUS[o.status].label}</Chip>{(o.status === "placed" || o.status === "ready") && <div className="muted" style={{ fontSize: 12 }}>Held until {dateTime(o.expiresAt)}</div>}{o.cancelReason && <div className="muted" style={{ fontSize: 12 }}>{o.cancelReason}</div>}</td>
          <td className="n">{o.status === "placed" && <Button size="sm" variant="primary" onClick={() => ready.mutate(o.id)} disabled={ready.isPending}>Mark ready</Button>}{(o.status === "placed" || o.status === "ready") && <Button size="sm" variant="ghost" onClick={() => { setCancelling(cancelling === o.id ? null : o.id); setReason(""); }}>Cancel</Button>}</td></tr>,
          cancelling === o.id && <tr key={o.id + "c"}><td colSpan={6}><form className="row-flex" aria-label={`Cancel ${o.number}`} onSubmit={(e) => { e.preventDefault(); cancel.mutate(o.id); }}><div className="grow"><Field id={`why-${o.id}`} label="Why is it being cancelled?"><TextInput id={`why-${o.id}`} value={reason} onChange={setReason} autoFocus /></Field></div><Button type="submit" variant="primary" disabled={reason.trim().length < 3 || cancel.isPending}>Cancel the order</Button><Button type="button" onClick={() => setCancelling(null)}>Keep it</Button></form></td></tr>])}</tbody></table></div>}</Panel>
  </>);
}
