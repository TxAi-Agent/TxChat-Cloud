import type {
  BillingOrder,
  BillingOrderStatus,
  BillingPaymentCompletion,
  BillingOrderRepository,
} from "./billingOrderRepository.js";
import { BillingFailure, MONTHLY_PRODUCT_ID } from "./billingTypes.js";
import type {
  VerifiedWeChatTransaction,
  WeChatPaymentProvider,
} from "./wechatNativePayment.js";
import { WeChatPaymentError } from "./wechatNativePayment.js";

export type CreatedBillingOrder = Readonly<{
  orderId: string;
  status: BillingOrderStatus;
  amountFen: number;
  currency: "CNY";
  codeUrl: string | null;
  codeUrlRecoveryAvailableAt: string | null;
  createdAt: string;
  expiresAt: string;
  serverTime: string;
  paidAt: string | null;
  paidAmountFen: number | null;
}>;

export type BillingOrderView = CreatedBillingOrder;

export type BillingReconciliationAnomaly = Readonly<{
  category: "second_genuine_payment";
  orderId: string;
  requiredAction: "manual_full_refund";
}>;

type BillingClock = Readonly<{ now: () => Date }>;
type BillingServiceOptions = Readonly<{
  clock?: BillingClock;
  onReconciliationAnomaly?: (anomaly: BillingReconciliationAnomaly) => void;
}>;
type CachedNativeCodeUrl = Readonly<{
  codeUrl: string;
  expiresAtMs: number;
}>;
type ActiveRecoveryOperation = Readonly<{
  userId: string;
  idempotencyKey: string;
  promise: Promise<CreatedBillingOrder>;
}>;

const QUERY_MINIMUM_AGE_MS = 2_000;
const QUERY_INTERVAL_MS = 2_000;
const CODE_URL_RECOVERY_MINIMUM_AGE_MS = 5 * 60_000;

function invalidInput(): never {
  throw new TypeError("Invalid billing service input");
}

function snapshotOwnData(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      invalidInput();
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) invalidInput();
    const allowed = new Set([...required, ...optional]);
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || !allowed.has(key)) invalidInput();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) invalidInput();
      result[key] = descriptor.value;
    }
    if (!required.every((key) => Object.hasOwn(result, key))) invalidInput();
    return Object.freeze(result);
  } catch {
    return invalidInput();
  }
}

function snapshotCreateInput(value: unknown): Readonly<{
  userId: string;
  idempotencyKey: string;
  productId?: typeof MONTHLY_PRODUCT_ID;
}> {
  const input = snapshotOwnData(value, ["userId", "idempotencyKey"], ["productId"]);
  if (
    typeof input.userId !== "string" ||
    typeof input.idempotencyKey !== "string" ||
    (input.productId !== undefined && input.productId !== MONTHLY_PRODUCT_ID)
  ) {
    invalidInput();
  }
  return Object.freeze({
    userId: input.userId,
    idempotencyKey: input.idempotencyKey,
    ...(input.productId === undefined ? {} : { productId: MONTHLY_PRODUCT_ID }),
  });
}

function snapshotGetInput(value: unknown): Readonly<{
  userId: string;
  orderId: string;
}> {
  const input = snapshotOwnData(value, ["userId", "orderId"]);
  if (typeof input.userId !== "string" || typeof input.orderId !== "string") {
    invalidInput();
  }
  return Object.freeze({ userId: input.userId, orderId: input.orderId });
}

function snapshotCurrentInput(value: unknown): Readonly<{ userId: string }> {
  const input = snapshotOwnData(value, ["userId"]);
  if (typeof input.userId !== "string") invalidInput();
  return Object.freeze({ userId: input.userId });
}

function snapshotRecoverInput(value: unknown): Readonly<{
  userId: string;
  orderId: string;
  idempotencyKey: string;
}> {
  const input = snapshotOwnData(value, ["userId", "orderId", "idempotencyKey"]);
  if (
    typeof input.userId !== "string" ||
    typeof input.orderId !== "string" ||
    typeof input.idempotencyKey !== "string"
  ) {
    invalidInput();
  }
  return Object.freeze({
    userId: input.userId,
    orderId: input.orderId,
    idempotencyKey: input.idempotencyKey,
  });
}

