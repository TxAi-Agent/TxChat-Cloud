import {
  keyVersion,
  decryptPhone,
  type VersionedKeyRing,
} from "../../auth/phoneIdentity.js";
import type { CoreDatabase } from "../../db/database.js";
import { isInternalId } from "../../ids/internalId.js";

const ID_PREFIX = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{1,32}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const MAX_RESULTS = 100;

type OrderStatus =
  | "pending"
  | "paid"
  | "expired"
  | "refunded"
  | "payment_exception";

export type OrderAdminErrorCode =
  | "ADMIN_INVALID_REQUEST"
  | "ADMIN_ORDER_NOT_FOUND"
  | "ADMIN_SERVICE_UNAVAILABLE";

export class OrderAdminError extends Error {
  constructor(readonly code: OrderAdminErrorCode) {
    super(code);
    this.name = "OrderAdminError";
  }
}

export type OrderOfferSnapshot = Readonly<{
  versionId: string;
  productId: string;
  productCode: string;
  displayName: string;
  productType: "membership" | "addon";
  tierCode: string;
  currency: "CNY";
  amountFen: number;
  quotaAmount: number;
  quotaUnit: "milliseconds";
  includedDurationMs: number;
  periodUnit: "calendar_month" | "calendar_year";
  periodCount: number;
  timezone: string;
  rollover: boolean;
  autoRenew: boolean;
  activeMemberRepurchase: boolean;
  effectiveAt: string;
  state: "draft" | "scheduled" | "active" | "retired";
}>;

export type OrderSummary = Readonly<{
  id: string;
  user: Readonly<{ id: string; phone: string }>;
  offerSnapshot: OrderOfferSnapshot;
  amountFen: number;
  currency: "CNY";
  status: OrderStatus;
  createdAt: string;
  expiresAt: string;
  paidAt: string | null;
  refundedAt: string | null;
  callbackCount: number;
  duplicateCallbackCount: number;
  refundCount: number;
}>;

export type OrderCallback = Readonly<{
  id: string;
  externalNotificationId: string;
  transactionId: string | null;
  amountFen: number | null;
  currency: string | null;
  result: "accepted" | "duplicate" | "rejected";
  duplicate: boolean;
  receivedAt: string;
  processedAt: string;
}>;

export type OrderReconciliation = Readonly<{
  id: string;
  category: "order_repaired";
  result: "accepted" | "rejected" | "failed" | "uncertain" | "unknown";
  actorUsername: string | null;
  occurredAt: string;
}>;

export type OrderRefund = Readonly<{
  id: string;
  amountFen: number;
  wechatRefundId: string | null;
  status: "recorded" | "confirmed" | "exception";
  operatorNote: string;
  recordedByUsername: string;
  createdAt: string;
  confirmedAt: string | null;
}>;

export type OrderDetail = OrderSummary & Readonly<{
  wechat: Readonly<{
    outTradeNo: string;
    transactionId: string | null;
  }>;
  callbacks: readonly OrderCallback[];
  reconciliations: readonly OrderReconciliation[];
  refunds: readonly OrderRefund[];
}>;

type OrderRow = Readonly<{
  id: string;
  user_id: string;
  phone_ciphertext: string;
  phone_key_version: string;
  product_id: string;
  offer_version_id: string;
  offer_product_code: string;
  offer_display_name: string;
  offer_product_type: "membership" | "addon";
  offer_tier_code: string;
  offer_currency: "CNY";
  offer_amount_fen: number;
  offer_quota_amount: number;
  offer_quota_unit: "milliseconds";
  offer_included_duration_ms: number;
  offer_period_unit: "calendar_month" | "calendar_year";
  offer_period_count: number;
  offer_timezone: string;
  offer_rollover: number;
  offer_auto_renew: number;
  offer_active_member_repurchase: number;
  offer_effective_at: string;
  offer_state: "draft" | "scheduled" | "active" | "retired";
  amount_fen: number;
  currency: "CNY";
  status: OrderStatus;
  wechat_out_trade_no: string;
  wechat_transaction_id: string | null;
  created_at: string;
  expires_at: string;
  paid_at: string | null;
  refunded_at: string | null;
  callback_count: number;
  duplicate_callback_count: number;
  refund_count: number;
}>;

