import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import type { ZodType } from "zod";
import { z } from "zod";
import type { Permission } from "../auth/permissions";
import type { device as deviceTable } from "../db/schema";
import { LedgerService, type Tx } from "../inventory/ledger.service";

export type DeviceRow = typeof deviceTable.$inferSelect;
export interface CommandContext { tx: Tx; orgId: string; actorId: string; device: DeviceRow; at: Date; commandId: string }
export interface HandlerOutput { result?: unknown; flags?: string[]; exceptions?: { kind: string; refType?: string; refId?: string; detail?: unknown }[] }
export interface CommandHandler<P = unknown> {
  type: string; schema: ZodType<P>; permission?: Permission;
  /** Throw an HttpException (4xx) for a business refusal: the command is recorded as rejected and its partial effects are rolled back. */
  handle(ctx: CommandContext, payload: P): Promise<HandlerOutput>;
}

@Injectable()
export class CommandRegistry implements OnModuleInit {
  private handlers = new Map<string, CommandHandler<any>>();
  constructor(@Inject(LedgerService) private ledger: LedgerService) {}
  register<P>(h: CommandHandler<P>) { this.handlers.set(h.type, h); }
  get(type: string) { return this.handlers.get(type); }

  onModuleInit() {
    // Handheld stock adjustment from the POS (S12). Sales, cash, refunds and punches register their own handlers in M5-M6.
    this.register({
      type: "stock.adjust", permission: "inventory:write",
      schema: z.object({ variantId: z.string().uuid(), qtyDelta: z.number().int().refine((n) => n !== 0).refine((n) => Math.abs(n) <= 100_000), reason: z.enum(["counting_error", "damaged", "theft_or_shrinkage", "supplier_short_shipment", "found", "other"]) }),
      handle: async (ctx, p) => {
        const r = await this.ledger.appendIn(ctx.tx, ctx.orgId, ctx.actorId, [{ variantId: p.variantId, locationId: ctx.device.locationId, qtyDelta: p.qtyDelta, kind: "manual_adjust", sourceType: "sync.stock.adjust", sourceId: ctx.commandId, reason: p.reason, at: ctx.at, deviceId: ctx.device.id }]);
        return { result: { applied: r.applied } };
      },
    });
  }
}
