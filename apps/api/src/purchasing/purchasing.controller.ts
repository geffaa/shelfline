import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { Auth } from "../auth/guard";
import { parse } from "../common/zod";
import { BillsService } from "./bills.service";
import { PurchasingService } from "./purchasing.service";

const uuid = z.string().uuid(); const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/); const money = z.number().int().min(0).max(1_000_000_000);
const Supplier = z.object({ name: z.string().trim().min(1).max(120), contactName: z.string().trim().max(120).optional(), email: z.string().email().max(200).optional(), phone: z.string().trim().max(40).optional(), termsDays: z.number().int().min(0).max(365).optional(), leadTimeDays: z.number().int().min(0).max(365).optional(), note: z.string().max(500).optional() });
const SupplierPatch = Supplier.partial().extend({ status: z.enum(["active", "archived"]).optional(), contactName: z.string().trim().max(120).nullable().optional(), email: z.string().email().max(200).nullable().optional(), phone: z.string().trim().max(40).nullable().optional(), note: z.string().max(500).nullable().optional() }).refine((o) => Object.keys(o).length > 0, "nothing to change");
const PoLine = z.object({ variantId: uuid, qty: z.number().int().min(1).max(100_000), unitCostMinor: money });
const Po = z.object({ supplierId: uuid, locationId: uuid, expectedOn: ymd.nullable().optional(), note: z.string().max(500).optional(), lines: z.array(PoLine).min(1).max(300) });
const PoPatch = z.object({ expectedOn: ymd.nullable().optional(), note: z.string().max(500).nullable().optional(), lines: z.array(PoLine).min(1).max(300).optional() }).refine((o) => Object.keys(o).length > 0, "nothing to change");
const Receive = z.object({ idempotencyKey: uuid, lines: z.array(z.object({ poLineId: uuid, qty: z.number().int().min(1).max(100_000) })).min(1).max(300), freightMinor: money.default(0), otherCostMinor: money.default(0), note: z.string().max(300).optional() });
const Bill = z.object({ supplierId: uuid, poId: uuid.nullable().optional(), number: z.string().trim().min(1).max(60), billDate: ymd, dueOn: ymd.optional(),
  lines: z.array(z.object({ poLineId: uuid.optional(), variantId: uuid.optional(), description: z.string().trim().max(200).optional(), qty: z.number().int().min(1).max(100_000), unitCostMinor: money })).min(1).max(300) });
const Pay = z.object({ amountMinor: z.number().int().min(1).max(1_000_000_000), paidOn: ymd, method: z.enum(["bank_transfer", "card", "cash", "other"]), reference: z.string().trim().max(80).optional(), idempotencyKey: uuid });
const today = () => new Date().toISOString().slice(0, 10);

@Controller()
export class PurchasingController {
  constructor(@Inject(PurchasingService) private p: PurchasingService, @Inject(BillsService) private b: BillsService) {}
  private o(r: Request) { return r.principal!.orgId; } private u(r: Request) { return r.principal!.userId; }

  @Auth({ permission: "purchase:read", target: "org" }) @Get("suppliers")
  suppliers(@Req() r: Request, @Query("q") q?: string, @Query("status") status?: string) { return this.p.listSuppliers(this.o(r), { q, status }); }
  @Auth({ permission: "purchase:write", target: "org" }) @Post("suppliers")
  createSupplier(@Body() body: unknown, @Req() r: Request) { return this.p.createSupplier(this.o(r), this.u(r), parse(Supplier, body), r.ip ?? null); }
  @Auth({ permission: "purchase:write", target: "org" }) @Patch("suppliers/:id")
  patchSupplier(@Param("id", new ParseUUIDPipe()) id: string, @Body() body: unknown, @Req() r: Request) { return this.p.updateSupplier(this.o(r), this.u(r), id, parse(SupplierPatch, body), r.ip ?? null); }