function epoch(value: Date): number {
  let result: number;
  try {
    result = Date.prototype.getTime.call(value);
  } catch {
    return invalidInput();
  }
  if (!Number.isFinite(result)) invalidInput();
  return result;
}

function validCodeUrl(value: unknown): value is string {
  return typeof value === "string" &&
    value.isWellFormed() &&
    Buffer.byteLength(value, "utf8") >= 10 &&
    Buffer.byteLength(value, "utf8") <= 2_048 &&
    value.startsWith("weixin://") &&
    !/[\u0000-\u0020\u007f]/u.test(value);
}

function wechatShanghaiSecondInstant(value: string): string {
  if (typeof value !== "string" || !value.endsWith(".000Z")) invalidInput();
  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs) || new Date(epochMs).toISOString() !== value) {
    invalidInput();
  }
  const shanghaiWallClock = new Date(epochMs + 8 * 60 * 60_000)
    .toISOString()
    .slice(0, 19);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u.test(shanghaiWallClock)) {
    invalidInput();
  }
  return `${shanghaiWallClock}+08:00`;
}

export class BillingService {
  readonly #clock: BillingClock;
  readonly #onReconciliationAnomaly: (anomaly: BillingReconciliationAnomaly) => void;
  readonly #createOperations = new Map<string, Promise<CreatedBillingOrder>>();
  readonly #recoveryOperations = new Map<string, ActiveRecoveryOperation>();
  readonly #nativeCodeUrls = new Map<string, CachedNativeCodeUrl>();
  readonly #lastQueryAt = new Map<string, number>();

  constructor(
    private readonly orders: BillingOrderRepository,
    private readonly payment: WeChatPaymentProvider,
    options: BillingServiceOptions = {},
  ) {
    this.#clock = options.clock ?? { now: () => new Date() };
    this.#onReconciliationAnomaly = options.onReconciliationAnomaly ?? (() => undefined);
  }

  async createOrder(input: Readonly<{
    userId: string;
    idempotencyKey: string;
    productId?: typeof MONTHLY_PRODUCT_ID;
  }>): Promise<CreatedBillingOrder> {
    const request = snapshotCreateInput(input);
    const now = this.#clock.now();
    this.pruneNativeCodeUrls(epoch(now));
    const created = this.orders.createPending({
      userId: request.userId,
      idempotencyKey: request.idempotencyKey,
      productId: MONTHLY_PRODUCT_ID,
      now,
    });
    const active = this.#createOperations.get(created.order.id);
    if (active !== undefined) return active;
    const pendingAndUnexpired =
      created.order.status === "pending" && Date.parse(created.order.expiresAt) > epoch(now);
    if (!pendingAndUnexpired) {
      return this.asOrderView(created.order, now);
    }
    if (this.#nativeCodeUrls.has(created.order.id)) {
      return this.asOrderView(created.order, now);
    }
    if (!created.created) return this.asOrderView(created.order, now);

    const operation = this.createProviderOrder(created.order);
    this.#createOperations.set(created.order.id, operation);
    try {
      return await operation;
    } finally {
      this.#createOperations.delete(created.order.id);
    }
  }