type CallbackRow = Readonly<{
  id: string;
  external_notification_id: string;
  wechat_transaction_id: string | null;
  amount_fen: number | null;
  currency: string | null;
  result: "accepted" | "duplicate" | "rejected";
  received_at: string;
  processed_at: string;
}>;

type ReconciliationRow = Readonly<{
  id: string;
  actor_username_snapshot: string | null;
  result_category: string;
  occurred_at: string;
}>;

type RefundRow = Readonly<{
  id: string;
  amount_fen: number;
  wechat_refund_id: string | null;
  status: "recorded" | "confirmed" | "exception";
  operator_note: string;
  recorded_by_username_snapshot: string;
  created_at: string;
  confirmed_at: string | null;
}>;

export type OrderAdminListInput = Readonly<{
  page?: number | undefined;
  status?: string | undefined;
  keyword?: string | undefined;
  userId?: string | undefined;
  idPrefix?: string | undefined;
  limit?: number | undefined;
}>;

function fail(code: OrderAdminErrorCode): never {
  throw new OrderAdminError(code);
}

function timestamp(value: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value.isWellFormed()) {
    return fail("ADMIN_SERVICE_UNAVAILABLE");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    return fail("ADMIN_SERVICE_UNAVAILABLE");
  }
  return value;
}

function safeText(value: string, maximum = 240): string {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    value.length < 1 ||
    value.length > maximum ||
    CONTROL.test(value)
  ) fail("ADMIN_SERVICE_UNAVAILABLE");
  return value;
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail("ADMIN_SERVICE_UNAVAILABLE");
  }
  return value;
}

function nonNegativeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("ADMIN_SERVICE_UNAVAILABLE");
  }
  return value;
}

function booleanInteger(value: number): boolean {
  if (value !== 0 && value !== 1) fail("ADMIN_SERVICE_UNAVAILABLE");
  return value === 1;
}

function prefixUpperBound(prefix: string): string {
  return `${prefix.slice(0, -1)}${String.fromCharCode(
    prefix.charCodeAt(prefix.length - 1) + 1,
  )}`;
}

function criteria(input: OrderAdminListInput): Readonly<{
  userId?: string | undefined;
  idPrefix?: string | undefined;
  limit: number;
  page: number;
  status?: string | undefined;
  keyword?: string | undefined;
}> {
  if (
    input === null ||
    typeof input !== "object" ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null) ||
    Object.keys(input).some((key) => !["idPrefix", "userId", "limit", "page", "status", "keyword"].includes(key))
  ) fail("ADMIN_INVALID_REQUEST");
  if (input.idPrefix !== undefined && !ID_PREFIX.test(input.idPrefix)) {
    fail("ADMIN_INVALID_REQUEST");
  }
  if (input.userId !== undefined && !isInternalId(input.userId)) fail("ADMIN_INVALID_REQUEST");
  if (input.status !== undefined && !["pending", "paid", "expired", "refunded", "payment_exception"].includes(input.status)) fail("ADMIN_INVALID_REQUEST");
  const page = input.page ?? 1;
  if (!Number.isSafeInteger(page) || page < 1 ||
      (input.keyword !== undefined && (typeof input.keyword !== "string" || input.keyword.length > 128))) fail("ADMIN_INVALID_REQUEST");
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RESULTS) {
    fail("ADMIN_INVALID_REQUEST");
  }
  return Object.freeze({
    ...(input.idPrefix === undefined ? {} : { idPrefix: input.idPrefix }),
    ...(input.userId === undefined ? {} : { userId: input.userId }),
    limit, page,
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.keyword === undefined ? {} : { keyword: input.keyword }),
  });
}

// Billing persists expiry when a user next accesses their orders. Admin reads
// also account for elapsed time, including filtering and pagination counts.
const EFFECTIVE_ORDER_STATUS = `CASE
  WHEN orders.status = 'pending' AND orders.expires_at <= ? THEN 'expired'
  ELSE orders.status
END`;

