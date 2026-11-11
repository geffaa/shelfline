import { sql } from "drizzle-orm";
import { bigint, bigserial, customType, boolean, char, check, index, integer, jsonb, pgSchema, text, time, timestamp, unique, uniqueIndex, uuid, date } from "drizzle-orm/pg-core";

export const shelfline = pgSchema("shelfline");
const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const org = shelfline.table("org", {
  id: id(), name: text("name").notNull(), slug: text("slug").notNull().unique("org_slug_uq"), currency: char("currency", { length: 3 }).notNull(),
  timezoneDefault: text("timezone_default").notNull(), createdAt: createdAt(),
});

export const location = shelfline.table("location", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id),
  code: text("code").notNull(), name: text("name").notNull(),
  type: text("type").notNull(), timezone: text("timezone").notNull(),
  dayCutoff: time("day_cutoff").notNull().default("04:00"),
  taxRegion: text("tax_region"), pickupEnabled: boolean("pickup_enabled").notNull().default(false), cashierDiscountLimitBp: integer("cashier_discount_limit_bp").notNull().default(1000), giftCardOffline: boolean("gift_card_offline").notNull().default(false), giftCardOfflineCapMinor: integer("gift_card_offline_cap_minor").notNull().default(5000), cashierRefundLimitMinor: integer("cashier_refund_limit_minor").notNull().default(20000), cashVarianceLimitMinor: integer("cash_variance_limit_minor").notNull().default(500), status: text("status").notNull().default("active"), createdAt: createdAt(),
}, (t) => [
  unique("location_org_code_uq").on(t.orgId, t.code),
  check("location_type_chk", sql`${t.type} in ('store','warehouse','transit','virtual')`),
  check("location_status_chk", sql`${t.status} in ('active','inactive')`),
]);

export const register = shelfline.table("register", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id),
  locationId: uuid("location_id").notNull().references(() => location.id),
  code: text("code").notNull(), name: text("name").notNull(), status: text("status").notNull().default("active"), createdAt: createdAt(),
}, (t) => [unique("register_org_code_uq").on(t.orgId, t.code), check("register_status_chk", sql`${t.status} in ('active','inactive')`)]);

export const user = shelfline.table("user", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id),
  email: text("email").notNull(), name: text("name").notNull(), passwordHash: text("password_hash"),
  totpSecretEnc: text("totp_secret_enc"), totpEnabled: boolean("totp_enabled").notNull().default(false),
  status: text("status").notNull().default("active"), portalOnly: boolean("portal_only").notNull().default(false), createdAt: createdAt(),
}, (t) => [
  uniqueIndex("user_org_email_uq").on(t.orgId, sql`lower(${t.email})`),
  check("user_status_chk", sql`${t.status} in ('active','disabled')`),
]);

export const device = shelfline.table("device", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id),
  kind: text("kind").notNull(), locationId: uuid("location_id").notNull().references(() => location.id),
  registerId: uuid("register_id").references(() => register.id), name: text("name").notNull(), serial: text("serial"),
  keyHash: text("key_hash").notNull(), lastSeenAt: timestamp("last_seen_at", { withTimezone: true }), clockSkewMs: integer("clock_skew_ms"), lastSeq: bigint("last_seq", { mode: "number" }).notNull().default(0),
  /** What the till said it still had unsent after its last push; nothing is known about a till that has not pushed since. */
  queuedCount: integer("queued_count").notNull().default(0), queuedAt: timestamp("queued_at", { withTimezone: true }),
  status: text("status").notNull().default("active"), createdAt: createdAt(),
}, (t) => [
  uniqueIndex("device_key_hash_uq").on(t.keyHash),
  check("device_kind_chk", sql`${t.kind} in ('pos','bridge','terminal','printer')`),
  check("device_status_chk", sql`${t.status} in ('active','revoked')`),
]);

export const staffProfile = shelfline.table("staff_profile", {
  userId: uuid("user_id").primaryKey().references(() => user.id),
  orgId: uuid("org_id").notNull().references(() => org.id),
  employeeCode: text("employee_code").notNull(), pinHash: text("pin_hash"),
  pinAttempts: integer("pin_attempts").notNull().default(0), pinLockedUntil: timestamp("pin_locked_until", { withTimezone: true }),
  terminalPersonCode: text("terminal_person_code"), hiredOn: date("hired_on"), endedOn: date("ended_on"),
}, (t) => [unique("staff_org_code_uq").on(t.orgId, t.employeeCode)]);

export const role = shelfline.table("role", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id),
  key: text("key").notNull(), name: text("name").notNull(), system: boolean("system").notNull().default(false),
}, (t) => [unique("role_org_key_uq").on(t.orgId, t.key)]);

export const rolePermission = shelfline.table("role_permission", {
  roleId: uuid("role_id").notNull().references(() => role.id, { onDelete: "cascade" }),
  permission: text("permission").notNull(),
}, (t) => [unique("role_permission_uq").on(t.roleId, t.permission)]);

export const userAssignment = shelfline.table("user_assignment", {
  id: id(), userId: uuid("user_id").notNull().references(() => user.id),
  roleId: uuid("role_id").notNull().references(() => role.id),
  locationId: uuid("location_id").references(() => location.id), // null = all locations
  createdAt: createdAt(),
}, (t) => [unique("user_assignment_uq").on(t.userId, t.roleId, t.locationId).nullsNotDistinct(), index("user_assignment_user_idx").on(t.userId)]);

export const auditLog = shelfline.table("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(), orgId: uuid("org_id").notNull(),
  actorId: uuid("actor_id"), actorKind: text("actor_kind").notNull().default("user"),
  action: text("action").notNull(), subjectType: text("subject_type"), subjectId: text("subject_id"),
  before: jsonb("before"), after: jsonb("after"), detail: jsonb("detail"),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(), ip: text("ip"), deviceId: uuid("device_id"),
}, (t) => [index("audit_org_at_idx").on(t.orgId, t.at), index("audit_action_idx").on(t.orgId, t.action)]);

// ---------------------------------------------------------------- catalogue (M2)
export const category = shelfline.table("category", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), name: text("name").notNull(), createdAt: createdAt(),
}, (t) => [uniqueIndex("category_org_name_uq").on(t.orgId, sql`lower(${t.name})`)]);

export const taxClass = shelfline.table("tax_class", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), key: text("key").notNull(), name: text("name").notNull(),
}, (t) => [unique("tax_class_org_key_uq").on(t.orgId, t.key)]);

/** Effective-dated rates. A GiST exclusion constraint (migration 0003) forbids overlapping ranges per class and region. */
export const taxRate = shelfline.table("tax_rate", {
  id: id(), taxClassId: uuid("tax_class_id").notNull().references(() => taxClass.id),
  region: text("region"), rateBp: integer("rate_bp").notNull(), taxInclusive: boolean("tax_inclusive").notNull(),
  validFrom: date("valid_from").notNull(), validTo: date("valid_to"), createdAt: createdAt(),
}, (t) => [check("tax_rate_bp_chk", sql`${t.rateBp} between 0 and 10000`), check("tax_rate_range_chk", sql`${t.validTo} is null or ${t.validTo} > ${t.validFrom}`)]);

export const product = shelfline.table("product", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), title: text("title").notNull(),
  categoryId: uuid("category_id").references(() => category.id), taxClassId: uuid("tax_class_id").notNull().references(() => taxClass.id),
  brand: text("brand"), status: text("status").notNull().default("active"), version: bigint("version", { mode: "number" }).notNull(),
  createdAt: createdAt(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check("product_status_chk", sql`${t.status} in ('active','archived')`), index("product_org_title_idx").on(t.orgId, sql`lower(${t.title})`)]);

export const variant = shelfline.table("variant", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), productId: uuid("product_id").notNull().references(() => product.id),
  sku: text("sku").notNull(), barcode: text("barcode"), options: jsonb("options").notNull().default(sql`'{}'::jsonb`),
  basePriceMinor: integer("base_price_minor").notNull(), costMinor: integer("cost_minor"), trackStock: boolean("track_stock").notNull().default(true),
  status: text("status").notNull().default("active"), version: bigint("version", { mode: "number" }).notNull(),
  createdAt: createdAt(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("variant_org_sku_uq").on(t.orgId, sql`lower(btrim(${t.sku}))`),
  uniqueIndex("variant_org_barcode_uq").on(t.orgId, t.barcode).where(sql`${t.barcode} is not null`),
  check("variant_price_chk", sql`${t.basePriceMinor} >= 0`), check("variant_status_chk", sql`${t.status} in ('active','archived')`),
  index("variant_product_idx").on(t.productId),
]);

/** One row per org; seq increases on every catalogue write and is stamped on changed rows (used by sync pull in M4). */
export const catalogVersion = shelfline.table("catalog_version", {
  orgId: uuid("org_id").primaryKey().references(() => org.id), seq: bigint("seq", { mode: "number" }).notNull().default(0),
});

// ---------------------------------------------------------------- stock ledger (M3)
export const MOVEMENT_KINDS = ["sale", "refund_return", "receive_po", "manual_receive", "transfer_out", "transfer_in", "transfer_variance", "count_adjust", "manual_adjust", "write_off", "online_reserve", "online_release", "opening_balance"] as const;

