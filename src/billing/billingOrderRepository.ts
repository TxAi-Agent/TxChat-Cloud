import { createHash, randomBytes } from "node:crypto";
import { isProxy } from "node:util/types";

import {
  type CoreDatabase,
  withImmediateTransaction,
} from "../db/database.js";
import {
  isInternalId,
  type InternalIdGenerator,
} from "../ids/internalId.js";
import { insertWithInternalId } from "../ids/sqliteInternalId.js";
import type { BillingCatalogRepository } from "./billingCatalogRepository.js";
import type { BillingEntitlementStatus } from "./billingEntitlementRepository.js";
import {
  BillingFailure,
  MONTHLY_PRODUCT_ID,
  ORDER_TTL_MS,
} from "./billingTypes.js";
import type { VerifiedWeChatTransaction } from "./wechatNativePayment.js";

export type BillingOrderStatus =
  | "pending"
  | "paid"
  | "expired"
  | "refunded"
  | "payment_exception";

export type BillingOrder = Readonly<{
  id: string;
  userId: string;
  productId: typeof MONTHLY_PRODUCT_ID;
  priceVersionId: string;
  displayName: string;
  amountFen: number;
  status: BillingOrderStatus;
  wechatOutTradeNo: string;
  wechatTransactionId: string | null;
  createdAt: string;
  expiresAt: string;
  paidAt: string | null;
  refundedAt: string | null;
}>;

export type BillingPaymentCompletion = Readonly<{
  orderId: string;
  entitlementId: string;
  duplicate: boolean;
}>;

export type BillingPaymentProcessingResult = BillingPaymentCompletion & Readonly<{
  manualRefundRequired: boolean;
}>;

type EntitlementActivator = Readonly<{
  activateMonthly(input: Readonly<{
    userId: string;
    order: Readonly<{ id: string }>;
    paidAt: Date;
  }>): BillingEntitlementStatus;
}>;

type RepositoryOptions = Readonly<{
  spMerchantId: string;
  spAppId: string;
  subMerchantId: string;
  internalId?: InternalIdGenerator;
  outTradeNo?: () => string;
}>;

type StoredOrder = Readonly<{
  id: string;
  user_id: string;
  product_id: string;
  price_version_id: string;
  display_name: string;
  amount_fen: number;
  status: BillingOrderStatus;
  idempotency_key_hash: string;
  wechat_out_trade_no: string;
  wechat_transaction_id: string | null;
  created_at: string;
  expires_at: string;
  paid_at: string | null;
  refunded_at: string | null;
}>;

type StoredPaymentEvent = Readonly<{
  notification_id: string;
  order_id: string | null;
  wechat_transaction_id: string | null;
  amount_fen: number | null;
  result: "accepted" | "duplicate" | "rejected";
}>;

type CanonicalInstant = Readonly<{ iso: string; epochMs: number }>;
type CompletionOutcome =
  | Readonly<{ kind: "complete"; result: BillingPaymentProcessingResult }>
  | Readonly<{ kind: "reject" }>;

const PRINTABLE_ASCII = /^[\x20-\x7e]{16,128}$/u;
const OUT_TRADE_NO = /^[A-Za-z0-9]{32}$/u;
const IDENTIFIER = /^[A-Za-z0-9_*-][A-Za-z0-9_|*-]{0,127}$/u;
const MIN_BILLING_YEAR = 2000;
const MAX_BILLING_YEAR = 9999;
const QUERY_TRANSACTION_KEYS = Object.freeze([
  "source",
  "outTradeNo",
  "transactionId",
  "spMerchantId",
  "spAppId",
  "subMerchantId",
  "tradeState",
  "amountFen",
  "currency",
  "successAt",
] as const);
const NOTIFICATION_TRANSACTION_KEYS = Object.freeze([
  "source",
  "notificationId",
  "outTradeNo",
  "transactionId",
  "spMerchantId",
  "spAppId",
  "subMerchantId",
  "tradeState",
  "amountFen",
  "currency",
  "successAt",
] as const);

type TransactionDataSnapshot = Readonly<{
  source: unknown;
  notificationId?: unknown;
  outTradeNo: unknown;
  transactionId: unknown;
  spMerchantId: unknown;
  spAppId: unknown;
  subMerchantId: unknown;
  tradeState: unknown;
  amountFen: unknown;
  currency: unknown;
  successAt: unknown;
}>;

function invalidInput(): never {
  throw new TypeError("Invalid billing order input");
}

function invalidPersistence(): never {
  throw new TypeError("Invalid billing order persistence");
}

function hasExactKeys(
  keys: readonly PropertyKey[],
  expected: readonly string[],
): boolean {
  return keys.length === expected.length && keys.every(
    (key) => typeof key === "string" && expected.includes(key),
  );
}