const ORDER_COLUMNS = `
  orders.id,
  orders.user_id,
  users.phone_ciphertext,
  users.phone_key_version,
  orders.product_id,
  orders.offer_version_id,
  orders.offer_product_code,
  orders.offer_display_name,
  orders.offer_product_type,
  orders.offer_tier_code,
  orders.offer_currency,
  orders.offer_amount_fen,
  orders.offer_quota_amount,
  orders.offer_quota_unit,
  orders.offer_included_duration_ms,
  orders.offer_period_unit,
  orders.offer_period_count,
  orders.offer_timezone,
  orders.offer_rollover,
  orders.offer_auto_renew,
  orders.offer_active_member_repurchase,
  orders.offer_effective_at,
  orders.offer_state,
  orders.amount_fen,
  orders.currency,
  ${EFFECTIVE_ORDER_STATUS} AS status,
  orders.wechat_out_trade_no,
  orders.wechat_transaction_id,
  orders.created_at,
  orders.expires_at,
  orders.paid_at,
  orders.refunded_at,
  (SELECT COUNT(*) FROM wechat_payment_events AS callback
   WHERE callback.order_id = orders.id) AS callback_count,
  (SELECT COUNT(*) FROM wechat_payment_events AS callback
   WHERE callback.order_id = orders.id AND callback.result = 'duplicate')
    AS duplicate_callback_count,
  (SELECT COUNT(*) FROM billing_refund_records AS refund
   WHERE refund.order_id = orders.id) AS refund_count`;

export class OrderAdminService {
  readonly #database: CoreDatabase;
  readonly #phoneEncryptionKeys: VersionedKeyRing;
  readonly #now: () => Date;

  constructor(options: Readonly<{
    database: CoreDatabase;
    phoneEncryptionKeys: VersionedKeyRing;
    now?: () => Date;
  }>) {
    if (
      options === null || typeof options !== "object" ||
      (options.now !== undefined && typeof options.now !== "function")
    ) {
      throw new TypeError("Invalid unified order administration options");
    }
    this.#database = options.database;
    this.#phoneEncryptionKeys = options.phoneEncryptionKeys;
    this.#now = options.now ?? (() => new Date());
  }

  list(input: OrderAdminListInput = {}): readonly OrderSummary[] {
    return this.searchPage(input).orders;
  }

