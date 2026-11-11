import { z } from "zod";

/** Wire contract between POS (and its simulator) and the API. Bump SCHEMA_V when a command's payload changes incompatibly. */
export const SCHEMA_V = 1;
export const MIN_SCHEMA_V = 1;

export const Command = z.object({
  id: z.string().uuid(),                 // UUIDv7 from the device: the idempotency key
  seq: z.number().int().min(1),          // per-device sequence, gapless
  type: z.string().min(1).max(64),
  payload: z.unknown(),
  clientTs: z.string().datetime({ offset: true }),
  schemaV: z.number().int().min(0),   // 0 is accepted on the wire so the server can answer update_required
  actorId: z.string().uuid(),            // who did it at the device (a cashier signed in with a PIN)
});
export type Command = z.infer<typeof Command>;

export const PushRequest = z.object({ deviceNow: z.string().datetime({ offset: true }), commands: z.array(Command).min(1).max(100), /** Commands still waiting on the device after this batch. */ queued: z.number().int().min(0).max(1_000_000).optional() });
export type PushRequest = z.infer<typeof PushRequest>;

export type CommandStatus = "accepted" | "accepted_flagged" | "rejected" | "duplicate" | "gap";
export interface CommandResult {
  id: string; seq: number; status: CommandStatus;
  reason?: string; detail?: unknown;     // rejected: reason is a stable code
  flags?: string[];                      // accepted_flagged: anomalies the server recorded as exceptions
  result?: unknown;                      // handler output
}
export interface PushResponse {
  serverTime: string; skewMs: number;
  results: CommandResult[];
  expectedSeq: number;                   // the next device_seq the server will accept
  halted?: boolean;                      // a command hit an unexpected server error; resend from expectedSeq later
}

export type ReplicaEntityType = "customer" | "product" | "variant" | "category" | "tax_class" | "tax_rate" | "stock_balance" | "location" | "register" | "price_book" | "price_book_entry" | "promotion";
export interface ReplicaItem { type: ReplicaEntityType; id: string; op: "upsert" | "delete"; data?: Record<string, unknown> }
export interface PullResponse { cursor: string; items: ReplicaItem[]; hasMore: boolean; serverTime: string }
export interface SnapshotResponse { cursor: string | null; items: ReplicaItem[]; next: string | null; serverTime: string }

/** Cursor format "<txid>:<seq>" (see TECH-SPEC 5.1). "0:0" means "from the beginning". */
export const INITIAL_CURSOR = "0:0";

// ---- command payloads (M5): shared by the POS that builds them and the API that validates them
const uuid = z.string().uuid();
const money = z.number().int().min(0).max(1_000_000_000);
export const SessionOpen = z.object({ sessionId: uuid, openingFloatMinor: money, countBreakdown: z.record(z.string(), z.number().int().min(0)).optional() });
export type SessionOpen = z.infer<typeof SessionOpen>;
export const CustomerCreate = z.object({ customerId: uuid, name: z.string().trim().min(1).max(120), email: z.string().email().max(200).optional(), phone: z.string().max(40).optional(), marketingConsent: z.object({ email: z.boolean().optional(), sms: z.boolean().optional() }).optional() });
export type CustomerCreate = z.infer<typeof CustomerCreate>;
export const SALE_TENDERS = ["cash", "card", "other", "gift_card", "store_credit"] as const;
export const SaleCreate = z.object({
  saleId: uuid, sessionId: uuid, receiptNo: z.string().min(1).max(32), customerId: uuid.nullable(),
  lines: z.array(z.object({ variantId: uuid, qty: z.number().int().min(1).max(999), unitPriceMinor: money, discountMinor: money, discountReason: z.string().max(120).optional(), approvalToken: z.string().max(2000).optional(), priceBookId: uuid.nullable().optional(), promoDiscountMinor: money.optional(), promotionIds: z.array(uuid).max(10).optional() })).min(1).max(200),
  payments: z.array(z.object({ tender: z.enum(SALE_TENDERS), amountMinor: z.number().int().min(1).max(1_000_000_000), tenderedMinor: money.optional(), reference: z.string().max(80).optional() })).min(1).max(8),
  totals: z.object({ subtotalMinor: money, discountMinor: money, taxMinor: money, totalMinor: money, roundingMinor: z.number().int().min(-10).max(10), payableMinor: money }),
  cashRoundingStep: z.number().int().min(1).max(100).nullable(), catalogVersion: z.number().int().optional(), pricingVersion: z.number().int().min(0).optional(),
  /** An online order being collected with this sale. */
  onlineOrderId: uuid.optional(),
});
export type SaleCreate = z.infer<typeof SaleCreate>;

export const CASH_KINDS = ["pay_in", "pay_out", "drop", "float_add", "no_sale"] as const;
export const CashMove = z.object({ movementId: uuid, sessionId: uuid, kind: z.enum(CASH_KINDS), amountMinor: money, reason: z.string().trim().max(120).optional() });
export type CashMove = z.infer<typeof CashMove>;
export const SessionClose = z.object({ sessionId: uuid, countedMinor: money, countBreakdown: z.record(z.string(), z.number().int().min(0)).optional(), approvalToken: z.string().max(2000).optional() });
export type SessionClose = z.infer<typeof SessionClose>;
export const REFUND_REASONS = ["changed_mind", "faulty", "wrong_size", "other"] as const;
export const RefundCreate = z.object({
  refundId: uuid, saleId: uuid, sessionId: uuid, tender: z.enum(SALE_TENDERS), reason: z.enum(REFUND_REASONS),
  lines: z.array(z.object({ saleLineNo: z.number().int().min(0), qty: z.number().int().min(1).max(999), amountMinor: money, taxMinor: money, restock: z.boolean() })).min(1).max(200),
  totalMinor: money, approvalToken: z.string().max(2000).optional(),
});
export type RefundCreate = z.infer<typeof RefundCreate>;
export const PunchRecord = z.object({ punchId: uuid, kind: z.enum(["in", "out"]), method: z.enum(["pin"]) });
export type PunchRecord = z.infer<typeof PunchRecord>;
export const APPROVAL_KINDS = ["discount", "variance", "refund"] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];
