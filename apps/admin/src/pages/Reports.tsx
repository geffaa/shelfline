import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Calendar, ChevronLeft, ChevronRight, Download } from "lucide-react";
import { Button, DatePicker, Segmented } from "@shelfline/ui";
import { api, qs } from "../lib/api";
import { addDays, money, plain } from "../lib/format";
import { useBusinessToday, useLens, useLensId } from "../state/lens";
import { Empty, ErrorBox, PageHeader, Panel, Skeleton } from "../ui";

type G = "day" | "location" | "product";


export function Reports() {
  const lensId = useLensId(); const { lens, selected } = useLens(); const today = useBusinessToday(); const [fromP, setFrom] = useState<string | null>(null); const [toP, setTo] = useState<string | null>(null); const from = fromP ?? addDays(today, -6); const to = toP ?? today; const [groupBy, setGroupBy] = useState<G>("day");
  const q = useQuery({ queryKey: ["reports", "sales", lensId ?? "all", from, to, groupBy], queryFn: () => api<{ rows: any[]; totals: any }>(`/reports/sales${qs({ locationId: lensId, from, to, groupBy })}`) });
  const download = async () => { const csv = await api<string>(`/reports/sales${qs({ locationId: lensId, from, to, groupBy, format: "csv" })}`, { raw: true }); const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = `sales-${groupBy}-${from}-${to}.csv`; a.click(); URL.revokeObjectURL(a.href); };
  const preset = (a: string, b: string) => { setFrom(a); setTo(b); };
  const t = q.data?.totals;
  return (<>
    <PageHeader title="Reports" sub={<>Sales · {lens === "all" ? "all locations" : selected?.name} · refunds count on the day they were given</>} actions={<Button onClick={() => void download()} disabled={!q.data?.rows.length}><Download size={14} />Download CSV</Button>} />
    <div className="filters">
      <DatePicker label="From" value={from} onChange={(v) => { setFrom(v); if (v > to) setTo(v); }} today={today} icon={<Calendar size={16} />} prevIcon={<ChevronLeft size={16} />} nextIcon={<ChevronRight size={16} />} />
      <DatePicker label="To" value={to} onChange={(v) => { setTo(v); if (v < from) setFrom(v); }} today={today} icon={<Calendar size={16} />} prevIcon={<ChevronLeft size={16} />} nextIcon={<ChevronRight size={16} />} />
      <Button size="sm" onClick={() => preset(today, today)}>Today</Button><Button size="sm" onClick={() => preset(addDays(today, -1), addDays(today, -1))}>Yesterday</Button><Button size="sm" onClick={() => preset(addDays(today, -6), today)}>Last 7 days</Button><Button size="sm" onClick={() => preset(`${today.slice(0, 8)}01`, today)}>This month</Button>
      <Segmented label="Group by" value={groupBy} onChange={setGroupBy} options={[{ value: "day", label: "Day" }, { value: "location", label: "Location" }, { value: "product", label: "Product" }]} />
    </div>
    <Panel flush>{q.isLoading ? <Skeleton rows={6} /> : q.isError ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : q.data!.rows.length === 0 ? <Empty title="No sales in this range">Pick a wider range, or another location.</Empty> :
      <div className="tbl-wrap"><table className="tbl" data-testid="report-table"><thead><tr><th>{groupBy === "day" ? "Day" : groupBy === "location" ? "Location" : "Product"}</th><th className="n">Orders</th><th className="n">Items</th><th className="n">Gross</th><th className="n">Discounts</th><th className="n">Refunds</th><th className="n">Net</th><th className="n">GST incl.</th></tr></thead>
        <tbody>{q.data!.rows.map((r) => <tr key={r.key}><td><b>{r.label}</b></td><td className="n">{r.orders}</td><td className="n">{r.items}</td><td className="n">{plain(r.grossMinor)}</td><td className="n">{plain(-r.discountMinor)}</td><td className={`n${r.refundsMinor ? " neg" : ""}`}>{plain(-r.refundsMinor)}</td><td className="n"><b>{plain(r.netMinor)}</b></td><td className="n">{plain(r.taxMinor)}</td></tr>)}</tbody>
        <tfoot><tr><td><b>Total</b></td><td className="n"><b>{t.orders}</b></td><td className="n"><b>{t.items}</b></td><td className="n"><b>{plain(t.grossMinor)}</b></td><td className="n"><b>{plain(-t.discountMinor)}</b></td><td className="n"><b>{plain(-t.refundsMinor)}</b></td><td className="n" data-testid="report-net"><b>{plain(t.netMinor)}</b></td><td className="n"><b>{plain(t.taxMinor)}</b></td></tr></tfoot></table></div>}</Panel>
    {t && <p className="muted" style={{ margin: 0 }}>Net {money(t.netMinor)} for {from} to {to}. Product rows show line totals before refunds are matched to the sale day.</p>}
  </>);
}