  searchPage(input: OrderAdminListInput = {}): Readonly<{
    orders: readonly OrderSummary[];
    pagination: Readonly<{ page: number; pageSize: number; total: number; totalPages: number }>;
  }> {
    const parsed = criteria(input);
    const now = this.read(() => Date.prototype.toISOString.call(this.#now()));
    const values: unknown[] = [];
    let where = "";
    if (parsed.idPrefix !== undefined) {
      if (parsed.idPrefix.length === 32) {
        where = "WHERE orders.id = ?";
        values.push(parsed.idPrefix);
      } else {
        where = "WHERE orders.id >= ? AND orders.id < ?";
        values.push(parsed.idPrefix, prefixUpperBound(parsed.idPrefix));
      }
    }
    if (parsed.userId !== undefined) {
      where += `${where === "" ? "WHERE" : " AND"} orders.user_id = ?`;
      values.push(parsed.userId);
    }
    if (parsed.status !== undefined) {
      where += `${where === "" ? "WHERE" : " AND"} ${EFFECTIVE_ORDER_STATUS} = ?`;
      values.push(now, parsed.status);
    }
    if (parsed.keyword !== undefined) {
      where += `${where === "" ? "WHERE" : " AND"} instr(orders.wechat_out_trade_no, ?) > 0`; values.push(parsed.keyword);
    }
    return this.read(() => this.#database.transaction(() => {
      const count = this.#database.prepare(`SELECT COUNT(*) AS total FROM billing_orders AS orders INNER JOIN users ON users.id = orders.user_id ${where}`).get(...values) as { total: number };
      const totalPages = Math.max(1, Math.ceil(count.total / parsed.limit));
      const page = Math.min(parsed.page, totalPages);
      const records = this.#database.prepare(`SELECT ${ORDER_COLUMNS} FROM billing_orders AS orders INNER JOIN users ON users.id = orders.user_id
        ${where} ORDER BY orders.created_at DESC, orders.id DESC LIMIT ? OFFSET ?`)
        .all(now, ...values, parsed.limit, (page - 1) * parsed.limit) as OrderRow[];
      return Object.freeze({ orders: Object.freeze(records.map((row) => this.safeSummary(row))),
        pagination: Object.freeze({ page, pageSize: parsed.limit, total: count.total, totalPages }) });
    })());
  }

  detail(id: string): OrderDetail {
    if (!isInternalId(id)) fail("ADMIN_INVALID_REQUEST");
    return this.read(() => {
      const now = Date.prototype.toISOString.call(this.#now());
      const row = this.#database.prepare(
        `SELECT ${ORDER_COLUMNS}
         FROM billing_orders AS orders
         INNER JOIN users ON users.id = orders.user_id
         WHERE orders.id = ?`,
      ).get(now, id) as OrderRow | undefined;
      if (row === undefined) fail("ADMIN_ORDER_NOT_FOUND");
      const callbacks = (this.#database.prepare(
        `SELECT id, external_notification_id, wechat_transaction_id,
                amount_fen, currency, result, received_at, processed_at
         FROM wechat_payment_events
         WHERE order_id = ?
         ORDER BY received_at, id`,
      ).all(id) as CallbackRow[]).map((callback) => this.safeCallback(callback));
      const reconciliations = (this.#database.prepare(
        `SELECT id, actor_username_snapshot, result_category, occurred_at
         FROM billing_admin_audit
         WHERE event_type = 'order_repaired' AND target_id = ?
         ORDER BY occurred_at, id`,
      ).all(id) as ReconciliationRow[]).map((entry) =>
        this.safeReconciliation(entry)
      );
      const refunds = (this.#database.prepare(
        `SELECT id, amount_fen, wechat_refund_id, status, operator_note,
                recorded_by_username_snapshot, created_at, confirmed_at
         FROM billing_refund_records
         WHERE order_id = ?
         ORDER BY created_at, id`,
      ).all(id) as RefundRow[]).map((refund) => this.safeRefund(refund));
      return Object.freeze({
        ...this.safeSummary(row),
        wechat: Object.freeze({
          outTradeNo: safeText(row.wechat_out_trade_no, 128),
          transactionId: row.wechat_transaction_id === null
            ? null
            : safeText(row.wechat_transaction_id, 128),
        }),
        callbacks: Object.freeze(callbacks),
        reconciliations: Object.freeze(reconciliations),
        refunds: Object.freeze(refunds),
      });
    });
  }

  private safeSummary(row: OrderRow): OrderSummary {
    if (
      !isInternalId(row.id) ||
      !isInternalId(row.user_id) ||
      !isInternalId(row.product_id) ||
      !isInternalId(row.offer_version_id) ||
      keyVersion(row.phone_ciphertext) !== row.phone_key_version ||
      !["pending", "paid", "expired", "refunded", "payment_exception"].includes(
        row.status,
      ) ||
      row.currency !== "CNY" ||
      row.offer_currency !== "CNY" ||
      row.offer_amount_fen !== row.amount_fen ||
      (row.offer_product_type !== "membership" && row.offer_product_type !== "addon") ||
      row.offer_quota_unit !== "milliseconds" ||
      (row.offer_period_unit !== "calendar_month" &&
        row.offer_period_unit !== "calendar_year") ||
      !["draft", "scheduled", "active", "retired"].includes(row.offer_state)
    ) fail("ADMIN_SERVICE_UNAVAILABLE");
    let phone: string;
    try {
      phone = decryptPhone(row.phone_ciphertext, this.#phoneEncryptionKeys);
    } catch {
      return fail("ADMIN_SERVICE_UNAVAILABLE");
    }
    return Object.freeze({
      id: row.id,
      user: Object.freeze({ id: row.user_id, phone }),
      offerSnapshot: Object.freeze({
        versionId: row.offer_version_id,
        productId: row.product_id,
        productCode: safeText(row.offer_product_code, 128),
        displayName: safeText(row.offer_display_name, 80),
        productType: row.offer_product_type,
        tierCode: safeText(row.offer_tier_code, 128),
        currency: row.offer_currency,
        amountFen: positiveInteger(row.offer_amount_fen),
        quotaAmount: positiveInteger(row.offer_quota_amount),
        quotaUnit: row.offer_quota_unit,
        includedDurationMs: positiveInteger(row.offer_included_duration_ms),
        periodUnit: row.offer_period_unit,
        periodCount: positiveInteger(row.offer_period_count),
        timezone: safeText(row.offer_timezone, 64),
        rollover: booleanInteger(row.offer_rollover),
        autoRenew: booleanInteger(row.offer_auto_renew),
        activeMemberRepurchase: booleanInteger(row.offer_active_member_repurchase),
        effectiveAt: timestamp(row.offer_effective_at)!,
        state: row.offer_state,
      }),
      amountFen: positiveInteger(row.amount_fen),
      currency: row.currency,
      status: row.status,
      createdAt: timestamp(row.created_at)!,
      expiresAt: timestamp(row.expires_at)!,
      paidAt: timestamp(row.paid_at),
      refundedAt: timestamp(row.refunded_at),
      callbackCount: nonNegativeInteger(row.callback_count),
      duplicateCallbackCount: nonNegativeInteger(row.duplicate_callback_count),
      refundCount: nonNegativeInteger(row.refund_count),
    });
  }

  private safeCallback(row: CallbackRow): OrderCallback {
    if (
      !isInternalId(row.id) ||
      !["accepted", "duplicate", "rejected"].includes(row.result) ||
      (row.amount_fen !== null &&
        (!Number.isSafeInteger(row.amount_fen) || row.amount_fen <= 0))
    ) fail("ADMIN_SERVICE_UNAVAILABLE");
    return Object.freeze({
      id: row.id,
      externalNotificationId: safeText(row.external_notification_id, 128),
      transactionId: row.wechat_transaction_id === null
        ? null
        : safeText(row.wechat_transaction_id, 128),
      amountFen: row.amount_fen,
      currency: row.currency === null ? null : safeText(row.currency, 16),
      result: row.result,
      duplicate: row.result === "duplicate",
      receivedAt: timestamp(row.received_at)!,
      processedAt: timestamp(row.processed_at)!,
    });
  }

  private safeReconciliation(row: ReconciliationRow): OrderReconciliation {
    if (!isInternalId(row.id)) fail("ADMIN_SERVICE_UNAVAILABLE");
    const known = ["accepted", "rejected", "failed", "uncertain"] as const;
    const result = known.find((candidate) => candidate === row.result_category) ?? "unknown";
    return Object.freeze({
      id: row.id,
      category: "order_repaired" as const,
      result,
      actorUsername: row.actor_username_snapshot === null
        ? null
        : safeText(row.actor_username_snapshot, 64),
      occurredAt: timestamp(row.occurred_at)!,
    });
  }

  private safeRefund(row: RefundRow): OrderRefund {
    if (
      !isInternalId(row.id) ||
      !["recorded", "confirmed", "exception"].includes(row.status)
    ) fail("ADMIN_SERVICE_UNAVAILABLE");
    return Object.freeze({
      id: row.id,
      amountFen: positiveInteger(row.amount_fen),
      wechatRefundId: row.wechat_refund_id === null
        ? null
        : safeText(row.wechat_refund_id, 128),
      status: row.status,
      operatorNote: safeText(row.operator_note, 240),
      recordedByUsername: safeText(row.recorded_by_username_snapshot, 64),
      createdAt: timestamp(row.created_at)!,
      confirmedAt: timestamp(row.confirmed_at),
    });
  }

  private read<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      if (error instanceof OrderAdminError) throw error;
      return fail("ADMIN_SERVICE_UNAVAILABLE");
    }
  }
}
