import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Calendar, ChevronDown, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { Button, Chip, DatePicker, Select } from "@shelfline/ui";
import { api, qs } from "../lib/api";
import { addDays, dateTime, flagLabel, money, plain, time, todayYmd } from "../lib/format";
import { href, navigate, useRoute } from "../router";
import { useBusinessToday, useLens, useLensId, useTz } from "../state/lens";
import { Empty, ErrorBox, FlagChips, PageHeader, Panel, Skeleton } from "../ui";

interface Item { id: string; receiptNo: string; at: string; localDate: string; totalMinor: number; discountMinor: number; status: string; flags: string[]; location: string; register: string; cashier: string; customer: string | null; tenders: string[]; items: number; refundedMinor: number }
const FLAGS = ["negative_stock", "price_mismatch", "payment_mismatch", "discount_unapproved", "late_sale", "receipt_no_reused", "no_session", "unknown_customer"];
const STATUS = [{ value: "", label: "Any status" }, { value: "completed", label: "Completed" }, { value: "partially_refunded", label: "Part refunded" }, { value: "refunded", label: "Refunded" }];
const statusChip = (s: string) => s === "refunded" ? <Chip tone="warn">Refunded</Chip> : s === "partially_refunded" ? <Chip tone="warn">Part refunded</Chip> : null;

function OrderDetail({ id }: { id: string }) {
  const tzOf = useTz();
  const q = useQuery({ queryKey: ["order", id], queryFn: () => api<any>(`/orders/${id}`) });
  if (q.isLoading) return <Panel><Skeleton rows={8} /></Panel>; if (q.isError) return <ErrorBox error={q.error} retry={() => q.refetch()} />; const o = q.data!;
  return (
    <section className="panel detail" aria-label={`Order ${o.receiptNo}`} data-testid="order-detail">
      <div className="drawer-head"><h2>{o.receiptNo}</h2><span className="row-flex" style={{ gap: 6 }}>{statusChip(o.status)}<button className="btn ghost sm" aria-label="Close details" onClick={() => navigate("sell", "orders")}>✕</button></span></div>
      <div className="pb stack">
        {o.flags.length > 0 && <div className="callout"><div><b>Recorded with notes.</b> <FlagChips flags={o.flags} /></div></div>}
        <dl className="kv"><dt>When</dt><dd>{dateTime(o.at, tzOf(o.location))} <span className="muted">(received {time(o.receivedAt, tzOf(o.location))})</span></dd><dt>Where</dt><dd>{o.location} · {o.register}</dd><dt>Cashier</dt><dd>{o.cashier}</dd><dt>Customer</dt><dd>{o.customer ? <a href={href("sell", "customers", o.customer.id)}>{o.customer.name}</a> : <span className="muted">None</span>}</dd>
          {o.sessionId && <><dt>Session</dt><dd><a href={href("today", "sessions", o.sessionId)}>Register session</a></dd></>}</dl>
        <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Item</th><th className="n">Qty</th><th className="n">Price</th><th className="n">Total</th></tr></thead><tbody>{o.lines.map((l: any) => <tr key={l.lineNo}><td><b>{l.title}</b><br /><span className="muted">{l.options} · {l.sku}</span>{l.discountMinor > 0 && <div style={{ color: "var(--ok)", fontSize: 12.5 }}>−{plain(l.discountMinor)} {l.discountReason}{l.approvedBy ? ` · approved by ${l.approvedBy}` : ""}</div>}{l.refundedQty > 0 && <div className="muted" style={{ fontSize: 12.5 }}>{l.refundedQty} refunded</div>}</td><td className="n">{l.qty}</td><td className="n">{plain(l.unitPriceMinor)}</td><td className="n">{plain(l.totalMinor)}</td></tr>)}</tbody></table></div>
        <div className="sheet">
          <div className="lead"><span>Subtotal</span><i /><b>{plain(o.totals.subtotalMinor)}</b></div>{o.totals.discountMinor > 0 && <div className="lead gain"><span>Discount</span><i /><b>{plain(-o.totals.discountMinor)}</b></div>}
          <div className="lead total"><span>Total</span><i /><b>{plain(o.totals.totalMinor)}</b></div><div className="lead sub"><span>GST included</span><i /><b>{plain(o.totals.taxMinor)}</b></div>
          {o.payments.map((p: any, i: number) => <div className="lead" key={i}><span>{p.tender[0].toUpperCase() + p.tender.slice(1)}{p.reference ? ` · ${p.reference}` : ""}</span><i /><b>{plain(p.amountMinor)}</b></div>)}{o.totals.changeMinor > 0 && <div className="lead sub"><span>Change given</span><i /><b>{plain(o.totals.changeMinor)}</b></div>}
        </div>
        {o.refunds.length > 0 && <div><b>Refunds</b>{o.refunds.map((r: any) => <div key={r.id} className="lead"><span>{time(r.at, tzOf(o.location))} · {r.reason.replace(/_/g, " ")} · {r.tender} · {r.actor}{r.approver ? ` (approved by ${r.approver})` : ""} {r.flags.length ? <FlagChips flags={r.flags} /> : null}</span><i /><b>{plain(-r.totalMinor)}</b></div>)}</div>}
        {o.exceptions.length > 0 && <div><b>Alerts</b>{o.exceptions.map((e: any) => <div key={e.id} className="row-flex"><Chip tone={e.status === "open" ? "warn" : "ok"}>{flagLabel(e.kind)}</Chip><span className="muted">{e.status}</span></div>)}</div>}
      </div>
    </section>
  );
}