  @Auth({ permission: "purchase:read", target: "org" }) @Get("purchase-orders")
  pos(@Req() r: Request, @Query("status") status?: string, @Query("supplierId") supplierId?: string, @Query("locationId") locationId?: string, @Query("q") q?: string) {
    return this.p.listPos(this.o(r), { status, supplierId: supplierId ? parse(uuid, supplierId) : undefined, locationId: locationId ? parse(uuid, locationId) : undefined, q });
  }
  @Auth({ permission: "purchase:write", target: "org" }) @Post("purchase-orders")
  createPo(@Body() body: unknown, @Req() r: Request) { return this.p.createPo(this.o(r), this.u(r), parse(Po, body), r.ip ?? null); }
  @Auth({ permission: "purchase:read", target: "org" }) @Get("purchase-orders/:id")
  po(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.p.getPo(this.o(r), id); }
  @Auth({ permission: "purchase:write", target: "org" }) @Patch("purchase-orders/:id")
  patchPo(@Param("id", new ParseUUIDPipe()) id: string, @Body() body: unknown, @Req() r: Request) { return this.p.updatePo(this.o(r), this.u(r), id, parse(PoPatch, body), r.ip ?? null); }
  @Auth({ permission: "purchase:write", target: "org" }) @Post("purchase-orders/:id/send") @HttpCode(200)
  send(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.p.send(this.o(r), this.u(r), id, r.ip ?? null); }
  @Auth({ permission: "purchase:write", target: "org" }) @Post("purchase-orders/:id/cancel") @HttpCode(200)
  cancel(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.p.cancel(this.o(r), this.u(r), id, r.ip ?? null); }
  @Auth({ permission: "purchase:write", target: "org" }) @Post("purchase-orders/:id/close") @HttpCode(200)
  close(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.p.close(this.o(r), this.u(r), id, r.ip ?? null); }
  /** Receiving is a stock write at the order's location, so it is checked against inventory:write there (a store manager can receive their own store's order). */
  @Auth({ permission: "inventory:write", target: "any" }) @Post("purchase-orders/:id/receive") @HttpCode(200)
  receive(@Param("id", new ParseUUIDPipe()) id: string, @Body() body: unknown, @Req() r: Request) { return this.p.receive(this.o(r), this.u(r), id, parse(Receive, body), r.ip ?? null); }

  @Auth({ permission: "bill:read", target: "org" }) @Get("bills")
  bills(@Req() r: Request, @Query("status") status?: string, @Query("supplierId") supplierId?: string, @Query("overdue") overdue?: string, @Query("q") q?: string, @Query("asOf") asOf?: string) {
    return this.b.list(this.o(r), { status, supplierId: supplierId ? parse(uuid, supplierId) : undefined, overdue: overdue === "1", q, asOf: asOf ? parse(ymd, asOf) : today() });
  }
  @Auth({ permission: "bill:read", target: "org" }) @Get("bills/aging")
  aging(@Req() r: Request, @Query("asOf") asOf?: string) { return this.b.aging(this.o(r), asOf ? parse(ymd, asOf) : today()); }
  @Auth({ permission: "bill:write", target: "org" }) @Post("bills")
  createBill(@Body() body: unknown, @Req() r: Request) { return this.b.create(this.o(r), this.u(r), parse(Bill, body), r.ip ?? null); }
  @Auth({ permission: "bill:read", target: "org" }) @Get("bills/:id")
  bill(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.b.get(this.o(r), id); }
  @Auth({ permission: "bill:write", target: "org" }) @Post("bills/:id/rematch") @HttpCode(200)
  rematch(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.b.rematch(this.o(r), this.u(r), id, r.ip ?? null); }
  @Auth({ permission: "bill:approve", target: "org" }) @Post("bills/:id/approve") @HttpCode(200)
  approve(@Param("id", new ParseUUIDPipe()) id: string, @Body() body: unknown, @Req() r: Request) { return this.b.approve(this.o(r), this.u(r), id, parse(z.object({ note: z.string().trim().min(3).max(300) }), body).note, r.ip ?? null); }
  @Auth({ permission: "bill:write", target: "org" }) @Post("bills/:id/payments") @HttpCode(200)
  pay(@Param("id", new ParseUUIDPipe()) id: string, @Body() body: unknown, @Req() r: Request) { return this.b.pay(this.o(r), this.u(r), id, parse(Pay, body), r.ip ?? null); }
  @Auth({ permission: "bill:write", target: "org" }) @Post("bills/:id/void") @HttpCode(200)
  voidBill(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.b.voidBill(this.o(r), this.u(r), id, r.ip ?? null); }
}