/** Append-only (trigger in migration 0005). The only way stock changes. */
export const stockMovement = shelfline.table("stock_movement", {
  id: bigserial("id", { mode: "number" }).primaryKey(), orgId: uuid("org_id").notNull().references(() => org.id),
  variantId: uuid("variant_id").notNull().references(() => variant.id), locationId: uuid("location_id").notNull().references(() => location.id),
  qtyDelta: integer("qty_delta").notNull(), kind: text("kind").notNull(),
  sourceType: text("source_type").notNull(), sourceId: text("source_id").notNull(), lineNo: integer("line_no").notNull().default(0),
  unitCostMinor: integer("unit_cost_minor"), reason: text("reason"), note: text("note"),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(), localDate: date("local_date").notNull(),
  deviceId: uuid("device_id"), actorId: uuid("actor_id"), flags: text("flags").array().notNull().default(sql`'{}'::text[]`),
}, (t) => [
  unique("stock_movement_source_uq").on(t.orgId, t.sourceType, t.sourceId, t.lineNo, t.kind),
  index("stock_movement_card_idx").on(t.variantId, t.locationId, t.id),
  check("stock_movement_nonzero_chk", sql`${t.qtyDelta} <> 0`),
  check("stock_movement_kind_chk", sql`${t.kind} in ('sale','refund_return','receive_po','manual_receive','transfer_out','transfer_in','transfer_variance','count_adjust','manual_adjust','write_off','online_reserve','online_release','opening_balance')`),
]);

/** Projection of the ledger, updated in the same transaction as each movement. on_hand = SUM(qty_delta) is checked by the invariant job. */
export const stockBalance = shelfline.table("stock_balance", {
  orgId: uuid("org_id").notNull().references(() => org.id),
  variantId: uuid("variant_id").notNull().references(() => variant.id), locationId: uuid("location_id").notNull().references(() => location.id),
  onHand: integer("on_hand").notNull().default(0), reserved: integer("reserved").notNull().default(0), incoming: integer("incoming").notNull().default(0),
  avgCostMinor: integer("avg_cost_minor"), version: bigint("version", { mode: "number" }).notNull().default(0),
}, (t) => [unique("stock_balance_pk").on(t.variantId, t.locationId)]);

// ---------------------------------------------------------------- sync (M4)
const xid8 = customType<{ data: string; driverData: string }>({ dataType: () => "xid8" });

/** Written by triggers in the same transaction as the change. Pull orders by (txid, seq) and only serves txid < pg_snapshot_xmin. */
export const changeLog = shelfline.table("change_log", {
  seq: bigserial("seq", { mode: "number" }).primaryKey(), txid: xid8("txid").notNull().default(sql`pg_current_xact_id()`),
  orgId: uuid("org_id").notNull(), entityType: text("entity_type").notNull(), entityId: text("entity_id").notNull(),
  op: text("op").notNull(), locationId: uuid("location_id"),
}, (t) => [index("change_log_order_idx").on(t.orgId, t.txid, t.seq), check("change_log_op_chk", sql`${t.op} in ('upsert','delete')`)]);

export const syncCommandReceipt = shelfline.table("sync_command_receipt", {
  commandId: uuid("command_id").primaryKey(), orgId: uuid("org_id").notNull(), deviceId: uuid("device_id").notNull().references(() => device.id),
  deviceSeq: bigint("device_seq", { mode: "number" }).notNull(), type: text("type").notNull(), actorId: uuid("actor_id"),
  status: text("status").notNull(), reason: text("reason"), result: jsonb("result"), flags: text("flags").array().notNull().default(sql`'{}'::text[]`),
  clientTs: timestamp("client_ts", { withTimezone: true }), effectiveAt: timestamp("effective_at", { withTimezone: true }), receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("sync_receipt_device_seq_uq").on(t.deviceId, t.deviceSeq), check("sync_receipt_status_chk", sql`${t.status} in ('accepted','accepted_flagged','rejected')`)]);

export const syncException = shelfline.table("sync_exception", {
  id: id(), orgId: uuid("org_id").notNull(), kind: text("kind").notNull(), refType: text("ref_type"), refId: text("ref_id"),
  deviceId: uuid("device_id"), commandId: uuid("command_id"), detail: jsonb("detail"), status: text("status").notNull().default("open"),
  createdAt: createdAt(), resolvedBy: uuid("resolved_by"), resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (t) => [index("sync_exception_open_idx").on(t.orgId, t.status), check("sync_exception_status_chk", sql`${t.status} in ('open','resolved')`)]);

// ---------------------------------------------------------------- selling (M5)
export const customer = shelfline.table("customer", {
  id: uuid("id").primaryKey(), orgId: uuid("org_id").notNull().references(() => org.id), name: text("name").notNull(),
  email: text("email"), phone: text("phone"), marketingConsent: jsonb("marketing_consent").notNull().default(sql`'{}'::jsonb`), notes: text("notes"), birthMonth: integer("birth_month"), birthDay: integer("birth_day"),
  createdAt: createdAt(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check("customer_birthday_chk", sql`(${t.birthMonth} is null and ${t.birthDay} is null) or (${t.birthMonth} between 1 and 12 and ${t.birthDay} between 1 and 31)`), uniqueIndex("customer_org_email_uq").on(t.orgId, sql`lower(${t.email})`).where(sql`${t.email} is not null`)]);

export const registerSession = shelfline.table("register_session", {
  id: uuid("id").primaryKey(), orgId: uuid("org_id").notNull().references(() => org.id),
  registerId: uuid("register_id").notNull().references(() => register.id), locationId: uuid("location_id").notNull().references(() => location.id),
  openedBy: uuid("opened_by").notNull(), openedAt: timestamp("opened_at", { withTimezone: true }).notNull(), openingFloatMinor: integer("opening_float_minor").notNull(),
  status: text("status").notNull().default("open"), closedBy: uuid("closed_by"), closedAt: timestamp("closed_at", { withTimezone: true }),
  countedCloseMinor: integer("counted_close_minor"), expectedCloseMinor: integer("expected_close_minor"), varianceMinor: integer("variance_minor"),
  countBreakdown: jsonb("count_breakdown"), flags: text("flags").array().notNull().default(sql`'{}'::text[]`),
  reviewedBy: uuid("reviewed_by"), reviewedAt: timestamp("reviewed_at", { withTimezone: true }), reviewNote: text("review_note"),
}, (t) => [
  uniqueIndex("register_session_one_open_uq").on(t.registerId).where(sql`${t.status} = 'open'`),
  check("register_session_status_chk", sql`${t.status} in ('open','closed','force_closed')`),
]);

export const sale = shelfline.table("sale", {
  id: uuid("id").primaryKey(), orgId: uuid("org_id").notNull().references(() => org.id), receiptNo: text("receipt_no").notNull(),
  sessionId: uuid("session_id").references(() => registerSession.id), registerId: uuid("register_id").notNull().references(() => register.id),
  locationId: uuid("location_id").notNull().references(() => location.id), cashierId: uuid("cashier_id").notNull(), customerId: uuid("customer_id").references(() => customer.id),
  channel: text("channel").notNull().default("pos"), status: text("status").notNull().default("completed"),
  subtotalMinor: integer("subtotal_minor").notNull(), discountMinor: integer("discount_minor").notNull(), taxMinor: integer("tax_minor").notNull(),
  totalMinor: integer("total_minor").notNull(), roundingMinor: integer("rounding_minor").notNull().default(0), payableMinor: integer("payable_minor").notNull(),
  tenderedMinor: integer("tendered_minor").notNull(), changeMinor: integer("change_minor").notNull().default(0),
  priceSnapshot: jsonb("price_snapshot"), clientTs: timestamp("client_ts", { withTimezone: true }).notNull(), effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(), localDate: date("local_date").notNull(),
  flags: text("flags").array().notNull().default(sql`'{}'::text[]`), deviceId: uuid("device_id"), commandId: uuid("command_id"),
}, (t) => [unique("sale_register_receipt_uq").on(t.registerId, t.receiptNo), index("sale_location_date_idx").on(t.locationId, t.localDate), index("sale_session_idx").on(t.sessionId)]);

export const saleLine = shelfline.table("sale_line", {
  saleId: uuid("sale_id").notNull().references(() => sale.id), lineNo: integer("line_no").notNull(), variantId: uuid("variant_id").notNull().references(() => variant.id),
  qty: integer("qty").notNull(), unitPriceMinor: integer("unit_price_minor").notNull(), discountMinor: integer("discount_minor").notNull().default(0),
  discountReason: text("discount_reason"), approvedBy: uuid("approved_by"), priceBookId: uuid("price_book_id"), promoDiscountMinor: integer("promo_discount_minor").notNull().default(0), promotionIds: uuid("promotion_ids").array().notNull().default(sql`'{}'::uuid[]`), taxRateBp: integer("tax_rate_bp").notNull(), taxInclusive: boolean("tax_inclusive").notNull(),
  taxMinor: integer("tax_minor").notNull(), totalMinor: integer("total_minor").notNull(), unitCostMinor: integer("unit_cost_minor"), attributedTo: uuid("attributed_to").notNull(),
  refundedQty: integer("refunded_qty").notNull().default(0), refundedMinor: integer("refunded_minor").notNull().default(0), refundedTaxMinor: integer("refunded_tax_minor").notNull().default(0),
}, (t) => [unique("sale_line_pk").on(t.saleId, t.lineNo), check("sale_line_qty_chk", sql`${t.qty} > 0`)]);

export const payment = shelfline.table("payment", {
  id: bigserial("id", { mode: "number" }).primaryKey(), saleId: uuid("sale_id").notNull().references(() => sale.id), tender: text("tender").notNull(),
  amountMinor: integer("amount_minor").notNull(), changeMinor: integer("change_minor").notNull().default(0), reference: text("reference"),
}, (t) => [index("payment_sale_idx").on(t.saleId), check("payment_tender_chk", sql`${t.tender} in ('cash','card','gift_card','store_credit','other')`)]);

// ---------------------------------------------------------------- cash, refunds, punches (M6)
export const cashMovement = shelfline.table("cash_movement", {
  id: uuid("id").primaryKey(), orgId: uuid("org_id").notNull().references(() => org.id), sessionId: uuid("session_id").references(() => registerSession.id),
  registerId: uuid("register_id").notNull().references(() => register.id), locationId: uuid("location_id").notNull().references(() => location.id),
  kind: text("kind").notNull(), amountMinor: integer("amount_minor").notNull(), reason: text("reason"), actorId: uuid("actor_id").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull(), localDate: date("local_date").notNull(), flags: text("flags").array().notNull().default(sql`'{}'::text[]`), deviceId: uuid("device_id"), commandId: uuid("command_id"),
}, (t) => [index("cash_movement_session_idx").on(t.sessionId), index("cash_movement_loc_date_idx").on(t.locationId, t.localDate),
  check("cash_movement_kind_chk", sql`${t.kind} in ('pay_in','pay_out','drop','float_add','no_sale')`), check("cash_movement_amount_chk", sql`${t.amountMinor} >= 0 and (${t.kind} <> 'no_sale' or ${t.amountMinor} = 0)`)]);

export const refund = shelfline.table("refund", {
  id: uuid("id").primaryKey(), orgId: uuid("org_id").notNull().references(() => org.id), saleId: uuid("sale_id").notNull().references(() => sale.id),
  sessionId: uuid("session_id").references(() => registerSession.id), registerId: uuid("register_id").notNull().references(() => register.id), locationId: uuid("location_id").notNull().references(() => location.id),
  tender: text("tender").notNull(), reason: text("reason").notNull(), totalMinor: integer("total_minor").notNull(), taxMinor: integer("tax_minor").notNull(),
  approvedBy: uuid("approved_by"), actorId: uuid("actor_id").notNull(), at: timestamp("at", { withTimezone: true }).notNull(), localDate: date("local_date").notNull(),
  flags: text("flags").array().notNull().default(sql`'{}'::text[]`), deviceId: uuid("device_id"), commandId: uuid("command_id"),
}, (t) => [index("refund_sale_idx").on(t.saleId), index("refund_session_idx").on(t.sessionId), check("refund_tender_chk", sql`${t.tender} in ('cash','card','other','store_credit')`)]);

export const refundLine = shelfline.table("refund_line", {
  refundId: uuid("refund_id").notNull().references(() => refund.id), lineNo: integer("line_no").notNull(), saleLineNo: integer("sale_line_no").notNull(), variantId: uuid("variant_id").notNull().references(() => variant.id),
  qty: integer("qty").notNull(), amountMinor: integer("amount_minor").notNull(), taxMinor: integer("tax_minor").notNull(), restock: boolean("restock").notNull(),
}, (t) => [unique("refund_line_pk").on(t.refundId, t.lineNo)]);

export const punch = shelfline.table("punch", {
  id: uuid("id").primaryKey(), orgId: uuid("org_id").notNull().references(() => org.id), userId: uuid("user_id").notNull(), locationId: uuid("location_id").notNull().references(() => location.id),
  kind: text("kind").notNull(), method: text("method").notNull(), sourceDeviceId: uuid("source_device_id"), clientTs: timestamp("client_ts", { withTimezone: true }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(), clockSkewMs: integer("clock_skew_ms"), status: text("status").notNull().default("accepted"), supersedesId: uuid("supersedes_id"),
}, (t) => [index("punch_user_idx").on(t.userId, t.clientTs), check("punch_kind_chk", sql`${t.kind} in ('in','out')`), check("punch_status_chk", sql`${t.status} in ('accepted','needs_review')`)]);

// ---------------------------------------------------------------- M9: purchasing and supplier finance
export const PO_STATUSES = ["draft", "sent", "partial", "received", "closed", "cancelled"] as const;
export const BILL_STATUSES = ["held", "open", "partially_paid", "paid", "void"] as const;

export const supplier = shelfline.table("supplier", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id),
  name: text("name").notNull(), contactName: text("contact_name"), email: text("email"), phone: text("phone"),
  termsDays: integer("terms_days").notNull().default(30), leadTimeDays: integer("lead_time_days").notNull().default(7), status: text("status").notNull().default("active"), note: text("note"), createdAt: createdAt(),
}, (t) => [uniqueIndex("supplier_org_name_uq").on(t.orgId, sql`lower(${t.name})`), check("supplier_status_chk", sql`${t.status} in ('active','archived')`), check("supplier_terms_chk", sql`${t.termsDays} between 0 and 365`)]);

export const purchaseOrder = shelfline.table("purchase_order", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id),
  supplierId: uuid("supplier_id").notNull().references(() => supplier.id), locationId: uuid("location_id").notNull().references(() => location.id),
  number: text("number").notNull(), status: text("status").notNull().default("draft"), expectedOn: date("expected_on"), note: text("note"),
  createdBy: uuid("created_by").references(() => user.id), createdAt: createdAt(), sentAt: timestamp("sent_at", { withTimezone: true }), closedAt: timestamp("closed_at", { withTimezone: true }),
}, (t) => [unique("po_org_number_uq").on(t.orgId, t.number), index("po_supplier_idx").on(t.supplierId), check("po_status_chk", sql`${t.status} in ('draft','sent','partial','received','closed','cancelled')`)]);