function snapshotTransactionData(input: unknown): TransactionDataSnapshot {
  try {
    if (
      typeof input !== "object" || input === null || isProxy(input) ||
      Array.isArray(input)
    ) {
      invalidInput();
    }
    const prototype = Object.getPrototypeOf(input) as unknown;
    if (prototype !== Object.prototype && prototype !== null) invalidInput();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    const expected = hasExactKeys(keys, NOTIFICATION_TRANSACTION_KEYS)
      ? NOTIFICATION_TRANSACTION_KEYS
      : hasExactKeys(keys, QUERY_TRANSACTION_KEYS)
        ? QUERY_TRANSACTION_KEYS
        : invalidInput();
    for (const key of expected) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) invalidInput();
    }
    return Object.freeze(Object.fromEntries(expected.map(
      (key) => [key, descriptors[key]!.value],
    ))) as TransactionDataSnapshot;
  } catch {
    return invalidInput();
  }
}

function paymentException(): BillingFailure {
  return new BillingFailure("BILLING_PAYMENT_EXCEPTION", 409);
}

function canonicalDate(value: Date): CanonicalInstant {
  let epochMs: number;
  try {
    epochMs = Date.prototype.getTime.call(value);
  } catch {
    return invalidInput();
  }
  if (!Number.isFinite(epochMs)) invalidInput();
  const canonical = new Date(epochMs);
  const year = canonical.getUTCFullYear();
  if (year < MIN_BILLING_YEAR || year > MAX_BILLING_YEAR) invalidInput();
  return Object.freeze({ iso: canonical.toISOString(), epochMs });
}

function canonicalPersisted(value: string): CanonicalInstant {
  if (typeof value !== "string") invalidPersistence();
  const parsed = new Date(value);
  const epochMs = Date.prototype.getTime.call(parsed);
  if (
    !Number.isFinite(epochMs) ||
    parsed.getUTCFullYear() < MIN_BILLING_YEAR ||
    parsed.getUTCFullYear() > MAX_BILLING_YEAR ||
    parsed.toISOString() !== value
  ) {
    invalidPersistence();
  }
  return Object.freeze({ iso: value, epochMs });
}

function canonicalVerifiedSuccessAt(value: unknown): CanonicalInstant {
  if (typeof value !== "string") invalidInput();
  const canonical = canonicalDate(new Date(value));
  if (canonical.iso !== value) invalidInput();
  return canonical;
}

function canonicalOrderCreationTime(value: Date): CanonicalInstant {
  const supplied = canonicalDate(value);
  return canonicalDate(new Date(Math.floor(supplied.epochMs / 1_000) * 1_000));
}

function assertIdentifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.isWellFormed() || !IDENTIFIER.test(value)) {
    invalidInput();
  }
}

function assertIdempotencyKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || !PRINTABLE_ASCII.test(value)) invalidInput();
}

function hashIdempotencyKey(userId: string, key: string): string {
  return createHash("sha256").update(userId, "utf8").update("\0").update(key, "utf8").digest("hex");
}

function defaultOutTradeNo(): string {
  return randomBytes(16).toString("hex");
}

