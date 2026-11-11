import { Body, Controller, Get, Header, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res, Sse, type MessageEvent } from "@nestjs/common";
import type { Request, Response } from "express";
import { defer, filter, interval, map, merge, switchMap, type Observable } from "rxjs";
import { z } from "zod";
import { AuthzService } from "../auth/authz.service";
import { Auth } from "../auth/guard";
import { parse } from "../common/zod";
import { CustomersService } from "./customers.service";
import { EventsService } from "./events.service";
import { ExceptionsService } from "./exceptions.service";
import { OrdersService } from "./orders.service";
import { OverviewService } from "./overview.service";
import { ReportsService, toCsv } from "./reports.service";

const uuid = z.string().uuid(); const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Consent = z.object({ email: z.boolean().optional(), sms: z.boolean().optional() });
const Birth = { birthMonth: z.number().int().min(1).max(12), birthDay: z.number().int().min(1).max(31) };
const NewCustomer = z.object({ ...{ birthMonth: Birth.birthMonth.optional(), birthDay: Birth.birthDay.optional() }, name: z.string().trim().min(1).max(120), email: z.string().email().max(200).optional(), phone: z.string().trim().max(40).optional(), notes: z.string().max(1000).optional(), marketingConsent: Consent.optional() });
const PatchCustomer = z.object({ birthMonth: Birth.birthMonth.nullable(), birthDay: Birth.birthDay.nullable(), name: z.string().trim().min(1).max(120), email: z.string().email().max(200).nullable(), phone: z.string().trim().max(40).nullable(), notes: z.string().max(1000).nullable(), marketingConsent: Consent }).partial().refine((o) => Object.keys(o).length > 0, "empty patch");

@Controller()
export class ReportingController {
  constructor(@Inject(OverviewService) private ov: OverviewService, @Inject(OrdersService) private orders: OrdersService, @Inject(CustomersService) private customers: CustomersService, @Inject(ReportsService) private reports: ReportsService,
    @Inject(ExceptionsService) private exc: ExceptionsService, @Inject(EventsService) private ev: EventsService, @Inject(AuthzService) private authz: AuthzService) {}
  private o = (r: Request) => r.principal!.orgId; private u = (r: Request) => r.principal!.userId;
  private opt = (v: string | undefined) => (v ? parse(uuid, v) : undefined);

  @Auth({ permission: "location:read", target: "any" }) @Get("overview/locations")
  locations(@Req() r: Request) { return this.ov.locationsStatus(this.o(r), this.u(r)); }
  @Auth({ permission: "sale:read", target: "any" }) @Get("overview")
  overview(@Req() r: Request, @Query("locationId") l?: string) { return this.ov.overview(this.o(r), this.u(r), this.opt(l)); }

  @Auth({ permission: "sale:read", target: "any" }) @Get("orders")
  ordersList(@Req() r: Request, @Query("locationId") l?: string, @Query("from") from?: string, @Query("to") to?: string, @Query("q") q?: string, @Query("flag") flag?: string, @Query("status") status?: string, @Query("limit") limit?: string, @Query("before") before?: string) {
    return this.orders.list(this.o(r), this.u(r), { locationId: this.opt(l), from: from ? parse(date, from) : undefined, to: to ? parse(date, to) : undefined, q, flag, status, limit: limit ? Number(limit) : undefined, before });
  }
  @Auth({ permission: "sale:read", target: "any" }) @Get("orders/:id")
  orderDetail(@Req() r: Request, @Param("id", new ParseUUIDPipe()) id: string) { return this.orders.detail(this.o(r), this.u(r), id); }

  @Auth({ permission: "customer:read", target: "any" }) @Get("customers")
  customersList(@Req() r: Request, @Query("q") q?: string) { return this.customers.list(this.o(r), q); }
  @Auth({ permission: "customer:read", target: "any" }) @Get("customers/:id")
  customerDetail(@Req() r: Request, @Param("id", new ParseUUIDPipe()) id: string) { return this.customers.detail(this.o(r), id); }
  @Auth({ permission: "customer:write", target: "any" }) @Post("customers")
  customerCreate(@Req() r: Request, @Body() b: unknown) { return this.customers.create(this.o(r), this.u(r), parse(NewCustomer, b), r.ip ?? null); }
  @Auth({ permission: "customer:write", target: "any" }) @Patch("customers/:id")
  customerPatch(@Req() r: Request, @Param("id", new ParseUUIDPipe()) id: string, @Body() b: unknown) { return this.customers.update(this.o(r), this.u(r), id, parse(PatchCustomer, b), r.ip ?? null); }

  @Auth({ permission: "report:read", target: "any" }) @Get("reports/sales")
  async salesReport(@Req() r: Request, @Res({ passthrough: true }) res: Response, @Query("from") from: string, @Query("to") to: string, @Query("groupBy") groupBy = "day", @Query("locationId") l?: string, @Query("format") format?: string) {
    const rows = await this.reports.sales(this.o(r), this.u(r), { locationId: this.opt(l), from: parse(date, from), to: parse(date, to), groupBy: parse(z.enum(["day", "location", "product"]), groupBy) });
    if (format === "csv") { res.setHeader("content-type", "text/csv; charset=utf-8"); res.setHeader("content-disposition", `attachment; filename="sales-${from}-${to}.csv"`); return toCsv(rows); }
    return { from, to, groupBy, rows, totals: rows.reduce((a, x) => ({ orders: a.orders + x.orders, items: a.items + x.items, grossMinor: a.grossMinor + x.grossMinor, discountMinor: a.discountMinor + x.discountMinor, refundsMinor: a.refundsMinor + x.refundsMinor, netMinor: a.netMinor + x.netMinor, taxMinor: a.taxMinor + x.taxMinor }), { orders: 0, items: 0, grossMinor: 0, discountMinor: 0, refundsMinor: 0, netMinor: 0, taxMinor: 0 }) };
  }

  @Auth({ permission: "sale:read", target: "any" }) @Get("exceptions")
  exceptions(@Req() r: Request, @Query("locationId") l?: string, @Query("status") status?: string, @Query("kind") kind?: string) { return this.exc.list(this.o(r), this.u(r), { locationId: this.opt(l), status, kind }); }
  @Auth({ permission: "cash:approve", target: "any" }) @Post("exceptions/:id/resolve") @HttpCode(204)
  async resolve(@Req() r: Request, @Param("id", new ParseUUIDPipe()) id: string) { await this.exc.resolve(this.o(r), this.u(r), id, r.ip ?? null); }

  /** Server-sent events: a one-line notice whenever a sale, refund, cash entry, session, punch or exception changes at a location the caller may read. Ids only; the screen refetches. */
  @Auth({ permission: "sale:read", target: "any" }) @Sse("stream")
  stream(@Req() r: Request): Observable<MessageEvent> {
    const org = this.o(r), user = this.u(r);
    return defer(() => this.authz.scope(user, "sale:read")).pipe(switchMap((scope) => merge(
      this.ev.events.pipe(filter((e) => e.org === org && (e.loc === null || scope.all || scope.locationIds.includes(e.loc))), map((e): MessageEvent => ({ type: "change", data: { kind: e.kind, locationId: e.loc, id: e.id } }))),
      interval(25_000).pipe(map((): MessageEvent => ({ type: "ping", data: {} }))),
    )));
  }
}
void Header;