export const poLine = shelfline.table("po_line", {
  id: id(), poId: uuid("po_id").notNull().references(() => purchaseOrder.id), lineNo: integer("line_no").notNull(),
  variantId: uuid("variant_id").notNull().references(() => variant.id), qtyOrdered: integer("qty_ordered").notNull(), qtyReceived: integer("qty_received").notNull().default(0),
  unitCostMinor: integer("unit_cost_minor").notNull(),
}, (t) => [unique("po_line_no_uq").on(t.poId, t.lineNo), unique("po_line_variant_uq").on(t.poId, t.variantId), check("po_line_qty_chk", sql`${t.qtyOrdered} > 0 and ${t.qtyReceived} between 0 and ${t.qtyOrdered}`), check("po_line_cost_chk", sql`${t.unitCostMinor} >= 0`)]);

export const receipt = shelfline.table("receipt", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), poId: uuid("po_id").notNull().references(() => purchaseOrder.id),
  supplierId: uuid("supplier_id").notNull().references(() => supplier.id), locationId: uuid("location_id").notNull().references(() => location.id),
  number: text("number").notNull(), idempotencyKey: uuid("idempotency_key").notNull(), freightMinor: integer("freight_minor").notNull().default(0), otherCostMinor: integer("other_cost_minor").notNull().default(0),
  note: text("note"), receivedBy: uuid("received_by").references(() => user.id), receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("receipt_org_number_uq").on(t.orgId, t.number), unique("receipt_idem_uq").on(t.orgId, t.idempotencyKey), check("receipt_cost_chk", sql`${t.freightMinor} >= 0 and ${t.otherCostMinor} >= 0`)]);

/** landed_alloc_minor is this line's share of freight + other costs (largest-remainder by line value); the ledger receives (qty*unit + alloc) / qty per unit. */
export const receiptLine = shelfline.table("receipt_line", {
  id: id(), receiptId: uuid("receipt_id").notNull().references(() => receipt.id), lineNo: integer("line_no").notNull(),
  poLineId: uuid("po_line_id").notNull().references(() => poLine.id), variantId: uuid("variant_id").notNull().references(() => variant.id),
  qty: integer("qty").notNull(), unitCostMinor: integer("unit_cost_minor").notNull(), landedAllocMinor: integer("landed_alloc_minor").notNull().default(0), landedUnitCostMinor: integer("landed_unit_cost_minor").notNull(),
}, (t) => [unique("receipt_line_no_uq").on(t.receiptId, t.lineNo), index("receipt_line_po_idx").on(t.poLineId), check("receipt_line_qty_chk", sql`${t.qty} > 0`)]);

export const supplierBill = shelfline.table("supplier_bill", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), supplierId: uuid("supplier_id").notNull().references(() => supplier.id),
  poId: uuid("po_id").references(() => purchaseOrder.id), number: text("number").notNull(), billDate: date("bill_date").notNull(), dueOn: date("due_on").notNull(),
  totalMinor: integer("total_minor").notNull(), paidMinor: integer("paid_minor").notNull().default(0), status: text("status").notNull(), holdReasons: text("hold_reasons").array().notNull().default(sql`'{}'::text[]`),
  approvedBy: uuid("approved_by").references(() => user.id), approvedNote: text("approved_note"), approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdBy: uuid("created_by").references(() => user.id), createdAt: createdAt(),
}, (t) => [uniqueIndex("bill_supplier_number_uq").on(t.orgId, t.supplierId, sql`lower(${t.number})`), index("bill_due_idx").on(t.orgId, t.dueOn),
  check("bill_status_chk", sql`${t.status} in ('held','open','partially_paid','paid','void')`), check("bill_paid_chk", sql`${t.paidMinor} between 0 and ${t.totalMinor}`)]);

export const billLine = shelfline.table("bill_line", {
  id: id(), billId: uuid("bill_id").notNull().references(() => supplierBill.id), lineNo: integer("line_no").notNull(),
  poLineId: uuid("po_line_id").references(() => poLine.id), variantId: uuid("variant_id").references(() => variant.id), description: text("description").notNull(),
  qty: integer("qty").notNull(), unitCostMinor: integer("unit_cost_minor").notNull(), totalMinor: integer("total_minor").notNull(),
}, (t) => [unique("bill_line_no_uq").on(t.billId, t.lineNo)]);

/** One row per bill line tied to a PO line: what was billed against what had been received (cumulative) and at what price. */
export const billReceiptMatch = shelfline.table("bill_receipt_match", {
  id: id(), billId: uuid("bill_id").notNull().references(() => supplierBill.id), billLineId: uuid("bill_line_id").notNull().references(() => billLine.id), poLineId: uuid("po_line_id").notNull().references(() => poLine.id),
  billedQty: integer("billed_qty").notNull(), billedQtyToDate: integer("billed_qty_to_date").notNull(), receivedQty: integer("received_qty").notNull(), qtyDiff: integer("qty_diff").notNull(),
  billedUnitMinor: integer("billed_unit_minor").notNull(), orderedUnitMinor: integer("ordered_unit_minor").notNull(), costDiffMinor: integer("cost_diff_minor").notNull(), status: text("status").notNull(),
}, (t) => [unique("bill_match_line_uq").on(t.billLineId), check("bill_match_status_chk", sql`${t.status} in ('ok','over_billed','price_variance','both')`)]);