function isSafeFen(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export class BillingOrderRepository {
  readonly #spMerchantId: string;
  readonly #spAppId: string;
  readonly #subMerchantId: string;
  readonly #internalId: InternalIdGenerator | undefined;
  readonly #phaseOneSchema: boolean;
  readonly #outTradeNo: () => string;

  constructor(
    private readonly database: CoreDatabase,
    private readonly catalog: BillingCatalogRepository,
    private readonly entitlement: EntitlementActivator,
    options: RepositoryOptions,
  ) {
    if (typeof options !== "object" || options === null) invalidInput();
    assertIdentifier(options.spMerchantId);
    assertIdentifier(options.spAppId);
    assertIdentifier(options.subMerchantId);
    this.#spMerchantId = options.spMerchantId;
    this.#spAppId = options.spAppId;
    this.#subMerchantId = options.subMerchantId;
    this.#internalId = options.internalId;
    this.#phaseOneSchema = (
      this.database.prepare("PRAGMA table_info(billing_orders)").all() as Array<{
        name: string;
      }>
    ).some(({ name }) => name === "offer_version_id");
    this.#outTradeNo = options.outTradeNo ?? defaultOutTradeNo;
  }

  createPending(input: Readonly<{
    userId: string;
    idempotencyKey: string;
    productId: typeof MONTHLY_PRODUCT_ID;
    now: Date;
  }>): Readonly<{ order: BillingOrder; created: boolean }> {
    if (typeof input !== "object" || input === null) invalidInput();
    const userId = input.userId;
    const idempotencyKey = input.idempotencyKey;
    const productId = input.productId;
    assertIdentifier(userId);
    assertIdempotencyKey(idempotencyKey);
    if (productId !== MONTHLY_PRODUCT_ID) invalidInput();
    const decisionNow = canonicalDate(input.now);
    const now = canonicalOrderCreationTime(input.now);
    const keyHash = hashIdempotencyKey(userId, idempotencyKey);

    return withImmediateTransaction(this.database, () => {
      this.assertUserExists(userId);
      this.expireDueOrders(userId, decisionNow);
      const existing = this.orderByIdempotency(userId, keyHash);
      if (existing !== undefined) {
        return Object.freeze({ order: this.toOrder(existing), created: false });
      }
      if (this.hasCurrentMembership(userId, decisionNow)) {
        throw new BillingFailure("BILLING_MEMBERSHIP_ACTIVE", 409);
      }
      if (this.pendingOrder(userId) !== undefined) {
        throw new BillingFailure("BILLING_ORDER_PENDING", 409);
      }

      const price = this.catalog.activeOffer(new Date(decisionNow.epochMs));

      const wechatOutTradeNo = this.#outTradeNo();
      if (!OUT_TRADE_NO.test(wechatOutTradeNo)) {
        invalidInput();
      }
      const expiresAt = canonicalDate(new Date(now.epochMs + ORDER_TTL_MS));
      let insert: (candidate: string) => boolean;
      if (this.#phaseOneSchema) {
        const statement = this.database.prepare(
          `INSERT INTO billing_orders (
            id, user_id, product_id, offer_version_id,
            offer_product_code, offer_display_name, offer_product_type,
            offer_tier_code, offer_currency, offer_amount_fen,
            offer_quota_amount, offer_quota_unit,
            offer_included_duration_ms, offer_period_unit,
            offer_period_count, offer_timezone, offer_rollover,
            offer_auto_renew, offer_active_member_repurchase,
            offer_effective_at, offer_state, amount_fen, currency, status,
            idempotency_key_hash, wechat_out_trade_no,
            wechat_transaction_id, created_at, expires_at, paid_at, refunded_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, 'pending', ?, ?, NULL, ?, ?, NULL, NULL
          ) ON CONFLICT(id) DO NOTHING`,
        );
        insert = (candidate) => {
          if (candidate === wechatOutTradeNo) invalidInput();
          return statement.run(
            candidate,
            userId,
            price.productDatabaseId,
            price.id,
            price.productCode,
            price.displayName,
            price.productType,
            price.tierCode,
            price.currency,
            price.amountFen,
            price.quotaAmount,
            price.quotaUnit,
            price.includedDurationMs,
            price.periodUnit,
            price.periodCount,
            price.timezone,
            Number(price.rollover),
            Number(price.autoRenew),
            Number(price.activeMemberRepurchase),
            price.effectiveAt,
            price.state,
            price.amountFen,
            price.currency,
            keyHash,
            wechatOutTradeNo,
            now.iso,
            expiresAt.iso,
          ).changes === 1;
        };
      } else {
        const statement = this.database.prepare(
          `INSERT INTO billing_orders (
            id, user_id, product_id, price_version_id, amount_fen, status,
            idempotency_key_hash, wechat_out_trade_no, wechat_transaction_id,
            created_at, expires_at, paid_at, refunded_at
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, ?, ?, NULL, NULL)
          ON CONFLICT(id) DO NOTHING`,
        );
        insert = (candidate) => {
          if (candidate === wechatOutTradeNo) invalidInput();
          return statement.run(
            candidate,
            userId,
            MONTHLY_PRODUCT_ID,
            price.id,
            price.amountFen,
            keyHash,
            wechatOutTradeNo,
            now.iso,
            expiresAt.iso,
          ).changes === 1;
        };
      }
      const id = insertWithInternalId({
        ...(this.#internalId === undefined
          ? {}
          : { generate: this.#internalId }),
        insert,
      });
      const created = this.orderById(id);
      if (created === undefined) invalidPersistence();
      return Object.freeze({ order: this.toOrder(created), created: true });
    });
  }

  getForUser(input: Readonly<{
    userId: string;
    orderId: string;
    now: Date;
  }>): BillingOrder {
    if (typeof input !== "object" || input === null) invalidInput();
    assertIdentifier(input.userId);
    assertIdentifier(input.orderId);
    const now = canonicalDate(input.now);
    return withImmediateTransaction(this.database, () => {
      this.expireDueOrders(input.userId, now);
      const row = this.orderById(input.orderId);
      if (row === undefined || row.user_id !== input.userId) {
        throw new BillingFailure("BILLING_INVALID_REQUEST", 404);
      }
      return this.toOrder(row);
    });
  }

  getCurrentForUser(input: Readonly<{
    userId: string;
    now: Date;
  }>): BillingOrder | null {
    if (typeof input !== "object" || input === null) invalidInput();
    assertIdentifier(input.userId);
    const now = canonicalDate(input.now);
    return withImmediateTransaction(this.database, () => {
      this.assertUserExists(input.userId);
      this.expireDueOrders(input.userId, now);
      const row = this.database.prepare(
        `SELECT id, user_id, product_id,
                ${this.#phaseOneSchema ? "offer_version_id" : "price_version_id"} AS price_version_id,
                ${this.#phaseOneSchema
                  ? "offer_display_name"
                  : "'TxChat 月度会员'"} AS display_name,
                amount_fen, status,
                idempotency_key_hash, wechat_out_trade_no, wechat_transaction_id,
                created_at, expires_at, paid_at, refunded_at
         FROM billing_orders
         WHERE user_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      ).get(input.userId) as StoredOrder | undefined;
      if (row === undefined) return null;
      if (row.status === "paid" && this.paidOrderMembershipIsTerminal(row)) {
        return null;
      }
      return this.toOrder(row);
    });
  }

  getForUserByIdempotencyKey(input: Readonly<{
    userId: string;
    idempotencyKey: string;
    now: Date;
  }>): BillingOrder | null {
    if (typeof input !== "object" || input === null) invalidInput();
    assertIdentifier(input.userId);
    assertIdempotencyKey(input.idempotencyKey);
    const now = canonicalDate(input.now);
    const keyHash = hashIdempotencyKey(input.userId, input.idempotencyKey);
    return withImmediateTransaction(this.database, () => {
      this.assertUserExists(input.userId);
      this.expireDueOrders(input.userId, now);
      const row = this.orderByIdempotency(input.userId, keyHash);
      return row === undefined ? null : this.toOrder(row);
    });
  }

  markProviderClosed(input: Readonly<{
    userId: string;
    orderId: string;
    outTradeNo: string;
    at: Date;
  }>): BillingOrder {
    if (typeof input !== "object" || input === null) invalidInput();
    assertIdentifier(input.userId);
    assertIdentifier(input.orderId);
    if (!OUT_TRADE_NO.test(input.outTradeNo)) invalidInput();
    const at = canonicalDate(input.at);
    return withImmediateTransaction(this.database, () => {
      this.expireDueOrders(input.userId, at);
      this.database.prepare(
        `UPDATE billing_orders
         SET status = 'expired'
         WHERE id = ? AND user_id = ? AND wechat_out_trade_no = ?
           AND status IN ('pending', 'expired', 'payment_exception')
           AND paid_at IS NULL AND wechat_transaction_id IS NULL AND refunded_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM wechat_payment_events WHERE order_id = billing_orders.id)`,
      ).run(input.orderId, input.userId, input.outTradeNo);
      const row = this.orderById(input.orderId);
      if (row === undefined || row.user_id !== input.userId) {
        throw new BillingFailure("BILLING_INVALID_REQUEST", 404);
      }
      if (row.wechat_out_trade_no !== input.outTradeNo) invalidPersistence();
      return this.toOrder(row);
    });
  }

  markPaymentException(input: Readonly<{
    orderId: string;
    outTradeNo: string;
    at: Date;
  }>): void {
    if (typeof input !== "object" || input === null) invalidInput();
    assertIdentifier(input.orderId);
    if (!OUT_TRADE_NO.test(input.outTradeNo)) invalidInput();
    canonicalDate(input.at);
    withImmediateTransaction(this.database, () => {
      this.database.prepare(
        `UPDATE billing_orders
         SET status = 'payment_exception'
         WHERE id = ? AND wechat_out_trade_no = ? AND status IN ('pending', 'expired')`,
      ).run(input.orderId, input.outTradeNo);
    });
  }

  completePaidTransaction(
    input: VerifiedWeChatTransaction,
    receivedAt: Date,
  ): BillingPaymentProcessingResult {
    const transaction = this.snapshotTransaction(input);
    const received = canonicalDate(receivedAt);
    const outcome = withImmediateTransaction(this.database, () =>
      this.completeInsideTransaction(transaction, received));
    if (outcome.kind === "reject") throw paymentException();
    return outcome.result;
  }

  private completeInsideTransaction(
    transaction: ReturnType<BillingOrderRepository["snapshotTransaction"]>,
    received: CanonicalInstant,
  ): CompletionOutcome {
    const order = this.orderByOutTradeNo(transaction.outTradeNo);
    if (order === undefined) return Object.freeze({ kind: "reject" });

    const existingEvent = this.paymentEvent(transaction.eventId);
    if (existingEvent !== undefined) {
      if (
        !this.transactionMatches(transaction, order, received) ||
        existingEvent.order_id !== order.id ||
        existingEvent.wechat_transaction_id !== transaction.transactionId ||
        existingEvent.amount_fen !== transaction.amountFen ||
        (order.paid_at !== null && order.paid_at !== transaction.successAt.iso) ||
        existingEvent.result === "rejected"
      ) {
        return Object.freeze({ kind: "reject" });
      }
      const entitlementId = this.entitlementIdForCompletedOrder(order);
      return Object.freeze({
        kind: "complete",
        result: Object.freeze({
          orderId: order.id,
          entitlementId,
          duplicate: true,
          manualRefundRequired: order.status === "payment_exception",
        }),
      });
    }

    if (!this.transactionMatches(transaction, order, received)) {
      this.rejectMappedTransaction(order, transaction, received);
      return Object.freeze({ kind: "reject" });
    }

    const transactionOwner = this.database.prepare(
      "SELECT id FROM billing_orders WHERE wechat_transaction_id = ?",
    ).get(transaction.transactionId) as Readonly<{ id: string }> | undefined;
    if (transactionOwner !== undefined && transactionOwner.id !== order.id) {
      this.rejectMappedTransaction(order, transaction, received);
      return Object.freeze({ kind: "reject" });
    }

    if (order.status === "paid" || order.status === "refunded") {
      if (
        order.wechat_transaction_id !== transaction.transactionId ||
        order.paid_at !== transaction.successAt.iso
      ) {
        this.rejectMappedTransaction(order, transaction, received);
        return Object.freeze({ kind: "reject" });
      }
      const entitlementId = this.entitlementIdForCompletedOrder(order);
      this.insertEvent(order, transaction, "duplicate", received);
      return Object.freeze({
        kind: "complete",
        result: Object.freeze({
          orderId: order.id,
          entitlementId,
          duplicate: true,
          manualRefundRequired: false,
        }),
      });
    }

    if (order.status === "payment_exception") {
      if (
        order.wechat_transaction_id === transaction.transactionId &&
        order.paid_at === transaction.successAt.iso
      ) {
        const entitlementId = this.membershipAt(
          order.user_id,
          transaction.successAt,
          order.id,
        )?.id;
        if (entitlementId === undefined) {
          invalidPersistence();
        }
        this.insertEvent(order, transaction, "duplicate", received);
        return Object.freeze({
          kind: "complete",
          result: Object.freeze({
            orderId: order.id,
            entitlementId,
            duplicate: true,
            manualRefundRequired: true,
          }),
        });
      }
      this.insertEvent(order, transaction, "rejected", received);
      return Object.freeze({ kind: "reject" });
    }

    const historicalMembership = this.membershipAt(
      order.user_id,
      transaction.successAt,
      order.id,
    );
    if (historicalMembership !== undefined) {
      this.database.prepare(
        `UPDATE billing_orders
         SET status = 'payment_exception', wechat_transaction_id = ?, paid_at = ?
         WHERE id = ? AND status IN ('pending', 'expired')`,
      ).run(transaction.transactionId, transaction.successAt.iso, order.id);
      this.insertEvent(order, transaction, "accepted", received);
      return Object.freeze({
        kind: "complete",
        result: Object.freeze({
          orderId: order.id,
          entitlementId: historicalMembership.id,
          duplicate: false,
          manualRefundRequired: true,
        }),
      });
    }

    this.database.prepare(
      `UPDATE billing_orders
       SET status = 'paid', wechat_transaction_id = ?, paid_at = ?
       WHERE id = ? AND status IN ('pending', 'expired')`,
    ).run(transaction.transactionId, transaction.successAt.iso, order.id);
    this.insertEvent(order, transaction, "accepted", received);

    try {
      const entitlement = this.entitlement.activateMonthly({
        userId: order.user_id,
        order: { id: order.id },
        paidAt: new Date(transaction.successAt.epochMs),
      });
      return Object.freeze({
        kind: "complete",
        result: Object.freeze({
          orderId: order.id,
          entitlementId: entitlement.entitlementId,
          duplicate: false,
          manualRefundRequired: false,
        }),
      });
    } catch (error) {
      if (!(error instanceof BillingFailure) || error.code !== "BILLING_MEMBERSHIP_ACTIVE") {
        throw error;
      }
      this.database.prepare(
        "UPDATE billing_orders SET status = 'payment_exception' WHERE id = ? AND status = 'paid'",
      ).run(order.id);
      const entitlementId = this.membershipAt(
        order.user_id,
        transaction.successAt,
        order.id,
      )?.id ?? this.currentMembershipId(order.user_id, transaction.successAt);
      return Object.freeze({
        kind: "complete",
        result: Object.freeze({
          orderId: order.id,
          entitlementId,
          duplicate: false,
          manualRefundRequired: true,
        }),
      });
    }
  }

  private snapshotTransaction(input: VerifiedWeChatTransaction): Readonly<{
    eventId: string;
    outTradeNo: string;
    transactionId: string;
    spMerchantId: unknown;
    spAppId: unknown;
    subMerchantId: unknown;
    tradeState: unknown;
    amountFen: unknown;
    currency: unknown;
    successAt: CanonicalInstant;
  }> {
    const snapshot = snapshotTransactionData(input);
    const source = snapshot.source;
    const hasNotificationId = Object.hasOwn(snapshot, "notificationId");
    if ((source === "notification") !== hasNotificationId) invalidInput();
    const outTradeNo = snapshot.outTradeNo;
    const transactionId = snapshot.transactionId;
    if (typeof outTradeNo !== "string" || !OUT_TRADE_NO.test(outTradeNo)) invalidInput();
    assertIdentifier(transactionId);
    let eventId: string;
    if (source === "notification") {
      const notificationId = snapshot.notificationId;
      assertIdentifier(notificationId);
      eventId = notificationId;
    } else if (source === "query") {
      eventId = `wechat:query:${transactionId}`;
    } else {
      invalidInput();
    }
    return Object.freeze({
      eventId,
      outTradeNo,
      transactionId,
      spMerchantId: snapshot.spMerchantId,
      spAppId: snapshot.spAppId,
      subMerchantId: snapshot.subMerchantId,
      tradeState: snapshot.tradeState,
      amountFen: snapshot.amountFen,
      currency: snapshot.currency,
      successAt: canonicalVerifiedSuccessAt(snapshot.successAt),
    });
  }

  private transactionMatches(
    transaction: ReturnType<BillingOrderRepository["snapshotTransaction"]>,
    order: StoredOrder,
    received: CanonicalInstant,
  ): boolean {
    const createdAt = canonicalPersisted(order.created_at);
    return transaction.spMerchantId === this.#spMerchantId &&
      transaction.spAppId === this.#spAppId &&
      transaction.subMerchantId === this.#subMerchantId &&
      transaction.tradeState === "SUCCESS" &&
      transaction.currency === "CNY" &&
      transaction.amountFen === order.amount_fen &&
      transaction.successAt.epochMs >= createdAt.epochMs &&
      transaction.successAt.epochMs <= received.epochMs;
  }

  private rejectMappedTransaction(
    order: StoredOrder,
    transaction: ReturnType<BillingOrderRepository["snapshotTransaction"]>,
    received: CanonicalInstant,
  ): void {
    this.database.prepare(
      `UPDATE billing_orders
       SET status = 'payment_exception'
       WHERE id = ? AND status IN ('pending', 'expired')`,
    ).run(order.id);
    this.insertEvent(order, transaction, "rejected", received);
  }

  private insertEvent(
    order: StoredOrder,
    transaction: ReturnType<BillingOrderRepository["snapshotTransaction"]>,
    result: "accepted" | "duplicate" | "rejected",
    received: CanonicalInstant,
  ): void {
    if (this.#phaseOneSchema) {
      const statement = this.database.prepare(
        `INSERT INTO wechat_payment_events (
          id, external_notification_id, order_id, wechat_transaction_id,
          amount_fen, currency, result, received_at, processed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING`,
      );
      insertWithInternalId({
        ...(this.#internalId === undefined
          ? {}
          : { generate: this.#internalId }),
        insert: (candidate) => statement.run(
          candidate,
          transaction.eventId,
          order.id,
          transaction.transactionId,
          isSafeFen(transaction.amountFen) ? transaction.amountFen : null,
          transaction.currency === "CNY" ? "CNY" : null,
          result,
          received.iso,
          received.iso,
        ).changes === 1,
      });
      return;
    }
    this.database.prepare(
      `INSERT INTO wechat_payment_events (
        notification_id, order_id, wechat_transaction_id, amount_fen,
        result, received_at, processed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      transaction.eventId,
      order.id,
      transaction.transactionId,
      isSafeFen(transaction.amountFen) ? transaction.amountFen : null,
      result,
      received.iso,
      received.iso,
    );
  }

  private entitlementIdForCompletedOrder(order: StoredOrder): string {
    const row = this.database.prepare(
      "SELECT id FROM billing_entitlements WHERE source_order_id = ? AND kind = 'monthly_membership'",
    ).get(order.id) as Readonly<{ id: string }> | undefined;
    if (row !== undefined) return row.id;
    if (order.status === "payment_exception" && order.paid_at !== null) {
      const historical = this.membershipAt(
        order.user_id,
        canonicalPersisted(order.paid_at),
        order.id,
      );
      if (historical !== undefined) return historical.id;
    }
    invalidPersistence();
  }

  private membershipAt(
    userId: string,
    at: CanonicalInstant,
    excludingSourceOrderId: string,
  ): Readonly<{ id: string }> | undefined {
    const rows = this.database.prepare(
      `SELECT entitlement.id, entitlement.source_order_id,
              entitlement.starts_at, entitlement.ends_at,
              source_order.id AS joined_source_order_id,
              source_order.refunded_at AS source_order_refunded_at,
              early_end.id AS early_end_id,
              early_end.user_id AS early_end_user_id,
              early_end.event_type AS early_end_event_type,
              early_end.dedupe_key AS early_end_dedupe_key,
              early_end.created_at AS early_end_created_at
       FROM billing_entitlements AS entitlement
       LEFT JOIN billing_orders AS source_order
         ON source_order.id = entitlement.source_order_id
        AND source_order.user_id = entitlement.user_id
       LEFT JOIN billing_usage_ledger AS early_end
         ON early_end.entitlement_id = entitlement.id
        AND early_end.reason_code = 'membership_ended_for_trial_regrant'
       WHERE entitlement.user_id = ?
         AND entitlement.kind = 'monthly_membership'
         AND entitlement.source_order_id <> ?
       ORDER BY entitlement.starts_at ASC, entitlement.created_at ASC, entitlement.id ASC`,
    ).all(userId, excludingSourceOrderId) as ReadonlyArray<Readonly<{
      id: string;
      source_order_id: string | null;
      starts_at: string;
      ends_at: string | null;
      joined_source_order_id: string | null;
      source_order_refunded_at: string | null;
      early_end_id: string | null;
      early_end_user_id: string | null;
      early_end_event_type: string | null;
      early_end_dedupe_key: string | null;
      early_end_created_at: string | null;
    }>>;
    const seenEntitlements = new Set<string>();
    const matches = rows.filter((row) => {
      if (
        seenEntitlements.has(row.id) ||
        row.source_order_id === null ||
        row.joined_source_order_id !== row.source_order_id ||
        row.ends_at === null
      ) {
        invalidPersistence();
      }
      seenEntitlements.add(row.id);
      const startsAt = canonicalPersisted(row.starts_at);
      const endsAt = canonicalPersisted(row.ends_at);
      if (endsAt.epochMs <= startsAt.epochMs) invalidPersistence();
      const refundedAt = row.source_order_refunded_at === null
        ? undefined
        : canonicalPersisted(row.source_order_refunded_at);
      if (refundedAt !== undefined && refundedAt.epochMs < startsAt.epochMs) {
        invalidPersistence();
      }
      let effectiveEndMs = refundedAt === undefined
        ? endsAt.epochMs
        : Math.min(endsAt.epochMs, refundedAt.epochMs);
      if (row.early_end_id !== null) {
        if (
          row.early_end_user_id !== userId ||
          row.early_end_event_type !== "expire" ||
          row.early_end_dedupe_key !== `entitlement:${row.id}:expire` ||
          row.early_end_created_at === null
        ) {
          invalidPersistence();
        }
        const earlyEnd = canonicalPersisted(row.early_end_created_at);
        if (earlyEnd.epochMs < startsAt.epochMs) {
          invalidPersistence();
        }
        // Trial regrant preserves the original purchased term. Its expire ledger
        // can shorten the interval, but a late regrant cannot extend natural expiry.
        effectiveEndMs = Math.min(effectiveEndMs, earlyEnd.epochMs);
      }
      return startsAt.epochMs <= at.epochMs && at.epochMs < effectiveEndMs;
    });
    if (matches.length > 1) invalidPersistence();
    const match = matches[0];
    return match === undefined ? undefined : Object.freeze({ id: match.id });
  }

  private currentMembershipId(userId: string, at: CanonicalInstant): string {
    const rows = this.database.prepare(
      `SELECT id, ends_at
       FROM billing_entitlements
       WHERE user_id = ? AND kind = 'monthly_membership'
         AND status IN ('active', 'exhausted')`,
    ).all(userId) as ReadonlyArray<Readonly<{ id: string; ends_at: string | null }>>;
    const current = rows.find((row) =>
      row.ends_at !== null && canonicalPersisted(row.ends_at).epochMs > at.epochMs);
    if (current === undefined) invalidPersistence();
    return current.id;
  }

  private paidOrderMembershipIsTerminal(order: StoredOrder): boolean {
    const rows = this.database.prepare(
      `SELECT user_id, status
       FROM billing_entitlements
       WHERE source_order_id = ? AND kind = 'monthly_membership'
       LIMIT 2`,
    ).all(order.id) as ReadonlyArray<Readonly<{
      user_id: string;
      status: "active" | "exhausted" | "expired" | "voided" | "refunded";
    }>>;
    if (rows.length > 1) invalidPersistence();
    const membership = rows[0];
    if (membership === undefined) {
      // A paid order without an entitlement remains discoverable so the
      // client keeps its duplicate-payment protection during reconciliation.
      return false;
    }
    if (membership.user_id !== order.user_id) invalidPersistence();
    return membership.status === "expired" ||
      membership.status === "voided" ||
      membership.status === "refunded";
  }

  private expireDueOrders(userId: string, now: CanonicalInstant): void {
    this.database.prepare(
      `UPDATE billing_orders
       SET status = 'expired'
       WHERE user_id = ? AND status = 'pending' AND expires_at <= ?`,
    ).run(userId, now.iso);
  }

  private hasCurrentMembership(userId: string, now: CanonicalInstant): boolean {
    const rows = this.database.prepare(
      `SELECT ends_at
       FROM billing_entitlements
       WHERE user_id = ? AND kind = 'monthly_membership'
         AND status IN ('active', 'exhausted')`,
    ).all(userId) as ReadonlyArray<Readonly<{ ends_at: string | null }>>;
    return rows.some((row) => {
      if (row.ends_at === null) invalidPersistence();
      return canonicalPersisted(row.ends_at).epochMs > now.epochMs;
    });
  }

  private assertUserExists(userId: string): void {
    if (this.database.prepare("SELECT 1 FROM users WHERE id = ?").get(userId) === undefined) {
      throw new BillingFailure("BILLING_INVALID_REQUEST", 404);
    }
  }

  private orderByIdempotency(userId: string, hash: string): StoredOrder | undefined {
    return this.database.prepare(
      `SELECT id, user_id, product_id,
              ${this.#phaseOneSchema ? "offer_version_id" : "price_version_id"} AS price_version_id,
              ${this.#phaseOneSchema
                ? "offer_display_name"
                : "'TxChat 月度会员'"} AS display_name,
              amount_fen, status,
              idempotency_key_hash, wechat_out_trade_no, wechat_transaction_id,
              created_at, expires_at, paid_at, refunded_at
       FROM billing_orders WHERE user_id = ? AND idempotency_key_hash = ?`,
    ).get(userId, hash) as StoredOrder | undefined;
  }

  private pendingOrder(userId: string): StoredOrder | undefined {
    return this.database.prepare(
      `SELECT id, user_id, product_id,
              ${this.#phaseOneSchema ? "offer_version_id" : "price_version_id"} AS price_version_id,
              ${this.#phaseOneSchema
                ? "offer_display_name"
                : "'TxChat 月度会员'"} AS display_name,
              amount_fen, status,
              idempotency_key_hash, wechat_out_trade_no, wechat_transaction_id,
              created_at, expires_at, paid_at, refunded_at
       FROM billing_orders WHERE user_id = ? AND status = 'pending'`,
    ).get(userId) as StoredOrder | undefined;
  }

  private orderById(id: string): StoredOrder | undefined {
    return this.database.prepare(
      `SELECT id, user_id, product_id,
              ${this.#phaseOneSchema ? "offer_version_id" : "price_version_id"} AS price_version_id,
              ${this.#phaseOneSchema
                ? "offer_display_name"
                : "'TxChat 月度会员'"} AS display_name,
              amount_fen, status,
              idempotency_key_hash, wechat_out_trade_no, wechat_transaction_id,
              created_at, expires_at, paid_at, refunded_at
       FROM billing_orders WHERE id = ?`,
    ).get(id) as StoredOrder | undefined;
  }

  private orderByOutTradeNo(outTradeNo: string): StoredOrder | undefined {
    return this.database.prepare(
      `SELECT id, user_id, product_id,
              ${this.#phaseOneSchema ? "offer_version_id" : "price_version_id"} AS price_version_id,
              ${this.#phaseOneSchema
                ? "offer_display_name"
                : "'TxChat 月度会员'"} AS display_name,
              amount_fen, status,
              idempotency_key_hash, wechat_out_trade_no, wechat_transaction_id,
              created_at, expires_at, paid_at, refunded_at
       FROM billing_orders WHERE wechat_out_trade_no = ?`,
    ).get(outTradeNo) as StoredOrder | undefined;
  }

  private paymentEvent(id: string): StoredPaymentEvent | undefined {
    return this.database.prepare(
      `SELECT ${this.#phaseOneSchema
        ? "external_notification_id"
        : "notification_id"} AS notification_id,
              order_id, wechat_transaction_id, amount_fen, result
       FROM wechat_payment_events
       WHERE ${this.#phaseOneSchema
         ? "external_notification_id"
         : "notification_id"} = ?`,
    ).get(id) as StoredPaymentEvent | undefined;
  }

  private toOrder(row: StoredOrder): BillingOrder {
    if (
      (!this.#phaseOneSchema && row.product_id !== MONTHLY_PRODUCT_ID) ||
      !isSafeFen(row.amount_fen) ||
      !isInternalId(row.id) ||
      !OUT_TRADE_NO.test(row.wechat_out_trade_no)
    ) {
      invalidPersistence();
    }
    const createdAt = canonicalPersisted(row.created_at);
    const expiresAt = canonicalPersisted(row.expires_at);
    if (expiresAt.epochMs - createdAt.epochMs !== ORDER_TTL_MS) invalidPersistence();
    if (row.paid_at !== null) canonicalPersisted(row.paid_at);
    if (row.refunded_at !== null) canonicalPersisted(row.refunded_at);
    return Object.freeze({
      id: row.id,
      userId: row.user_id,
      productId: MONTHLY_PRODUCT_ID,
      priceVersionId: row.price_version_id,
      displayName: row.display_name,
      amountFen: row.amount_fen,
      status: row.status,
      wechatOutTradeNo: row.wechat_out_trade_no,
      wechatTransactionId: row.wechat_transaction_id,
      createdAt: createdAt.iso,
      expiresAt: expiresAt.iso,
      paidAt: row.paid_at,
      refundedAt: row.refunded_at,
    });
  }
}
