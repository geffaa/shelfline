import { Inject, Injectable } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import { AuthzService } from "../auth/authz.service";
import { zReport } from "../cash/z-report";
import { DB, type Db } from "../db/db.module";
import { locationScope } from "./scope";

const idList = (ids: string[]) => sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `);
/** The business date "now" at a location: local time minus the day cutoff (a 02:30 sale at a 04:00 cutoff still belongs to yesterday). */
const TODAY = sql`((now() at time zone l.timezone) - l.day_cutoff::interval)::date`;

@Injectable()
export class OverviewService {
  constructor(@Inject(DB) private db: Db, @Inject(AuthzService) private authz: AuthzService) {}

  private scopeSql(ids: string[] | null): SQL { return ids === null ? sql`true` : ids.length ? sql`l.id in (${idList(ids)})` : sql`false`; }

  /** One row per location the caller may see: what the rail shows (open or closed, offline tills, open exceptions, today's net). */
  async locationsStatus(orgId: string, userId: string) {
    const ids = await locationScope(this.authz, userId, "location:read");
    const r = await this.db.execute(sql`
      select l.id, l.code, l.name, l.type, l.timezone, ${TODAY} as today,
        (select count(*)::int from shelfline.register_session s where s.location_id = l.id and s.status = 'open') as registers_open,
        (select count(*)::int from shelfline.device d where d.location_id = l.id and d.kind = 'pos' and d.status = 'active' and (d.last_seen_at is null or d.last_seen_at < now() - interval '2 minutes')) as devices_offline,
        (select count(*)::int from shelfline.sync_exception e join shelfline.device d on d.id = e.device_id where d.location_id = l.id and e.status = 'open') as open_exceptions,
        coalesce((select sum(total_minor) from shelfline.sale x where x.location_id = l.id and x.local_date = ${TODAY}), 0)::int
          - coalesce((select sum(total_minor) from shelfline.refund x where x.location_id = l.id and x.local_date = ${TODAY}), 0)::int as net_today
      from shelfline.location l where l.org_id = ${orgId} and l.status = 'active' and l.type <> 'transit' and ${this.scopeSql(ids)} order by l.name`);
    return r.rows.map((x) => ({ id: String(x.id), code: String(x.code), name: String(x.name), type: String(x.type), timezone: String(x.timezone), today: String(x.today), registersOpen: Number(x.registers_open), devicesOffline: Number(x.devices_offline), openExceptions: Number(x.open_exceptions), netTodayMinor: Number(x.net_today) }));
  }

  async overview(orgId: string, userId: string, locationId?: string) {
    const ids = await locationScope(this.authz, userId, "sale:read", locationId);
    const sc = this.scopeSql(ids);
    const [tot, hourly, yest, sess, exc, offline] = await Promise.all([
      this.db.execute(sql`
        select count(s.id)::int as n, coalesce(sum(s.total_minor), 0)::int as gross, coalesce(sum(s.discount_minor), 0)::int as discount, coalesce(sum(s.tax_minor), 0)::int as tax,
          coalesce(sum((select sum(qty) from shelfline.sale_line sl where sl.sale_id = s.id)), 0)::int as items
        from shelfline.location l left join shelfline.sale s on s.location_id = l.id and s.local_date = ${TODAY} where l.org_id = ${orgId} and ${sc}`),
      this.db.execute(sql`
        select h, coalesce(sum(n), 0)::int as n, coalesce(sum(net), 0)::int as net from (
          select extract(hour from s.effective_at at time zone l.timezone)::int as h, 1 as n, s.total_minor as net from shelfline.sale s join shelfline.location l on l.id = s.location_id where l.org_id = ${orgId} and ${sc} and s.local_date = ${TODAY}
          union all select extract(hour from r.at at time zone l.timezone)::int, 0, -r.total_minor from shelfline.refund r join shelfline.location l on l.id = r.location_id where l.org_id = ${orgId} and ${sc} and r.local_date = ${TODAY}
        ) x group by h order by h`),
      this.db.execute(sql`
        select coalesce((select sum(s.total_minor) from shelfline.sale s join shelfline.location l on l.id = s.location_id where l.org_id = ${orgId} and ${sc} and s.local_date = ${TODAY} - 1), 0)::int
          - coalesce((select sum(r.total_minor) from shelfline.refund r join shelfline.location l on l.id = r.location_id where l.org_id = ${orgId} and ${sc} and r.local_date = ${TODAY} - 1), 0)::int as net`),
      this.db.execute(sql`
        select s.id, s.opened_at, s.flags, l.name as location, reg.code as register, u.name as cashier from shelfline.register_session s join shelfline.location l on l.id = s.location_id
          join shelfline.register reg on reg.id = s.register_id join shelfline."user" u on u.id = s.opened_by where l.org_id = ${orgId} and ${sc} and s.status = 'open' order by s.opened_at`),
      this.db.execute(sql`
        select e.id, e.kind, e.ref_type, e.ref_id, e.created_at, d.name as device, l.name as location from shelfline.sync_exception e join shelfline.device d on d.id = e.device_id join shelfline.location l on l.id = d.location_id
          where e.org_id = ${orgId} and e.status = 'open' and ${sc} order by e.created_at desc limit 8`),
      this.db.execute(sql`
        select d.id, d.name, d.last_seen_at, l.name as location from shelfline.device d join shelfline.location l on l.id = d.location_id
          where l.org_id = ${orgId} and ${sc} and d.kind = 'pos' and d.status = 'active' and (d.last_seen_at is null or d.last_seen_at < now() - interval '2 minutes') order by d.name`),
    ]);
    const t = tot.rows[0] as Record<string, number>;
    const refunds = (await this.db.execute(sql`select coalesce(sum(r.total_minor), 0)::int as amt, count(*)::int as n from shelfline.refund r join shelfline.location l on l.id = r.location_id where l.org_id = ${orgId} and ${sc} and r.local_date = ${TODAY}`)).rows[0] as { amt: number; n: number };
    const hours = Array.from({ length: 24 }, (_, h) => { const row = hourly.rows.find((x) => Number(x.h) === h); return { hour: h, orders: Number(row?.n ?? 0), netMinor: Number(row?.net ?? 0) }; });
    const openSessions = await Promise.all(sess.rows.map(async (s) => { const z = await zReport(this.db, String(s.id)); return { id: String(s.id), location: String(s.location), register: String(s.register), cashier: String(s.cashier), openedAt: s.opened_at, flags: s.flags as string[], salesCount: z?.salesCount ?? 0, netSalesMinor: z?.netSalesMinor ?? 0, expectedMinor: z?.expectedMinor ?? 0 }; }));
    const gross = Number(t.gross), net = gross - Number(refunds.amt);
    return {
      totals: { orders: Number(t.n), grossMinor: gross, discountMinor: Number(t.discount), refundsMinor: Number(refunds.amt), refundsCount: Number(refunds.n), netMinor: net, taxMinor: Number(t.tax), items: Number(t.items), avgBasketMinor: Number(t.n) ? Math.round(gross / Number(t.n)) : 0, yesterdayNetMinor: Number((yest.rows[0] as { net: number }).net) },
      hours, openSessions,
      exceptions: exc.rows.map((e) => ({ id: String(e.id), kind: String(e.kind), refType: e.ref_type as string | null, refId: e.ref_id as string | null, createdAt: e.created_at, device: String(e.device), location: String(e.location) })),
      offlineDevices: offline.rows.map((d) => ({ id: String(d.id), name: String(d.name), location: String(d.location), lastSeenAt: d.last_seen_at })),
    };
  }
}