export const billPayment = shelfline.table("bill_payment", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), billId: uuid("bill_id").notNull().references(() => supplierBill.id),
  amountMinor: integer("amount_minor").notNull(), paidOn: date("paid_on").notNull(), method: text("method").notNull(), reference: text("reference"),
  idempotencyKey: uuid("idempotency_key").notNull(), createdBy: uuid("created_by").references(() => user.id), createdAt: createdAt(),
}, (t) => [unique("bill_payment_idem_uq").on(t.orgId, t.idempotencyKey), check("bill_payment_amt_chk", sql`${t.amountMinor} > 0`), check("bill_payment_method_chk", sql`${t.method} in ('bank_transfer','card','cash','other')`)]);

// ---------------------------------------------------------------- M10: transfers and stock counts
export const TRANSFER_STATUSES = ["draft", "sent", "partial", "received", "cancelled"] as const;
export const COUNT_STATUSES = ["counting", "review", "committed", "cancelled"] as const;

export const transfer = shelfline.table("transfer", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), number: text("number").notNull(),
  fromLocationId: uuid("from_location_id").notNull().references(() => location.id), toLocationId: uuid("to_location_id").notNull().references(() => location.id),
  transitLocationId: uuid("transit_location_id").references(() => location.id), status: text("status").notNull().default("draft"), note: text("note"),
  createdBy: uuid("created_by").references(() => user.id), createdAt: createdAt(), sentAt: timestamp("sent_at", { withTimezone: true }), sentBy: uuid("sent_by").references(() => user.id), closedAt: timestamp("closed_at", { withTimezone: true }),
}, (t) => [unique("transfer_org_number_uq").on(t.orgId, t.number), index("transfer_status_idx").on(t.orgId, t.status),
  check("transfer_status_chk", sql`${t.status} in ('draft','sent','partial','received','cancelled')`), check("transfer_places_chk", sql`${t.fromLocationId} <> ${t.toLocationId}`)]);

export const transferLine = shelfline.table("transfer_line", {
  id: id(), transferId: uuid("transfer_id").notNull().references(() => transfer.id), lineNo: integer("line_no").notNull(), variantId: uuid("variant_id").notNull().references(() => variant.id),
  qtySent: integer("qty_sent").notNull(), qtyReceived: integer("qty_received").notNull().default(0), qtyVariance: integer("qty_variance").notNull().default(0), unitCostMinor: integer("unit_cost_minor"),
}, (t) => [unique("transfer_line_no_uq").on(t.transferId, t.lineNo), unique("transfer_line_variant_uq").on(t.transferId, t.variantId),
  check("transfer_line_qty_chk", sql`${t.qtySent} > 0 and ${t.qtyReceived} >= 0 and ${t.qtyVariance} >= 0 and ${t.qtyReceived} + ${t.qtyVariance} <= ${t.qtySent}`)]);

export const transferReceipt = shelfline.table("transfer_receipt", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), transferId: uuid("transfer_id").notNull().references(() => transfer.id), idempotencyKey: uuid("idempotency_key").notNull(),
  closedShort: boolean("closed_short").notNull().default(false), note: text("note"), receivedBy: uuid("received_by").references(() => user.id), receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("transfer_receipt_idem_uq").on(t.orgId, t.idempotencyKey)]);

export const transferReceiptLine = shelfline.table("transfer_receipt_line", {
  id: id(), receiptId: uuid("receipt_id").notNull().references(() => transferReceipt.id), transferLineId: uuid("transfer_line_id").notNull().references(() => transferLine.id),
  qtyReceived: integer("qty_received").notNull(), qtyVariance: integer("qty_variance").notNull().default(0),
}, (t) => [unique("transfer_receipt_line_uq").on(t.receiptId, t.transferLineId)]);

export const stockCount = shelfline.table("stock_count", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), locationId: uuid("location_id").notNull().references(() => location.id), number: text("number").notNull(),
  mode: text("mode").notNull(), blind: boolean("blind").notNull().default(true), status: text("status").notNull().default("counting"), note: text("note"), categoryId: uuid("category_id"),
  snapshotAt: timestamp("snapshot_at", { withTimezone: true }).notNull().defaultNow(), snapshotMovementId: bigint("snapshot_movement_id", { mode: "number" }).notNull(),
  createdBy: uuid("created_by").references(() => user.id), createdAt: createdAt(), submittedAt: timestamp("submitted_at", { withTimezone: true }), committedAt: timestamp("committed_at", { withTimezone: true }), committedBy: uuid("committed_by").references(() => user.id),
}, (t) => [unique("stock_count_org_number_uq").on(t.orgId, t.number), index("stock_count_loc_idx").on(t.orgId, t.locationId),
  check("stock_count_mode_chk", sql`${t.mode} in ('full','cycle')`), check("stock_count_status_chk", sql`${t.status} in ('counting','review','committed','cancelled')`)]);

export const stockCountLine = shelfline.table("stock_count_line", {
  id: id(), countId: uuid("count_id").notNull().references(() => stockCount.id), variantId: uuid("variant_id").notNull().references(() => variant.id),
  expectedAtSnapshot: integer("expected_at_snapshot").notNull(), countedQty: integer("counted_qty"), unexpected: boolean("unexpected").notNull().default(false),
  countedBy: uuid("counted_by").references(() => user.id), countedAt: timestamp("counted_at", { withTimezone: true }),
}, (t) => [unique("stock_count_line_uq").on(t.countId, t.variantId), check("stock_count_line_qty_chk", sql`${t.countedQty} is null or ${t.countedQty} >= 0`)]);

// ---------------------------------------------------------------- M11: price books and promotions
export const priceBook = shelfline.table("price_book", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), name: text("name").notNull(), priority: integer("priority").notNull().default(100),
  validFrom: date("valid_from"), validTo: date("valid_to"), status: text("status").notNull().default("active"), version: integer("version").notNull().default(1), createdAt: createdAt(),
}, (t) => [uniqueIndex("price_book_org_name_uq").on(t.orgId, sql`lower(${t.name})`), check("price_book_status_chk", sql`${t.status} in ('active','archived')`), check("price_book_window_chk", sql`${t.validFrom} is null or ${t.validTo} is null or ${t.validFrom} <= ${t.validTo}`)]);
/** No rows = every location. */
export const priceBookLocation = shelfline.table("price_book_location", {
  priceBookId: uuid("price_book_id").notNull().references(() => priceBook.id), locationId: uuid("location_id").notNull().references(() => location.id),
}, (t) => [unique("price_book_location_pk").on(t.priceBookId, t.locationId)]);
export const priceBookEntry = shelfline.table("price_book_entry", {
  priceBookId: uuid("price_book_id").notNull().references(() => priceBook.id), variantId: uuid("variant_id").notNull().references(() => variant.id), priceMinor: integer("price_minor").notNull(),
}, (t) => [unique("price_book_entry_pk").on(t.priceBookId, t.variantId), check("price_book_entry_chk", sql`${t.priceMinor} >= 0`)]);

export const promotion = shelfline.table("promotion", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), name: text("name").notNull(), kind: text("kind").notNull(), valueBp: integer("value_bp").notNull().default(0), amountMinor: integer("amount_minor").notNull().default(0),
  minQty: integer("min_qty").notNull().default(1), stackable: boolean("stackable").notNull().default(false), validFrom: date("valid_from"), validTo: date("valid_to"), status: text("status").notNull().default("active"), version: integer("version").notNull().default(1), createdAt: createdAt(),
}, (t) => [uniqueIndex("promotion_org_name_uq").on(t.orgId, sql`lower(${t.name})`), check("promotion_kind_chk", sql`${t.kind} in ('percent','amount_off')`), check("promotion_status_chk", sql`${t.status} in ('active','archived')`),
  check("promotion_value_chk", sql`(${t.kind} = 'percent' and ${t.valueBp} between 1 and 10000 and ${t.amountMinor} = 0) or (${t.kind} = 'amount_off' and ${t.amountMinor} > 0 and ${t.valueBp} = 0)`), check("promotion_minqty_chk", sql`${t.minQty} >= 1`),
  check("promotion_window_chk", sql`${t.validFrom} is null or ${t.validTo} is null or ${t.validFrom} <= ${t.validTo}`)]);
/** No rows = every variant / every location. */
export const promotionVariant = shelfline.table("promotion_variant", { promotionId: uuid("promotion_id").notNull().references(() => promotion.id), variantId: uuid("variant_id").notNull().references(() => variant.id) }, (t) => [unique("promotion_variant_pk").on(t.promotionId, t.variantId)]);
export const promotionLocation = shelfline.table("promotion_location", { promotionId: uuid("promotion_id").notNull().references(() => promotion.id), locationId: uuid("location_id").notNull().references(() => location.id) }, (t) => [unique("promotion_location_pk").on(t.promotionId, t.locationId)]);

// ---------------------------------------------------------------- M12: gift cards and store credit
/** The code itself is never stored: only a hash (to find the card) and the last four characters (to recognise it). */
export const giftCard = shelfline.table("gift_card", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), codeHash: text("code_hash").notNull(), codeLast4: text("code_last4").notNull(), status: text("status").notNull().default("active"),
  customerId: uuid("customer_id").references(() => customer.id), expiresOn: date("expires_on"), note: text("note"), issuedBy: uuid("issued_by").references(() => user.id), createdAt: createdAt(),
}, (t) => [unique("gift_card_code_uq").on(t.orgId, t.codeHash), check("gift_card_status_chk", sql`${t.status} in ('active','void')`)]);