export function Orders() {
  const tzOf = useTz();
  const route = useRoute(); const lensId = useLensId(); const { lens, selected } = useLens();
  const [q, setQ] = useState(route.query.get("q") ?? ""); const today = useBusinessToday(); const [fromP, setFrom] = useState<string | null>(null); const [toP, setTo] = useState<string | null>(null); const from = fromP ?? addDays(today, -6); const to = toP ?? today; const [flag, setFlag] = useState(""); const [status, setStatus] = useState("");
  useEffect(() => { setQ(route.query.get("q") ?? ""); }, [route.query]);
  const list = useInfiniteQuery({ queryKey: ["orders", lensId ?? "all", q, from, to, flag, status], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<{ items: Item[]; next: string | null }>(`/orders${qs({ locationId: lensId, q, from, to, flag, status, before: pageParam, limit: 40 })}`), getNextPageParam: (p) => p.next ?? undefined });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? []; const sel = route.id;
  return (<>
    <PageHeader title="Orders" sub={<>{lens === "all" ? "All locations" : selected?.name} · newest first · tap a row for the receipt</>} />
    <div className="filters" role="search">
      <label className="input" style={{ minWidth: 240 }}><Search size={16} /><input aria-label="Search receipt or customer" placeholder="Receipt number or customer" value={q} onChange={(e) => setQ(e.target.value)} /></label>
      <DatePicker label="From" value={from} onChange={(v) => { setFrom(v); if (v > to) setTo(v); }} today={today} icon={<Calendar size={16} />} prevIcon={<ChevronLeft size={16} />} nextIcon={<ChevronRight size={16} />} />
      <DatePicker label="To" value={to} onChange={(v) => { setTo(v); if (v < from) setFrom(v); }} today={today} icon={<Calendar size={16} />} prevIcon={<ChevronLeft size={16} />} nextIcon={<ChevronRight size={16} />} />
      <Select label="Alert" value={flag} onChange={setFlag} options={[{ value: "", label: "Any alert" }, ...FLAGS.map((f) => ({ value: f, label: flagLabel(f) }))]} chevron={<ChevronDown size={16} />} />
      <Select label="Status" value={status} onChange={setStatus} options={STATUS} chevron={<ChevronDown size={16} />} />
    </div>
    <div className={`md${sel ? "" : " single"}`}>
      <Panel flush>
        {list.isLoading ? <Skeleton rows={6} /> : list.isError ? <ErrorBox error={list.error} retry={() => list.refetch()} /> : rows.length === 0 ? <Empty title="No orders match">Try a wider date range, or clear the filters.</Empty> : <>
          <div className="tbl-wrap"><table className="tbl" data-testid="orders-table"><thead><tr><th>Receipt</th><th>When</th>{lens === "all" && <th>Location</th>}<th>Cashier</th><th>Customer</th><th className="n">Items</th><th className="n">Total</th><th>Paid by</th><th /></tr></thead>
            <tbody>{rows.map((o) => <tr key={o.id} className="clickable" tabIndex={0} aria-selected={sel === o.id} onClick={() => navigate("sell", "orders", o.id, q ? { q } : undefined)} onKeyDown={(e) => { if (e.key === "Enter") navigate("sell", "orders", o.id); }}>
              <td><b className="mono">{o.receiptNo}</b></td><td>{dateTime(o.at, tzOf(o.location))}</td>{lens === "all" && <td>{o.location}</td>}<td>{o.cashier}</td><td>{o.customer ?? <span className="muted">—</span>}</td><td className="n">{o.items}</td><td className="n">{plain(o.totalMinor)}</td><td>{o.tenders.join(", ")}</td>
              <td>{statusChip(o.status)} {o.flags.length > 0 && <Chip tone="warn">{o.flags.length === 1 ? flagLabel(o.flags[0]!) : `${o.flags.length} alerts`}</Chip>}</td></tr>)}</tbody></table></div>
          {list.hasNextPage && <div className="pb"><Button onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>Load more</Button></div>}
          <div className="pb muted" style={{ borderTop: "1px solid var(--line)" }}>{rows.length} order{rows.length === 1 ? "" : "s"} shown · {money(rows.reduce((a, o) => a + o.totalMinor, 0))}</div>
        </>}
      </Panel>
      {sel && <OrderDetail id={sel} />}
    </div>
  </>);
}
