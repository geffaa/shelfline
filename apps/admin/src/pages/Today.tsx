import { useQuery } from "@tanstack/react-query";
import { Chip } from "@shelfline/ui";
import { api, qs } from "../lib/api";
import { ago, flagLabel, money, plain, time } from "../lib/format";
import { href } from "../router";
import { useLens, useLensId, useTz } from "../state/lens";
import { Empty, ErrorBox, PageHeader, Panel, Skeleton } from "../ui";

interface Overview {
  totals: { orders: number; grossMinor: number; discountMinor: number; refundsMinor: number; refundsCount: number; netMinor: number; taxMinor: number; items: number; avgBasketMinor: number; yesterdayNetMinor: number };
  hours: { hour: number; orders: number; netMinor: number }[];
  openSessions: { id: string; location: string; register: string; cashier: string; openedAt: string; flags: string[]; salesCount: number; netSalesMinor: number; expectedMinor: number }[];
  exceptions: { id: string; kind: string; refType: string | null; refId: string | null; createdAt: string; device: string; location: string }[];
  offlineDevices: { id: string; name: string; location: string; lastSeenAt: string | null }[];
}

function HourChart({ hours, tz }: { hours: Overview["hours"]; tz?: string }) {
  const active = hours.filter((h) => h.orders > 0 || h.netMinor !== 0).map((h) => h.hour);
  const lo = Math.min(7, ...(active.length ? active : [7])), hi = Math.max(20, ...(active.length ? active : [20]));
  const shown = hours.filter((h) => h.hour >= lo && h.hour <= hi); const max = Math.max(1, ...shown.map((h) => Math.abs(h.netMinor))); const nowH = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: tz }).format(new Date()));   // the store's current hour, not the browser's
  return (<>
    <div className="bars" role="img" aria-label={`Net sales by hour, ${shown.length} hours`}>{shown.map((h) => <div key={h.hour} className={`b${h.netMinor < 0 ? " neg" : ""}${h.hour === nowH ? " now" : ""}`} style={{ height: `${Math.max(1.5, (Math.abs(h.netMinor) / max) * 100)}%` }} title={`${String(h.hour).padStart(2, "0")}:00 · ${money(h.netMinor)} · ${h.orders} order${h.orders === 1 ? "" : "s"}`} />)}</div>
    <div className="axis" aria-hidden>{shown.map((h) => <span key={h.hour}>{h.hour % 3 === 0 ? String(h.hour).padStart(2, "0") : ""}</span>)}</div>
    <table className="sr"><caption>Net sales by hour</caption><thead><tr><th>Hour</th><th>Orders</th><th>Net</th></tr></thead><tbody>{shown.map((h) => <tr key={h.hour}><td>{h.hour}:00</td><td>{h.orders}</td><td>{money(h.netMinor)}</td></tr>)}</tbody></table>
  </>);
}

export function Today() {
  const tzOf = useTz();
  const lensId = useLensId(); const { selected, lens, locations } = useLens();
  const q = useQuery({ queryKey: ["overview", lensId ?? "all"], queryFn: () => api<Overview>(`/overview${qs({ locationId: lensId })}`) });
  const o = q.data; const t = o?.totals;
  const delta = t && t.yesterdayNetMinor > 0 ? Math.round(((t.netMinor - t.yesterdayNetMinor) / t.yesterdayNetMinor) * 100) : null;
  return (<>
    <PageHeader title="Today" sub={<>{lens === "all" ? "All locations" : selected?.name} · {new Date().toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" })} · AUD <span className="muted">synthetic demo data</span></>} />
    {q.isLoading ? <Panel><Skeleton rows={6} /></Panel> : q.isError ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : o && t && (<>
      <div className="split s56">
        <Panel title="So far today" right={delta !== null ? <Chip tone={delta >= 0 ? "ok" : "warn"}>{delta >= 0 ? "+" : ""}{delta}% vs all of yesterday</Chip> : <span className="muted">yesterday: {money(t.yesterdayNetMinor)}</span>}>
          <div className="lead total" style={{ borderTop: 0, marginTop: 0, paddingTop: 0 }}><span>Net sales</span><i /><b data-testid="net-sales">{plain(t.netMinor)}</b></div>
          <div className="lead"><span>Gross sales</span><i /><b>{plain(t.grossMinor)}</b></div>
          <div className={`lead${t.discountMinor ? " neg" : ""}`}><span>Discounts <span className="muted">(included above)</span></span><i /><b>{plain(-t.discountMinor)}</b></div>
          <div className={`lead${t.refundsMinor ? " neg" : ""}`}><span>Refunds <span className="muted">({t.refundsCount})</span></span><i /><b>{plain(-t.refundsMinor)}</b></div>
          <div className="lead sub"><span>GST included</span><i /><b>{plain(t.taxMinor)}</b></div>
          <hr className="perf" />
          <div className="lead"><span>Orders</span><i /><b data-testid="orders-count">{t.orders}</b></div>
          <div className="lead"><span>Items sold</span><i /><b>{t.items}</b></div>
          <div className="lead"><span>Average order</span><i /><b>{plain(t.avgBasketMinor)}</b></div>
        </Panel>
        <Panel title="Sales by hour" right={<span className="muted">net, local time</span>}>
          {t.orders === 0 && t.refundsMinor === 0 ? <Empty title="No sales yet today">As soon as a till completes a sale it appears here without a refresh.</Empty> : <HourChart hours={o.hours} tz={selected?.timezone ?? locations.find((l) => l.type === "store")?.timezone} />}
        </Panel>
      </div>
      <div className="split s65">
        <Panel title="Registers" right={<a href={href("today", "sessions")}>Sessions</a>} flush>
          {o.openSessions.length === 0 ? <Empty title="No register is open">Open registers show here with the cash expected in the drawer.</Empty> :
            <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Register</th><th>Cashier</th><th>Since</th><th className="n">Orders</th><th className="n">Net</th><th className="n">Cash expected</th></tr></thead>
              <tbody>{o.openSessions.map((s) => <tr key={s.id} className="clickable" tabIndex={0} onClick={() => { window.location.hash = href("today", "sessions", s.id); }} onKeyDown={(e) => { if (e.key === "Enter") window.location.hash = href("today", "sessions", s.id); }}><td><b>{s.register}</b><br /><span className="muted">{s.location}</span></td><td>{s.cashier}</td><td className="mono">{time(s.openedAt, tzOf(s.location))}</td><td className="n">{s.salesCount}</td><td className="n">{plain(s.netSalesMinor)}</td><td className="n">{plain(s.expectedMinor)}</td></tr>)}</tbody></table></div>}
        </Panel>
        <Panel title="Needs attention" right={<a href={href("today", "alerts")}>All alerts</a>} flush>
          {o.exceptions.length === 0 && o.offlineDevices.length === 0 ? <Empty title="Nothing needs a look">Exceptions from the tills and silent tills appear here.</Empty> : <div className="pb stack" data-testid="attention">
            {o.offlineDevices.map((d) => <div key={d.id} className="row-flex"><Chip tone="warn">Till silent</Chip><span className="grow"><b>{d.name}</b> · {d.location}</span><span className="muted">{ago(d.lastSeenAt)}</span></div>)}
            {o.exceptions.map((e) => <div key={e.id} className="row-flex"><Chip tone="warn">{flagLabel(e.kind)}</Chip><span className="grow">{e.location} · {e.device}</span><span className="muted">{ago(e.createdAt)}</span></div>)}</div>}
        </Panel>
      </div>
    </>)}
  </>);
}