/** Append-only. A balance is the SUM of an account's entries; it is never stored, so it cannot drift. A negative sum is an overdraft. */
export const balanceEntry = shelfline.table("balance_entry", {
  id: bigserial("id", { mode: "number" }).primaryKey(), orgId: uuid("org_id").notNull().references(() => org.id), accountType: text("account_type").notNull(), accountId: uuid("account_id").notNull(),
  deltaMinor: integer("delta_minor").notNull(), kind: text("kind").notNull(), sourceType: text("source_type").notNull(), sourceId: text("source_id").notNull(), lineNo: integer("line_no").notNull().default(0),
  locationId: uuid("location_id"), deviceId: uuid("device_id"), actorId: uuid("actor_id"), note: text("note"), at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("balance_entry_source_uq").on(t.orgId, t.sourceType, t.sourceId, t.lineNo, t.kind), index("balance_entry_account_idx").on(t.accountType, t.accountId, t.id),
  check("balance_entry_type_chk", sql`${t.accountType} in ('gift_card','store_credit')`), check("balance_entry_kind_chk", sql`${t.kind} in ('issue','topup','redeem','refund_credit','adjust')`), check("balance_entry_nonzero_chk", sql`${t.deltaMinor} <> 0`)]);

// ---------------------------------------------------------------- M13: schedule and timesheets
export const shiftTemplate = shelfline.table("shift_template", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), locationId: uuid("location_id").references(() => location.id), name: text("name").notNull(),
  startTime: text("start_time").notNull(), endTime: text("end_time").notNull(), role: text("role"), breakMinutes: integer("break_minutes").notNull().default(0), createdAt: createdAt(),
}, (t) => [uniqueIndex("shift_template_name_uq").on(t.orgId, sql`lower(${t.name})`), check("shift_template_time_chk", sql`${t.startTime} ~ '^[0-2][0-9]:[0-5][0-9]$' and ${t.endTime} ~ '^[0-2][0-9]:[0-5][0-9]$' and ${t.startTime} <> ${t.endTime}`)]);

/** starts_at/ends_at are instants computed from the local date and wall-clock times in the location's zone, so a shift across a daylight-saving change has its real length. user_id null = an open shift nobody has taken yet. */
export const shift = shelfline.table("shift", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), locationId: uuid("location_id").notNull().references(() => location.id), userId: uuid("user_id").references(() => user.id),
  localDate: date("local_date").notNull(), startsAt: timestamp("starts_at", { withTimezone: true }).notNull(), endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  role: text("role"), breakMinutes: integer("break_minutes").notNull().default(0), note: text("note"), publishedAt: timestamp("published_at", { withTimezone: true }), createdBy: uuid("created_by").references(() => user.id), createdAt: createdAt(),
}, (t) => [index("shift_loc_date_idx").on(t.locationId, t.localDate), index("shift_user_idx").on(t.userId, t.startsAt), check("shift_span_chk", sql`${t.endsAt} > ${t.startsAt}`), check("shift_break_chk", sql`${t.breakMinutes} between 0 and 480`)]);

export const staffingNeed = shelfline.table("staffing_need", {
  locationId: uuid("location_id").notNull().references(() => location.id), weekday: integer("weekday").notNull(), minStaff: integer("min_staff").notNull(),
}, (t) => [unique("staffing_need_pk").on(t.locationId, t.weekday), check("staffing_need_chk", sql`${t.weekday} between 0 and 6 and ${t.minStaff} between 0 and 50`)]);

/** One worked stretch: an `in` punch to its `out` (or none: a forgotten clock-out). Built from punches; corrections are new punches, never edits. */
export const timesheetEntry = shelfline.table("timesheet_entry", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), userId: uuid("user_id").notNull().references(() => user.id), locationId: uuid("location_id").notNull().references(() => location.id),
  localDate: date("local_date").notNull(), punchInId: uuid("punch_in_id").notNull(), punchOutId: uuid("punch_out_id"), shiftId: uuid("shift_id"),
  inAt: timestamp("in_at", { withTimezone: true }).notNull(), outAt: timestamp("out_at", { withTimezone: true }), breakMinutes: integer("break_minutes").notNull().default(0), workedMinutes: integer("worked_minutes"),
  scheduledMinutes: integer("scheduled_minutes"), lateMinutes: integer("late_minutes").notNull().default(0), varianceMinutes: integer("variance_minutes"), flags: text("flags").array().notNull().default(sql`'{}'::text[]`),
  status: text("status").notNull().default("open"), approvedBy: uuid("approved_by").references(() => user.id), approvedAt: timestamp("approved_at", { withTimezone: true }), createdAt: createdAt(),
}, (t) => [unique("timesheet_in_uq").on(t.userId, t.punchInId), index("timesheet_loc_date_idx").on(t.locationId, t.localDate), check("timesheet_status_chk", sql`${t.status} in ('open','approved')`)]);

// ---------------------------------------------------------------- M14: attendance terminals and the bridge
/** A small LAN program next to the terminals. It pairs once with a short-lived code; afterwards it signs every batch with a key only it and the server can compute. */
export const bridge = shelfline.table("bridge", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), locationId: uuid("location_id").notNull().references(() => location.id), name: text("name").notNull(), status: text("status").notNull().default("pending"),
  pairingCodeHash: text("pairing_code_hash"), pairingExpiresAt: timestamp("pairing_expires_at", { withTimezone: true }), pairedAt: timestamp("paired_at", { withTimezone: true }), lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  lastBatchSize: integer("last_batch_size"), createdAt: createdAt(),
}, (t) => [check("bridge_status_chk", sql`${t.status} in ('pending','active','revoked')`), index("bridge_org_idx").on(t.orgId)]);

/** Network attendance terminal (identity and finger matching live on the device; no template ever reaches us). Registered by serial number. */
export const terminal = shelfline.table("terminal", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), locationId: uuid("location_id").notNull().references(() => location.id), serial: text("serial").notNull(), name: text("name").notNull(),
  status: text("status").notNull().default("active"), lastEventAt: timestamp("last_event_at", { withTimezone: true }), createdAt: createdAt(),
}, (t) => [unique("terminal_org_serial_uq").on(t.orgId, t.serial), check("terminal_status_chk", sql`${t.status} in ('active','revoked')`)]);

/** Every attendance record a bridge sent, kept as received. Unique per (terminal serial, person code, device time), which is what makes resends harmless. */
export const terminalEvent = shelfline.table("terminal_event", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), bridgeId: uuid("bridge_id").references(() => bridge.id), serial: text("serial").notNull(), personCode: text("person_code").notNull(), ts: timestamp("ts", { withTimezone: true }).notNull(),
  verify: text("verify").notNull(), state: text("state"), status: text("status").notNull(), reason: text("reason"), punchId: uuid("punch_id"), userId: uuid("user_id"), locationId: uuid("location_id"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(), resolvedBy: uuid("resolved_by"), resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (t) => [unique("terminal_event_uq").on(t.orgId, t.serial, t.personCode, t.ts), index("terminal_event_status_idx").on(t.orgId, t.status),
  check("terminal_event_status_chk", sql`${t.status} in ('accepted','needs_review','dismissed')`), check("terminal_event_verify_chk", sql`${t.verify} in ('fingerprint','face','card','password','other')`)]);

// ---------------------------------------------------------------- M15: commission
export const COMMISSION_SCOPES = ["default", "location", "category", "brand", "variant"] as const;
export const COMMISSION_BASES = ["net_ex_tax", "margin"] as const;
export const COMMISSION_SPLITS = ["seller", "equal", "weighted", "hours_pool"] as const;

/** One scope that a rate can apply to (the whole business, one place, a category, a brand or one variant). Its history is the versions below. */
export const commissionRuleSet = shelfline.table("commission_rule_set", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), name: text("name").notNull(),
  scopeKind: text("scope_kind").notNull(), scopeValue: text("scope_value"), createdBy: uuid("created_by"), createdAt: createdAt(),
}, (t) => [uniqueIndex("commission_rule_set_scope_uq").on(t.orgId, t.scopeKind, sql`coalesce(${t.scopeValue}, '')`),
  check("commission_rule_set_scope_chk", sql`${t.scopeKind} in ('default','location','category','brand','variant') and ((${t.scopeKind} = 'default') = (${t.scopeValue} is null))`)]);

/** A version never changes. To change a rate you add a version that takes effect from a date; the version in force on a sale's business date is the one that applies. */
export const commissionRule = shelfline.table("commission_rule", {
  id: id(), ruleSetId: uuid("rule_set_id").notNull().references(() => commissionRuleSet.id), version: integer("version").notNull(), validFrom: date("valid_from").notNull(),
  enabled: boolean("enabled").notNull().default(true), basis: text("basis").notNull(), rateBp: integer("rate_bp").notNull(), splitMode: text("split_mode").notNull(),
  weights: jsonb("weights").notNull().default(sql`'{}'::jsonb`), note: text("note"), createdBy: uuid("created_by"), createdAt: createdAt(),
}, (t) => [unique("commission_rule_version_uq").on(t.ruleSetId, t.version), unique("commission_rule_from_uq").on(t.ruleSetId, t.validFrom),
  check("commission_rule_rate_chk", sql`${t.rateBp} between 0 and 10000`), check("commission_rule_basis_chk", sql`${t.basis} in ('net_ex_tax','margin')`),
  check("commission_rule_split_chk", sql`${t.splitMode} in ('seller','equal','weighted','hours_pool')`)]);