  completePaidTransaction(
    input: VerifiedWeChatTransaction,
    receivedAt: Date = this.#clock.now(),
  ): BillingPaymentCompletion {
    const result = this.orders.completePaidTransaction(input, receivedAt);
    this.#nativeCodeUrls.delete(result.orderId);
    if (result.manualRefundRequired && !result.duplicate) {
      try {
        this.#onReconciliationAnomaly(Object.freeze({
          category: "second_genuine_payment",
          orderId: result.orderId,
          requiredAction: "manual_full_refund",
        }));
      } catch {
        // The durable payment_exception remains the source of truth even if logging fails.
      }
    }
    return Object.freeze({
      orderId: result.orderId,
      entitlementId: result.entitlementId,
      duplicate: result.duplicate,
    });
  }

  async getOrder(input: Readonly<{
    userId: string;
    orderId: string;
  }>): Promise<BillingOrderView> {
    const request = snapshotGetInput(input);
    const now = this.#clock.now();
    const nowMs = epoch(now);
    this.pruneQueryThrottle(nowMs);
    const order = this.orders.getForUser({ ...request, now });
    return this.synchronizeOrder(order, request.userId, now, QUERY_MINIMUM_AGE_MS);
  }

  async getCurrentOrder(input: Readonly<{
    userId: string;
  }>): Promise<BillingOrderView | null> {
    const request = snapshotCurrentInput(input);
    const now = this.#clock.now();
    this.pruneQueryThrottle(epoch(now));
    const order = this.orders.getCurrentForUser({ userId: request.userId, now });
    if (order === null) return null;
    return this.synchronizeOrder(order, request.userId, now, 0);
  }

  async recoverOrder(input: Readonly<{
    userId: string;
    orderId: string;
    idempotencyKey: string;
  }>): Promise<CreatedBillingOrder> {
    const request = snapshotRecoverInput(input);
    const validationNow = this.#clock.now();
    epoch(validationNow);
    this.orders.getForUser({
      userId: request.userId,
      orderId: request.orderId,
      now: validationNow,
    });
    const replay = this.orders.getForUserByIdempotencyKey({
      userId: request.userId,
      idempotencyKey: request.idempotencyKey,
      now: validationNow,
    });
    if (replay !== null) {
      if (replay.id === request.orderId) {
        throw new BillingFailure("BILLING_INVALID_REQUEST", 400);
      }
      return this.asOrderView(replay, validationNow);
    }
    const active = this.#recoveryOperations.get(request.orderId);
    if (active !== undefined) {
      if (
        active.userId === request.userId &&
        active.idempotencyKey === request.idempotencyKey
      ) {
        return active.promise;
      }
      throw new BillingFailure("BILLING_ORDER_PENDING", 409);
    }
    const operation = this.performRecovery(request);
    this.#recoveryOperations.set(request.orderId, Object.freeze({
      userId: request.userId,
      idempotencyKey: request.idempotencyKey,
      promise: operation,
    }));
    try {
      return await operation;
    } finally {
      if (this.#recoveryOperations.get(request.orderId)?.promise === operation) {
        this.#recoveryOperations.delete(request.orderId);
      }
    }
  }

  private async synchronizeOrder(
    original: BillingOrder,
    userId: string,
    now: Date,
    minimumAgeMs: number,
  ): Promise<BillingOrderView> {
    const nowMs = epoch(now);
    let order = original;
    const unpaidException = order.status === "payment_exception" && order.paidAt === null &&
      order.wechatTransactionId === null && order.refundedAt === null;
    if (order.status !== "pending" && order.status !== "expired" && !unpaidException) {
      this.#lastQueryAt.delete(order.id);
      return this.asOrderView(order, now);
    }
    const createdAtMs = Date.parse(order.createdAt);
    if (
      !Number.isFinite(createdAtMs) ||
      (minimumAgeMs > 0 && nowMs - createdAtMs <= minimumAgeMs)
    ) {
      return this.asOrderView(order, now);
    }
    const lastQueryAt = this.#lastQueryAt.get(order.id);
    if (lastQueryAt !== undefined && nowMs - lastQueryAt < QUERY_INTERVAL_MS) {
      return this.asOrderView(order, now);
    }
    this.#lastQueryAt.set(order.id, nowMs);
    try {
      const result = await this.payment.queryByOutTradeNo(order.wechatOutTradeNo);
      if (result.kind === "success") {
        if (result.transaction.outTradeNo === order.wechatOutTradeNo) {
          this.completePaidTransaction(result.transaction, now);
        }
      } else if (result.kind === "exception") {
        if (result.outTradeNo === order.wechatOutTradeNo) {
          this.applyProviderException(order, userId, result.tradeState, now);
          if (result.tradeState === "CLOSED") this.#lastQueryAt.delete(order.id);
        }
      } else if (result.kind === "pending") {
        // The local 15-minute expiry remains authoritative until a real payment is confirmed.
      }
    } catch (error) {
      if (
        !(error instanceof WeChatPaymentError) &&
        !(error instanceof BillingFailure && error.code === "BILLING_PAYMENT_EXCEPTION")
      ) {
        throw error;
      }
      // Provider failures and already-persisted rejected confirmations leave/re-read local truth.
    }
    order = this.orders.getForUser({ userId, orderId: order.id, now });
    if (order.status === "paid" || order.status === "refunded") {
      this.#lastQueryAt.delete(order.id);
    }
    return this.asOrderView(order, now);
  }

  private applyProviderException(order: BillingOrder, userId: string, tradeState: string, now: Date): void {
    if (tradeState === "CLOSED") {
      // A verified unpaid close is not an unknown payment result. The repository
      // checks for payment/refund evidence atomically before releasing the order.
      this.orders.markProviderClosed({ userId, orderId: order.id, outTradeNo: order.wechatOutTradeNo, at: now });
    } else {
      this.orders.markPaymentException({ orderId: order.id, outTradeNo: order.wechatOutTradeNo, at: now });
    }
  }

  private async performRecovery(request: Readonly<{
    userId: string;
    orderId: string;
    idempotencyKey: string;
  }>): Promise<CreatedBillingOrder> {
    const now = this.#clock.now();
    const nowMs = epoch(now);
    this.pruneNativeCodeUrls(nowMs);
    const replay = this.orders.getForUserByIdempotencyKey({
      userId: request.userId,
      idempotencyKey: request.idempotencyKey,
      now,
    });
    if (replay !== null) {
      if (replay.id === request.orderId) {
        throw new BillingFailure("BILLING_INVALID_REQUEST", 400);
      }
      return this.asOrderView(replay, now);
    }
    let order = this.orders.getForUser({
      userId: request.userId,
      orderId: request.orderId,
      now,
    });
    if (order.status === "payment_exception") {
      return this.synchronizeOrder(order, request.userId, now, 0);
    }
    if (order.status !== "pending" && order.status !== "expired") {
      return this.asOrderView(order, now);
    }
    if (this.#nativeCodeUrls.has(order.id)) return this.asOrderView(order, now);

    let query;
    try {
      query = await this.payment.queryByOutTradeNo(order.wechatOutTradeNo);
    } catch (error) {
      if (error instanceof WeChatPaymentError) {
        throw new BillingFailure("BILLING_SERVICE_UNAVAILABLE", 503);
      }
      throw error;
    }
    if (query.kind === "success") {
      this.completePaidTransaction(query.transaction, now);
      order = this.orders.getForUser({
        userId: request.userId,
        orderId: request.orderId,
        now,
      });
      return this.asOrderView(order, now);
    }
    if (query.kind === "exception") {
      if (query.outTradeNo === order.wechatOutTradeNo) {
        this.applyProviderException(order, request.userId, query.tradeState, now);
      }
      order = this.orders.getForUser({
        userId: request.userId,
        orderId: request.orderId,
        now,
      });
      return this.asOrderView(order, now);
    }
    const createdAtMs = Date.parse(order.createdAt);
    if (
      !Number.isFinite(createdAtMs) ||
      nowMs - createdAtMs < CODE_URL_RECOVERY_MINIMUM_AGE_MS
    ) {
      return this.asOrderView(order, now);
    }
    try {
      await this.payment.closeOrder(order.wechatOutTradeNo);
    } catch (error) {
      if (!(error instanceof WeChatPaymentError)) throw error;
      let raced;
      try {
        raced = await this.payment.queryByOutTradeNo(order.wechatOutTradeNo);
      } catch (queryError) {
        if (queryError instanceof WeChatPaymentError) {
          throw new BillingFailure("BILLING_SERVICE_UNAVAILABLE", 503);
        }
        throw queryError;
      }
      if (
        raced.kind === "success" &&
        raced.transaction.outTradeNo === order.wechatOutTradeNo
      ) {
        this.completePaidTransaction(raced.transaction, now);
        const paid = this.orders.getForUser({
          userId: request.userId,
          orderId: request.orderId,
          now,
        });
        return this.asOrderView(paid, now);
      }
      if (
        raced.kind !== "exception" ||
        raced.outTradeNo !== order.wechatOutTradeNo
      ) {
        throw new BillingFailure("BILLING_SERVICE_UNAVAILABLE", 503);
      }
      if (raced.tradeState !== "CLOSED") {
        this.orders.markPaymentException({
          orderId: order.id,
          outTradeNo: order.wechatOutTradeNo,
          at: now,
        });
        const terminal = this.orders.getForUser({
          userId: request.userId,
          orderId: request.orderId,
          now,
        });
        return this.asOrderView(terminal, now);
      }
      // A lost close response can race with an authoritative CLOSED query.
      // Continue through the same durable close-and-replace path as a 204 response.
    }
    order = this.orders.markProviderClosed({
      userId: request.userId,
      orderId: order.id,
      outTradeNo: order.wechatOutTradeNo,
      at: now,
    });
    this.#nativeCodeUrls.delete(order.id);
    this.#lastQueryAt.delete(order.id);
    if (order.status !== "expired") return this.asOrderView(order, now);
    const replacement = this.orders.createPending({
      userId: request.userId,
      idempotencyKey: request.idempotencyKey,
      productId: MONTHLY_PRODUCT_ID,
      now,
    });
    if (!replacement.created) return this.asOrderView(replacement.order, now);
    return this.createProviderOrder(replacement.order);
  }

  private pruneQueryThrottle(nowMs: number): void {
    const staleAtOrBefore = nowMs - QUERY_INTERVAL_MS;
    for (const [orderId, queriedAt] of this.#lastQueryAt) {
      if (!Number.isFinite(queriedAt) || queriedAt <= staleAtOrBefore) {
        this.#lastQueryAt.delete(orderId);
      }
    }
  }

  private pruneNativeCodeUrls(nowMs: number): void {
    for (const [orderId, cached] of this.#nativeCodeUrls) {
      if (!Number.isFinite(cached.expiresAtMs) || cached.expiresAtMs <= nowMs) {
        this.#nativeCodeUrls.delete(orderId);
      }
    }
  }

  private async createProviderOrder(order: BillingOrder): Promise<CreatedBillingOrder> {
    const providerExpiresAt = wechatShanghaiSecondInstant(order.expiresAt);
    const providerOrder = await this.payment.createNativeOrder({
      outTradeNo: order.wechatOutTradeNo,
      description: order.displayName,
      amountFen: order.amountFen,
      expiresAt: providerExpiresAt,
    });
    if (
      providerOrder.expiresAt !== providerExpiresAt ||
      Date.parse(providerOrder.expiresAt) !== Date.parse(order.expiresAt) ||
      !validCodeUrl(providerOrder.codeUrl)
    ) {
      invalidInput();
    }
    this.#nativeCodeUrls.set(order.id, Object.freeze({
      codeUrl: providerOrder.codeUrl,
      expiresAtMs: Date.parse(order.expiresAt),
    }));
    return this.asOrderView(order, this.#clock.now());
  }

  private asOrderView(order: BillingOrder, now: Date): BillingOrderView {
    const nowMs = epoch(now);
    const pendingAndUnexpired =
      order.status === "pending" && Date.parse(order.expiresAt) > nowMs;
    const codeUrl = pendingAndUnexpired
      ? this.#nativeCodeUrls.get(order.id)?.codeUrl ?? null
      : null;
    if (!pendingAndUnexpired) this.#nativeCodeUrls.delete(order.id);
    const recoveryAtMs = Date.parse(order.createdAt) + CODE_URL_RECOVERY_MINIMUM_AGE_MS;
    return Object.freeze({
      orderId: order.id,
      status: order.status,
      amountFen: order.amountFen,
      currency: "CNY" as const,
      codeUrl,
      codeUrlRecoveryAvailableAt:
        pendingAndUnexpired && codeUrl === null && Number.isFinite(recoveryAtMs)
          ? new Date(recoveryAtMs).toISOString()
          : null,
      createdAt: order.createdAt,
      expiresAt: order.expiresAt,
      serverTime: new Date(nowMs).toISOString(),
      paidAt: order.paidAt,
      paidAmountFen: order.paidAt === null ? null : order.amountFen,
    });
  }
}