export const commissionPeriod = shelfline.table("commission_period", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), startDate: date("start_date").notNull(), endDate: date("end_date").notNull(),
  status: text("status").notNull().default("open"), lockedAt: timestamp("locked_at", { withTimezone: true }), lockedBy: uuid("locked_by"), createdAt: createdAt(),
}, (t) => [check("commission_period_range_chk", sql`${t.endDate} >= ${t.startDate}`), check("commission_period_status_chk", sql`${t.status} in ('open','locked')`)]);

/** Earnings and clawbacks are derived (and can be rebuilt) while their period is open; once it is locked the rows are fixed by a trigger. */
export const commissionEntry = shelfline.table("commission_entry", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), periodId: uuid("period_id").notNull().references(() => commissionPeriod.id), userId: uuid("user_id").notNull().references(() => user.id),
  locationId: uuid("location_id").references(() => location.id), kind: text("kind").notNull(), sourceKind: text("source_kind").notNull(), sourceId: uuid("source_id").notNull(), lineNo: integer("line_no").notNull().default(0),
  ruleId: uuid("rule_id").references(() => commissionRule.id), baseMinor: integer("base_minor").notNull().default(0), amountMinor: integer("amount_minor").notNull(), localDate: date("local_date").notNull(),
  late: boolean("late").notNull().default(false), reason: text("reason"), createdBy: uuid("created_by"), createdAt: createdAt(),
}, (t) => [unique("commission_entry_source_uq").on(t.sourceKind, t.sourceId, t.lineNo, t.userId, t.kind), index("commission_entry_period_idx").on(t.periodId, t.userId),
  check("commission_entry_kind_chk", sql`${t.kind} in ('earn','clawback','adjust')`), check("commission_entry_source_chk", sql`${t.sourceKind} in ('sale','refund','adjust')`)]);

/** The totals per person, written once when the period locks. */
export const commissionStatement = shelfline.table("commission_statement", {
  id: id(), periodId: uuid("period_id").notNull().references(() => commissionPeriod.id), userId: uuid("user_id").notNull().references(() => user.id),
  earnedMinor: integer("earned_minor").notNull(), clawbackMinor: integer("clawback_minor").notNull(), adjustMinor: integer("adjust_minor").notNull(), netMinor: integer("net_minor").notNull(), entries: integer("entries").notNull(), createdAt: createdAt(),
}, (t) => [unique("commission_statement_uq").on(t.periodId, t.userId)]);

// ---------------------------------------------------------------- M16: report access and the portal
/** What one outside reader may see: some reports, some places, a window of dates, minus some columns. Never edited; ended by revoking or by expiry. */
export const reportGrant = shelfline.table("report_grant", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), granteeUserId: uuid("grantee_user_id").notNull().references(() => user.id),
  reportKeys: text("report_keys").array().notNull(), locationIds: uuid("location_ids").array(), rangeKind: text("range_kind").notNull(),
  rangeFrom: date("range_from"), rangeTo: date("range_to"), rollingDays: integer("rolling_days"), hiddenColumns: text("hidden_columns").array().notNull().default(sql`'{}'::text[]`),
  expiresAt: timestamp("expires_at", { withTimezone: true }), revokedAt: timestamp("revoked_at", { withTimezone: true }), revokedBy: uuid("revoked_by"), createdBy: uuid("created_by").notNull(), createdAt: createdAt(),
}, (t) => [index("report_grant_user_idx").on(t.granteeUserId),
  check("report_grant_range_chk", sql`(${t.rangeKind} = 'fixed' and ${t.rangeFrom} is not null and ${t.rangeTo} is not null and ${t.rangeTo} >= ${t.rangeFrom} and ${t.rollingDays} is null) or (${t.rangeKind} = 'rolling' and ${t.rollingDays} between 1 and 366 and ${t.rangeFrom} is null and ${t.rangeTo} is null)`),
  check("report_grant_keys_chk", sql`cardinality(${t.reportKeys}) > 0`)]);

/** One row per time someone opened a report through a grant, with what they asked for and what they were actually given. */
export const reportViewLog = shelfline.table("report_view_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(), orgId: uuid("org_id").notNull().references(() => org.id), grantId: uuid("grant_id").notNull().references(() => reportGrant.id), userId: uuid("user_id").notNull(),
  reportKey: text("report_key").notNull(), format: text("format").notNull(), requested: jsonb("requested").notNull(), served: jsonb("served").notNull(), rowCount: integer("row_count").notNull(), at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("report_view_grant_idx").on(t.grantId, t.at)]);

/** Single-use sign-in codes for the portal. Only a hash is kept. */
export const portalLoginCode = shelfline.table("portal_login_code", {
  id: id(), userId: uuid("user_id").notNull().references(() => user.id), codeHash: text("code_hash").notNull(), expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  attempts: integer("attempts").notNull().default(0), usedAt: timestamp("used_at", { withTimezone: true }), createdAt: createdAt(),
}, (t) => [index("portal_login_code_user_idx").on(t.userId, t.createdAt)]);

/** Mail the system wants to send. With no provider connected (V14) this table is the mailbox: a local catcher you can read in development. */
export const emailOutbox = shelfline.table("email_outbox", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), toEmail: text("to_email").notNull(), subject: text("subject").notNull(), body: text("body").notNull(), kind: text("kind").notNull(),
  attachmentName: text("attachment_name"), attachmentType: text("attachment_type"), attachmentBase64: text("attachment_base64"),
  createdAt: createdAt(), sentAt: timestamp("sent_at", { withTimezone: true }),
}, (t) => [index("email_outbox_to_idx").on(t.toEmail, t.createdAt)]);

// ---------------------------------------------------------------- M17: notifications
export const NOTIFICATION_KINDS = ["punch_in", "punch_out", "late_arrival", "register_open", "register_close", "no_sale", "cash_variance", "large_refund"] as const;

/** Who hears about what: an event kind (narrowed by place and by a condition), the people, the channels, and when to keep quiet. */
export const notificationRule = shelfline.table("notification_rule", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), name: text("name").notNull(), eventKind: text("event_kind").notNull(), locationIds: uuid("location_ids").array(),
  conditions: jsonb("conditions").notNull().default(sql`'{}'::jsonb`), recipientUserIds: uuid("recipient_user_ids").array().notNull().default(sql`'{}'::uuid[]`), recipientRoles: text("recipient_roles").array().notNull().default(sql`'{}'::text[]`),
  channels: text("channels").array().notNull().default(sql`'{in_app}'::text[]`), quietStart: text("quiet_start"), quietEnd: text("quiet_end"), critical: boolean("critical").notNull().default(false),
  digest: boolean("digest").notNull().default(false), digestAt: text("digest_at").notNull().default("18:00"), active: boolean("active").notNull().default(true), createdBy: uuid("created_by"), createdAt: createdAt(),
}, (t) => [index("notification_rule_org_idx").on(t.orgId, t.eventKind),
  check("notification_rule_kind_chk", sql`${t.eventKind} in ('punch_in','punch_out','late_arrival','register_open','register_close','no_sale','cash_variance','large_refund')`),
  check("notification_rule_channels_chk", sql`${t.channels} <@ array['in_app','email']::text[] and cardinality(${t.channels}) > 0`)]);

/** One person told about one event by one rule. The unique key is what makes a repeated or replayed event send only once. */
export const notification = shelfline.table("notification", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), ruleId: uuid("rule_id").notNull().references(() => notificationRule.id), userId: uuid("user_id").notNull().references(() => user.id),
  eventKind: text("event_kind").notNull(), eventRef: text("event_ref").notNull(), locationId: uuid("location_id").references(() => location.id), title: text("title").notNull(), body: text("body").notNull(), payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
  severity: text("severity").notNull().default("info"), status: text("status").notNull().default("delivered"), emailStatus: text("email_status").notNull().default("none"), heldUntil: timestamp("held_until", { withTimezone: true }),
  createdAt: createdAt(), deliveredAt: timestamp("delivered_at", { withTimezone: true }), readAt: timestamp("read_at", { withTimezone: true }),
}, (t) => [unique("notification_once_uq").on(t.ruleId, t.userId, t.eventRef), index("notification_user_idx").on(t.userId, t.createdAt),
  check("notification_status_chk", sql`${t.status} in ('delivered','held')`), check("notification_email_chk", sql`${t.emailStatus} in ('none','sent','held','digest','digested')`), check("notification_severity_chk", sql`${t.severity} in ('info','warning','critical')`)]);

// ---------------------------------------------------------------- M18: automatic end-of-day reports
export const eodSchedule = shelfline.table("eod_schedule", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), name: text("name").notNull(), locationIds: uuid("location_ids").array(), sendAtLocal: text("send_at_local").notNull(), daysOfWeek: integer("days_of_week").array().notNull(),
  timezone: text("timezone").notNull(), methods: text("methods").array().notNull(), recipients: text("recipients").array().notNull().default(sql`'{}'::text[]`), webhookUrl: text("webhook_url"), webhookSecret: text("webhook_secret"),
  format: text("format").notNull().default("pdf"), onlyWhenClosed: boolean("only_when_closed").notNull().default(true), maxWaitMinutes: integer("max_wait_minutes").notNull().default(120), active: boolean("active").notNull().default(true),
  createdBy: uuid("created_by"), createdAt: createdAt(),
}, (t) => [check("eod_schedule_time_chk", sql`${t.sendAtLocal} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`), check("eod_schedule_format_chk", sql`${t.format} in ('pdf','csv','inline')`),
  check("eod_schedule_methods_chk", sql`${t.methods} <@ array['email','webhook']::text[] and cardinality(${t.methods}) > 0`), check("eod_schedule_days_chk", sql`${t.daysOfWeek} <@ array[0,1,2,3,4,5,6] and cardinality(${t.daysOfWeek}) > 0`)]);

/** One row per (kind, schedule, business day): the unique key is what keeps a restarted or doubled worker from sending twice. */
export const scheduledJob = shelfline.table("scheduled_job", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), kind: text("kind").notNull(), scheduleId: uuid("schedule_id").notNull(), localDate: date("local_date").notNull(), runAt: timestamp("run_at", { withTimezone: true }).notNull(),
  status: text("status").notNull().default("pending"), attempts: integer("attempts").notNull().default(0), lastError: text("last_error"), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(), createdAt: createdAt(),
}, (t) => [unique("scheduled_job_once_uq").on(t.kind, t.scheduleId, t.localDate), index("scheduled_job_due_idx").on(t.status, t.runAt),
  check("scheduled_job_status_chk", sql`${t.status} in ('pending','running','waiting','done','cancelled')`)]);

/** Every version of a day's report that was produced. Figures are kept as sent; a later version never overwrites an earlier one. */
export const eodReportRun = shelfline.table("eod_report_run", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), scheduleId: uuid("schedule_id").notNull().references(() => eodSchedule.id), localDate: date("local_date").notNull(), version: integer("version").notNull(),
  status: text("status").notNull(), figures: jsonb("figures").notNull(), checksum: text("checksum").notNull(), notes: text("notes").array().notNull().default(sql`'{}'::text[]`), delivered: jsonb("delivered").notNull().default(sql`'[]'::jsonb`), generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("eod_run_version_uq").on(t.scheduleId, t.localDate, t.version), check("eod_run_status_chk", sql`${t.status} in ('provisional','final','amended')`)]);

// ---------------------------------------------------------------- M19: receipt printers and the drawer
/** A network receipt printer (ESC/POS over TCP, port 9100 by default) that a store's bridge can reach. A register-specific printer wins over the store's shared one. */
export const printer = shelfline.table("printer", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), locationId: uuid("location_id").notNull().references(() => location.id), registerId: uuid("register_id").references(() => register.id),
  name: text("name").notNull(), host: text("host").notNull(), port: integer("port").notNull().default(9100), columns: integer("columns").notNull().default(42), active: boolean("active").notNull().default(true),
  lastOkAt: timestamp("last_ok_at", { withTimezone: true }), lastError: text("last_error"), createdAt: createdAt(),
}, (t) => [unique("printer_location_name_uq").on(t.locationId, t.name), check("printer_port_chk", sql`${t.port} between 1 and 65535`), check("printer_columns_chk", sql`${t.columns} between 24 and 64`)]);

/** What was asked of a printer, as the exact bytes to send. A job is claimed by the bridge, sent, and reported on; a lost claim goes back to the queue. */
export const printJob = shelfline.table("print_job", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), locationId: uuid("location_id").notNull().references(() => location.id), printerId: uuid("printer_id").notNull().references(() => printer.id),
  kind: text("kind").notNull(), sourceType: text("source_type").notNull(), sourceId: text("source_id").notNull(), copy: integer("copy").notNull().default(1), payloadBase64: text("payload_base64").notNull(),
  status: text("status").notNull().default("queued"), attempts: integer("attempts").notNull().default(0), lastError: text("last_error"), requestedBy: uuid("requested_by"),
  createdAt: createdAt(), claimedAt: timestamp("claimed_at", { withTimezone: true }), doneAt: timestamp("done_at", { withTimezone: true }),
}, (t) => [unique("print_job_once_uq").on(t.printerId, t.sourceType, t.sourceId, t.kind, t.copy), index("print_job_queue_idx").on(t.locationId, t.status, t.createdAt),
  check("print_job_kind_chk", sql`${t.kind} in ('receipt','drawer','test')`), check("print_job_status_chk", sql`${t.status} in ('queued','sending','done','failed')`)]);

// ---------------------------------------------------------------- M19: card terminals (server-driven)
/** A card terminal the server can send a payment to. Which backend (simulated, Stripe) is a server setting; the id is whatever that backend calls the reader. */
export const cardReader = shelfline.table("card_reader", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), locationId: uuid("location_id").notNull().references(() => location.id), registerId: uuid("register_id").references(() => register.id),
  name: text("name").notNull(), providerReaderId: text("provider_reader_id").notNull(), active: boolean("active").notNull().default(true), createdAt: createdAt(),
}, (t) => [unique("card_reader_location_name_uq").on(t.locationId, t.name)]);

/** One attempt to take a card payment. The sale is not created from this: the till adds it to the sale as a card tender with its id as the reference, and the server ties the two together when the sale arrives. */
export const cardPayment = shelfline.table("card_payment", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), locationId: uuid("location_id").notNull().references(() => location.id), registerId: uuid("register_id"), readerId: uuid("reader_id").notNull().references(() => cardReader.id),
  amountMinor: integer("amount_minor").notNull(), currency: char("currency", { length: 3 }).notNull(), status: text("status").notNull().default("processing"), provider: text("provider").notNull(), providerRef: text("provider_ref"),
  failure: text("failure"), brand: text("brand"), last4: text("last4"), requestedBy: uuid("requested_by"), idempotencyKey: uuid("idempotency_key").notNull(), saleId: uuid("sale_id"),
  createdAt: createdAt(), completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => [unique("card_payment_key_uq").on(t.orgId, t.idempotencyKey), index("card_payment_sale_idx").on(t.saleId), check("card_payment_amount_chk", sql`${t.amountMinor} > 0`),
  check("card_payment_status_chk", sql`${t.status} in ('processing','succeeded','failed','canceled')`)]);

// ---------------------------------------------------------------- M20: the online store (reserve online, collect in store)
export const ONLINE_STATUSES = ["placed", "ready", "collected", "cancelled", "expired"] as const;
/** A customer's order to collect at a store. Stock is reserved at that store (an `online_reserve` outflow in the ledger) until it is collected, cancelled or expires. Payment is taken at the counter. */
export const onlineOrder = shelfline.table("online_order", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), number: text("number").notNull(), locationId: uuid("location_id").notNull().references(() => location.id), status: text("status").notNull().default("placed"),
  customerEmail: text("customer_email").notNull(), customerName: text("customer_name").notNull(), customerPhone: text("customer_phone"), pickupCodeHash: text("pickup_code_hash").notNull(), accessTokenHash: text("access_token_hash").notNull(),
  subtotalMinor: integer("subtotal_minor").notNull(), taxMinor: integer("tax_minor").notNull(), totalMinor: integer("total_minor").notNull(), currency: char("currency", { length: 3 }).notNull(),
  placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(), expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), readyAt: timestamp("ready_at", { withTimezone: true }), collectedAt: timestamp("collected_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }), cancelledBy: uuid("cancelled_by"), cancelReason: text("cancel_reason"), saleId: uuid("sale_id"),
}, (t) => [unique("online_order_number_uq").on(t.orgId, t.number), index("online_order_loc_idx").on(t.locationId, t.status, t.placedAt), uniqueIndex("online_order_code_uq").on(t.locationId, t.pickupCodeHash).where(sql`${t.status} in ('placed','ready')`),
  check("online_order_status_chk", sql`${t.status} in ('placed','ready','collected','cancelled','expired')`)]);
export const onlineOrderLine = shelfline.table("online_order_line", {
  orderId: uuid("order_id").notNull().references(() => onlineOrder.id), lineNo: integer("line_no").notNull(), variantId: uuid("variant_id").notNull().references(() => variant.id), title: text("title").notNull(), optionsLabel: text("options_label").notNull().default(""),
  qty: integer("qty").notNull(), unitPriceMinor: integer("unit_price_minor").notNull(), totalMinor: integer("total_minor").notNull(), taxMinor: integer("tax_minor").notNull(),
}, (t) => [unique("online_order_line_pk").on(t.orderId, t.lineNo), check("online_order_line_qty_chk", sql`${t.qty} > 0`)]);

// ---------------------------------------------------------------- M21: the Shopify channel
/** A Shopify shop this business sells through. Shelfline stays the master of stock: it pushes absolute quantities for one store's stock and takes the shop's orders off that stock. Tokens are stored encrypted. */
export const channelConnection = shelfline.table("channel_connection", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), kind: text("kind").notNull().default("shopify"), name: text("name").notNull(), shopDomain: text("shop_domain").notNull(),
  accessTokenEnc: text("access_token_enc"), webhookSecretEnc: text("webhook_secret_enc"), apiVersion: text("api_version").notNull().default("2025-10"),
  locationId: uuid("location_id").notNull().references(() => location.id), shopifyLocationId: text("shopify_location_id").notNull(), status: text("status").notNull().default("active"),
  lastPushAt: timestamp("last_push_at", { withTimezone: true }), lastError: text("last_error"), createdBy: uuid("created_by"), createdAt: createdAt(),
}, (t) => [unique("channel_connection_shop_uq").on(t.orgId, t.shopDomain), check("channel_connection_status_chk", sql`${t.status} in ('active','paused','disconnected')`)]);
export const channelListing = shelfline.table("channel_listing", {
  id: id(), connectionId: uuid("connection_id").notNull().references(() => channelConnection.id), variantId: uuid("variant_id").notNull().references(() => variant.id), shopifyVariantId: text("shopify_variant_id").notNull(), shopifyInventoryItemId: text("shopify_inventory_item_id").notNull(),
  lastPushedQty: integer("last_pushed_qty"), lastPushedAt: timestamp("last_pushed_at", { withTimezone: true }), createdAt: createdAt(),
}, (t) => [unique("channel_listing_variant_uq").on(t.connectionId, t.variantId), unique("channel_listing_shopify_uq").on(t.connectionId, t.shopifyVariantId)]);
/** One Shopify order, imported once however many times its webhook arrives. */
export const channelOrder = shelfline.table("channel_order", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), connectionId: uuid("connection_id").notNull().references(() => channelConnection.id), shopifyOrderId: text("shopify_order_id").notNull(), name: text("name").notNull(),
  status: text("status").notNull().default("imported"), totalMinor: integer("total_minor").notNull(), currency: char("currency", { length: 3 }).notNull(), customerEmail: text("customer_email"), lines: jsonb("lines").notNull(), unmapped: integer("unmapped").notNull().default(0),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(), cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
}, (t) => [unique("channel_order_once_uq").on(t.connectionId, t.shopifyOrderId), check("channel_order_status_chk", sql`${t.status} in ('imported','cancelled')`)]);
/** Every webhook delivery seen, by Shopify's own delivery id, so a retry is recognised and answered without doing the work again. */
export const channelWebhook = shelfline.table("channel_webhook", {
  connectionId: uuid("connection_id").notNull().references(() => channelConnection.id), webhookId: text("webhook_id").notNull(), topic: text("topic").notNull(), result: text("result").notNull(), receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("channel_webhook_once_uq").on(t.connectionId, t.webhookId)]);

// ---------------------------------------------------------------- M22: marketing and loyalty
/** Every change to who agreed to hear from us, with how and when. The customer row says where things stand now; this says how they got there. */
export const consentEvent = shelfline.table("consent_event", {
  id: bigserial("id", { mode: "number" }).primaryKey(), orgId: uuid("org_id").notNull().references(() => org.id), customerId: uuid("customer_id").notNull().references(() => customer.id), channel: text("channel").notNull().default("email"),
  granted: boolean("granted").notNull(), source: text("source").notNull(), actorId: uuid("actor_id"), at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("consent_event_customer_idx").on(t.customerId, t.at)]);
export const marketingSetting = shelfline.table("marketing_setting", { orgId: uuid("org_id").primaryKey().references(() => org.id), minGapDays: integer("min_gap_days").notNull().default(7) }, (t) => [check("marketing_gap_chk", sql`${t.minGapDays} between 0 and 90`)]);
export const segment = shelfline.table("segment", { id: id(), orgId: uuid("org_id").notNull().references(() => org.id), name: text("name").notNull(), rules: jsonb("rules").notNull(), createdBy: uuid("created_by"), createdAt: createdAt() }, (t) => [uniqueIndex("segment_name_uq").on(t.orgId, sql`lower(${t.name})`)]);
export const campaign = shelfline.table("campaign", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), name: text("name").notNull(), segmentId: uuid("segment_id").references(() => segment.id), subject: text("subject").notNull(), body: text("body").notNull(),
  status: text("status").notNull().default("draft"), audience: jsonb("audience"), sentAt: timestamp("sent_at", { withTimezone: true }), createdBy: uuid("created_by"), createdAt: createdAt(),
}, (t) => [check("campaign_status_chk", sql`${t.status} in ('draft','sending','sent','cancelled')`)]);
export const flow = shelfline.table("flow", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), kind: text("kind").notNull(), name: text("name").notNull(), active: boolean("active").notNull().default(false), config: jsonb("config").notNull(), createdAt: createdAt(),
}, (t) => [unique("flow_kind_uq").on(t.orgId, t.kind), check("flow_kind_chk", sql`${t.kind} in ('win_back','birthday','post_purchase')`)]);
/** One row per person per send. The unique keys are why a campaign cannot go out twice and a flow cannot repeat itself for the same reason. */
export const marketingMessage = shelfline.table("marketing_message", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), campaignId: uuid("campaign_id").references(() => campaign.id), flowId: uuid("flow_id").references(() => flow.id), flowKey: text("flow_key"), customerId: uuid("customer_id").notNull().references(() => customer.id),
  email: text("email"), subject: text("subject").notNull(), status: text("status").notNull(), skipReason: text("skip_reason"), createdAt: createdAt(),
}, (t) => [uniqueIndex("marketing_message_campaign_uq").on(t.campaignId, t.customerId).where(sql`${t.campaignId} is not null`), uniqueIndex("marketing_message_flow_uq").on(t.flowId, t.customerId, t.flowKey).where(sql`${t.flowId} is not null`),
  index("marketing_message_customer_idx").on(t.customerId, t.createdAt), check("marketing_message_status_chk", sql`${t.status} in ('sent','skipped')`)]);
export const loyaltyProgram = shelfline.table("loyalty_program", {
  orgId: uuid("org_id").primaryKey().references(() => org.id), enabled: boolean("enabled").notNull().default(false), pointsPerDollar: integer("points_per_dollar").notNull().default(1),
  tiers: jsonb("tiers").notNull().default(sql`'[{"name":"Member","min":0,"multBp":10000},{"name":"Silver","min":500,"multBp":12500},{"name":"Gold","min":1500,"multBp":15000}]'::jsonb`),
  redeemPoints: integer("redeem_points").notNull().default(100), redeemValueMinor: integer("redeem_value_minor").notNull().default(500), birthdayBonus: integer("birthday_bonus").notNull().default(0),
}, (t) => [check("loyalty_program_chk", sql`${t.pointsPerDollar} between 0 and 100 and ${t.redeemPoints} between 1 and 100000 and ${t.redeemValueMinor} between 0 and 1000000 and ${t.birthdayBonus} between 0 and 10000`)]);
/** A customer's points are the sum of these rows and nothing else. Rows are never changed; a correction is another row. */
export const loyaltyEntry = shelfline.table("loyalty_entry", {
  id: bigserial("id", { mode: "number" }).primaryKey(), orgId: uuid("org_id").notNull().references(() => org.id), customerId: uuid("customer_id").notNull().references(() => customer.id), kind: text("kind").notNull(), points: integer("points").notNull(),
  sourceType: text("source_type").notNull(), sourceId: text("source_id").notNull(), note: text("note"), actorId: uuid("actor_id"), at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("loyalty_entry_once_uq").on(t.orgId, t.customerId, t.kind, t.sourceType, t.sourceId), index("loyalty_entry_customer_idx").on(t.customerId, t.id),
  check("loyalty_entry_kind_chk", sql`${t.kind} in ('earn','clawback','redeem','adjust','bonus')`),
  check("loyalty_entry_sign_chk", sql`${t.points} <> 0 and (${t.kind} not in ('earn','bonus') or ${t.points} > 0) and (${t.kind} not in ('clawback','redeem') or ${t.points} < 0)`)]);

// ---------------------------------------------------------------- M23: accounting export and replenishment
export const ACCOUNT_KEYS = ["cash", "card_clearing", "gift_card_liability", "store_credit_liability", "other_clearing", "sales_revenue", "gst_collected", "rounding", "cash_over_short", "cogs", "inventory", "suspense"] as const;
/** Which account in the accountant's books each kind of money goes to. */
export const accountMapping = shelfline.table("account_mapping", { orgId: uuid("org_id").notNull().references(() => org.id), key: text("key").notNull(), code: text("code").notNull(), name: text("name") }, (t) => [unique("account_mapping_pk").on(t.orgId, t.key), check("account_mapping_key_chk", sql`${t.key} in ('cash','card_clearing','gift_card_liability','store_credit_liability','other_clearing','sales_revenue','gst_collected','rounding','cash_over_short','cogs','inventory','suspense')`)]);
/** How the server reaches Xero for one organisation: tokens are stored encrypted and renewed when they near their end. */
export const xeroConnection = shelfline.table("xero_connection", {
  orgId: uuid("org_id").primaryKey().references(() => org.id), tenantId: text("tenant_id").notNull(), accessTokenEnc: text("access_token_enc"), refreshTokenEnc: text("refresh_token_enc"), clientId: text("client_id").notNull(), clientSecretEnc: text("client_secret_enc"),
  expiresAt: timestamp("expires_at", { withTimezone: true }), status: text("status").notNull().default("active"), lastError: text("last_error"), createdAt: createdAt(),
}, (t) => [check("xero_connection_status_chk", sql`${t.status} in ('active','disconnected')`)]);
/** One journal sent (or downloaded) for one store and one trading day. Version 1 is the whole day; a later version is only what changed since. Nothing here is ever edited. */
export const accountingExport = shelfline.table("accounting_export", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), locationId: uuid("location_id").notNull().references(() => location.id), localDate: date("local_date").notNull(), version: integer("version").notNull(), method: text("method").notNull(),
  lines: jsonb("lines").notNull(), reference: text("reference").notNull(), externalRef: text("external_ref"), exportedBy: uuid("exported_by"), exportedAt: timestamp("exported_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("accounting_export_version_uq").on(t.orgId, t.locationId, t.localDate, t.version), check("accounting_export_method_chk", sql`${t.method} in ('xero','csv')`)]);

/** A batch of draft purchase orders made from reorder suggestions. The key is why pressing the button twice makes one set of drafts. */
export const replenishmentBatch = shelfline.table("replenishment_batch", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), key: uuid("key").notNull(), locationId: uuid("location_id").notNull().references(() => location.id), poIds: uuid("po_ids").array().notNull(), createdBy: uuid("created_by"), createdAt: createdAt(),
}, (t) => [unique("replenishment_batch_key_uq").on(t.orgId, t.key)]);

// ---------------------------------------------------------------- M24: single sign-on (OpenID Connect)
/** One identity provider per organisation. People are matched by email to users who already exist here; nobody is created by signing in. */
export const ssoConnection = shelfline.table("sso_connection", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), issuer: text("issuer").notNull(), clientId: text("client_id").notNull(), clientSecretEnc: text("client_secret_enc").notNull(),
  emailDomains: text("email_domains").array().notNull().default(sql`'{}'::text[]`), enabled: boolean("enabled").notNull().default(true), createdAt: createdAt(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("sso_connection_org_uq").on(t.orgId)]);
/** What the browser carries back from the identity provider: a one-time ticket that is traded for a sign-in. Used once, short-lived. */
export const ssoTicket = shelfline.table("sso_ticket", {
  id: id(), orgId: uuid("org_id").notNull().references(() => org.id), userId: uuid("user_id").notNull().references(() => user.id), expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), usedAt: timestamp("used_at", { withTimezone: true }), createdAt: createdAt(),
});
