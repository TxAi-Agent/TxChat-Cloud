import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { performance } from "node:perf_hooks";

import { AuthFailure, type AuthService } from "../auth/authService.js";
import type {
  BillingCatalogRepository,
  BillingOffer,
} from "./billingCatalogRepository.js";
import type {
  BillingEntitlementRepository,
  BillingEntitlementStatus,
} from "./billingEntitlementRepository.js";
import type {
  BillingOrderView,
  BillingService,
  CreatedBillingOrder,
} from "./billingService.js";
import {
  BillingFailure,
  MAX_MEMBERSHIP_DURATION_MS,
  isMembershipDuration,
  MONTHLY_PRODUCT_ID,
  PHASE_ONE_MONTHLY_OFFER,
  isStoredMonthlyOfferName,
} from "./billingTypes.js";
import type {
  VerifiedWeChatNotificationTransaction,
  WeChatPaymentProvider,
} from "./wechatNativePayment.js";

const CALLBACK_BODY_LIMIT = 65_536;
const IDEMPOTENCY_KEY = /^[\x20-\x7e]{16,128}$/u;
const ORDER_ID = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{32}$/u;
const CODE_URL_UNSAFE_CHARACTERS = /[\u0000-\u0020\u007f]/u;
const MAX_AMOUNT_FEN = 100_000_000;
const MAX_INCLUDED_DURATION_MS = MAX_MEMBERSHIP_DURATION_MS;
const RATE_WINDOW_MS = 60_000;
const MAX_RATE_BUCKETS = 10_000;
const ORDER_STATUSES = new Set([
  "pending",
  "paid",
  "expired",
  "payment_exception",
  "refunded",
]);
const ENTITLEMENT_KINDS = new Set(["trial", "monthly_membership", "none"]);
const ENTITLEMENT_STATUSES = new Set([
  "active",
  "exhausted",
  "expired",
  "voided",
  "refunded",
  "unavailable",
]);

type BillingAuthService = Pick<AuthService, "authenticateAccessToken">;
type BillingCatalog = Pick<BillingCatalogRepository, "publicOffer">;
type BillingEntitlements = Pick<BillingEntitlementRepository, "status">;
type PublicBillingService = Pick<
  BillingService,
  | "createOrder"
  | "getOrder"
  | "getCurrentOrder"
  | "recoverOrder"
  | "completePaidTransaction"
>;
type BillingPayment = Pick<WeChatPaymentProvider, "verifyNotification">;

export type BillingRoutesOptions = Readonly<{
  authService: BillingAuthService;
  catalog: BillingCatalog;
  entitlements: BillingEntitlements;
  billingService: PublicBillingService;
  payment: BillingPayment;
  now?: () => Date;
  rateLimitNow?: () => number;
  salesAvailable?: boolean;
}>;

type PublicBillingFailureCode =
  | "AUTH_REQUIRED"
  | "SESSION_REPLACED"
  | "SESSION_EXPIRED"
  | "ACCOUNT_DISABLED"
  | "BILLING_NOT_CONFIGURED"
  | "BILLING_SALES_PAUSED"
  | "BILLING_ORDER_PENDING"
  | "BILLING_MEMBERSHIP_ACTIVE"
  | "BILLING_PAYMENT_EXCEPTION"
  | "BILLING_INVALID_REQUEST"
  | "BILLING_SERVICE_UNAVAILABLE"
  | "TOO_MANY_REQUESTS";

const failureMessages: Readonly<Record<PublicBillingFailureCode, string>> =
  Object.freeze({
    AUTH_REQUIRED: "请重新验证手机号",
    SESSION_REPLACED: "会话已在其他设备更新，请重新验证手机号",
    SESSION_EXPIRED: "会话已过期，请重新验证手机号",
    ACCOUNT_DISABLED: "账户当前不可用",
    BILLING_NOT_CONFIGURED: "会员价格暂未配置",
    BILLING_SALES_PAUSED: "会员购买暂未开放",
    BILLING_ORDER_PENDING: "已有待支付订单",
    BILLING_MEMBERSHIP_ACTIVE: "当前会员仍在有效期内",
    BILLING_PAYMENT_EXCEPTION: "支付状态需要人工处理",
    BILLING_INVALID_REQUEST: "会员请求格式无效",
    BILLING_SERVICE_UNAVAILABLE: "会员服务暂时不可用",
    TOO_MANY_REQUESTS: "请求过于频繁，请稍后重试",
  });

type RateRoute =
  | "offer"
  | "status"
  | "createOrder"
  | "getOrder"
  | "currentOrder"
  | "recoverOrder";
type RateBucket = { startedAt: number; count: number };

class BillingRouteRateLimiter {
  readonly #buckets = new Map<string, RateBucket>();
  #lastObserved = Number.NEGATIVE_INFINITY;
  #lastSweep = Number.NEGATIVE_INFINITY;

  constructor(private readonly now: () => number) {}

  consume(
    accountId: string,
    route: RateRoute,
    limit: number,
  ): Readonly<{ allowed: boolean; retryAfterSeconds?: number }> {
    let current: number;
    try {
      current = this.now();
    } catch {
      return Object.freeze({ allowed: false, retryAfterSeconds: 60 });
    }
    if (
      !Number.isFinite(current) ||
      current < 0 ||
      current < this.#lastObserved
    ) {
      return Object.freeze({ allowed: false, retryAfterSeconds: 60 });
    }
    this.#lastObserved = current;
    if (
      current - this.#lastSweep >= 1_000 ||
      this.#buckets.size >= MAX_RATE_BUCKETS
    ) {
      for (const [key, bucket] of this.#buckets) {
        if (current - bucket.startedAt >= RATE_WINDOW_MS) {
          this.#buckets.delete(key);
        }
      }
      this.#lastSweep = current;
    }

    const key = `${route}\0${accountId}`;
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      if (this.#buckets.size >= MAX_RATE_BUCKETS) {
        return Object.freeze({ allowed: false, retryAfterSeconds: 60 });
      }
      bucket = { startedAt: current, count: 0 };
      this.#buckets.set(key, bucket);
    } else if (current - bucket.startedAt >= RATE_WINDOW_MS) {
      bucket.startedAt = current;
      bucket.count = 0;
    }
    if (bucket.count >= limit) {
      return Object.freeze({
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((bucket.startedAt + RATE_WINDOW_MS - current) / 1_000),
        ),
      });
    }
    bucket.count += 1;
    return Object.freeze({ allowed: true });
  }

  dispose(): void {
    this.#buckets.clear();
  }
}

function invalidRequest(): BillingFailure {
  return new BillingFailure("BILLING_INVALID_REQUEST", 400);
}

function unavailable(): BillingFailure {
  return new BillingFailure("BILLING_SERVICE_UNAVAILABLE", 503);
}

function bearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  const match =
    typeof authorization === "string"
      ? /^Bearer ([^\s]+)$/u.exec(authorization)
      : null;
  if (match?.[1] === undefined) throw new AuthFailure("AUTH_REQUIRED", 401);
  return match[1];
}

function stableFailure(error: unknown): Readonly<{
  code: PublicBillingFailureCode;
  statusCode: number;
}> {
  if (error instanceof AuthFailure) {
    if (
      error.code === "AUTH_REQUIRED" ||
      error.code === "SESSION_REPLACED" ||
      error.code === "SESSION_EXPIRED"
    ) {
      return Object.freeze({ code: error.code, statusCode: 401 });
    }
    if (error.code === "ACCOUNT_DISABLED") {
      return Object.freeze({ code: error.code, statusCode: 403 });
    }
    return Object.freeze({
      code: "BILLING_SERVICE_UNAVAILABLE",
      statusCode: 503,
    });
  }
  if (error instanceof BillingFailure) {
    switch (error.code) {
      case "BILLING_NOT_CONFIGURED":
      case "BILLING_SALES_PAUSED":
      case "BILLING_ORDER_PENDING":
      case "BILLING_MEMBERSHIP_ACTIVE":
      case "BILLING_PAYMENT_EXCEPTION":
        return Object.freeze({ code: error.code, statusCode: 409 });
      case "BILLING_INVALID_REQUEST":
        return Object.freeze({
          code: error.code,
          statusCode: error.statusCode === 404 ? 404 : 400,
        });
      case "BILLING_SERVICE_UNAVAILABLE":
        return Object.freeze({ code: error.code, statusCode: 503 });
      default:
        break;
    }
  }
  return Object.freeze({
    code: "BILLING_SERVICE_UNAVAILABLE",
    statusCode: 503,
  });
}

function sendFailure(reply: FastifyReply, error: unknown): FastifyReply {
  const failure = stableFailure(error);
  return reply.code(failure.statusCode).send({
    code: failure.code,
    message: failureMessages[failure.code],
  });
}

function sendRateFailure(
  reply: FastifyReply,
  retryAfterSeconds: number,
): FastifyReply {
  reply.header("Retry-After", String(retryAfterSeconds));
  return reply.code(429).send({
    code: "TOO_MANY_REQUESTS",
    message: failureMessages.TOO_MANY_REQUESTS,
    retryAfterSeconds,
  });
}

function sendCallbackFailure(reply: FastifyReply): FastifyReply {
  return reply.code(500).send({
    code: "BILLING_CALLBACK_FAILED",
    message: "支付通知处理失败",
  });
}

function isPlainDataObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor;
  });
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function isFrameworkDataRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalInstantOrNull(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isCanonicalInstant(value: unknown): value is string {
  return value !== null && isCanonicalInstantOrNull(value);
}

function publicOffer(
  offer: BillingOffer,
  salesAvailable: boolean,
): Readonly<{
  productId: typeof MONTHLY_PRODUCT_ID;
  displayName: string;
  amountFen: number;
  currency: "CNY";
  includedDurationMs: number;
  purchasable: boolean;
}> {
  if (
    !isPlainDataObject(offer) ||
    offer.productId !== MONTHLY_PRODUCT_ID ||
    !isStoredMonthlyOfferName(offer.displayName) ||
    !Number.isSafeInteger(offer.amountFen) ||
    offer.amountFen <= 0 ||
    offer.amountFen > MAX_AMOUNT_FEN ||
    !isMembershipDuration(offer.includedDurationMs) ||
    typeof offer.purchasable !== "boolean"
  ) {
    throw unavailable();
  }
  return Object.freeze({
    productId: MONTHLY_PRODUCT_ID,
    displayName: offer.displayName,
    amountFen: offer.amountFen,
    currency: "CNY",
    includedDurationMs: offer.includedDurationMs,
    purchasable: salesAvailable && offer.purchasable,
  });
}

function publicStatus(
  status: BillingEntitlementStatus,
  purchaseAvailable: boolean,
) {
  if (
    !isPlainDataObject(status) ||
    !ENTITLEMENT_KINDS.has(status.kind) ||
    !ENTITLEMENT_STATUSES.has(status.status) ||
    !Number.isSafeInteger(status.remainingDurationMs) ||
    status.remainingDurationMs < 0 ||
    status.remainingDurationMs > MAX_INCLUDED_DURATION_MS ||
    !isCanonicalInstantOrNull(status.startsAt) ||
    !isCanonicalInstantOrNull(status.endsAt) ||
    typeof status.purchaseAllowed !== "boolean"
  ) {
    throw unavailable();
  }
  const membershipPurchase = publicMembershipPurchase(status);
  return Object.freeze({
    kind: status.kind,
    status: status.status,
    remainingDurationMs: status.remainingDurationMs,
    startsAt: status.startsAt,
    endsAt: status.endsAt,
    purchaseAllowed: purchaseAvailable && status.purchaseAllowed,
    membershipPurchase,
  });
}

function publicMembershipPurchase(
  status: BillingEntitlementStatus,
): Readonly<{ paidAmountFen: number; currency: "CNY" }> | null {
  const currentMembership =
    status.kind === "monthly_membership" &&
    (status.status === "active" || status.status === "exhausted");
  if (!currentMembership) {
    if (status.membershipPurchase !== null) {
      throw unavailable();
    }
    return null;
  }
  const purchase = status.membershipPurchase;
  if (
    !isPlainDataObject(purchase) ||
    !hasExactKeys(purchase, ["paidAmountFen", "currency"]) ||
    !Number.isSafeInteger(purchase.paidAmountFen) ||
    purchase.paidAmountFen < 1 ||
    purchase.paidAmountFen > MAX_AMOUNT_FEN ||
    purchase.currency !== "CNY"
  ) {
    throw unavailable();
  }
  return Object.freeze({
    paidAmountFen: purchase.paidAmountFen,
    currency: "CNY",
  });
}

function validCodeUrl(value: string): boolean {
  return (
    value.isWellFormed() &&
    value.startsWith("weixin://") &&
    !CODE_URL_UNSAFE_CHARACTERS.test(value) &&
    Buffer.byteLength(value, "utf8") >= 10 &&
    Buffer.byteLength(value, "utf8") <= 2_048
  );
}

function publicOrder(order: CreatedBillingOrder | BillingOrderView) {
  if (
    !isPlainDataObject(order) ||
    !ORDER_ID.test(order.orderId) ||
    !ORDER_STATUSES.has(order.status) ||
    !Number.isSafeInteger(order.amountFen) ||
    order.amountFen <= 0 ||
    order.amountFen > MAX_AMOUNT_FEN ||
    order.currency !== "CNY" ||
    (typeof order.codeUrl !== "string" && order.codeUrl !== null) ||
    !isCanonicalInstantOrNull(order.codeUrlRecoveryAvailableAt) ||
    !isCanonicalInstant(order.createdAt) ||
    !isCanonicalInstant(order.expiresAt) ||
    !isCanonicalInstant(order.serverTime) ||
    !isCanonicalInstantOrNull(order.paidAt) ||
    (order.paidAmountFen !== null && (
      !Number.isSafeInteger(order.paidAmountFen) ||
      order.paidAmountFen <= 0 ||
      order.paidAmountFen > MAX_AMOUNT_FEN
    )) ||
    (order.paidAt === null) !== (order.paidAmountFen === null) ||
    (order.paidAmountFen !== null && order.paidAmountFen !== order.amountFen) ||
    (order.status === "pending"
      ? (
          order.codeUrl === null
            ? order.codeUrlRecoveryAvailableAt === null
            : !validCodeUrl(order.codeUrl) || order.codeUrlRecoveryAvailableAt !== null
        )
      : order.codeUrl !== null || order.codeUrlRecoveryAvailableAt !== null) ||
    ((order.status === "pending" || order.status === "expired") &&
      (order.paidAt !== null || order.paidAmountFen !== null)) ||
    ((order.status === "paid" || order.status === "refunded") &&
      (order.paidAt === null || order.paidAmountFen === null))
  ) {
    throw unavailable();
  }
  return Object.freeze({
    orderId: order.orderId,
    status: order.status,
    amountFen: order.amountFen,
    currency: order.currency,
    codeUrl: order.codeUrl,
    codeUrlRecoveryAvailableAt: order.codeUrlRecoveryAvailableAt,
    createdAt: order.createdAt,
    expiresAt: order.expiresAt,
    serverTime: order.serverTime,
    paidAt: order.paidAt,
    paidAmountFen: order.paidAmountFen,
  });
}

function noQuery(request: FastifyRequest): void {
  if (
    !isFrameworkDataRecord(request.query) ||
    Object.keys(request.query).length !== 0
  ) {
    throw invalidRequest();
  }
}

function requestContentType(request: FastifyRequest): string | undefined {
  const contentType = request.headers["content-type"];
  return typeof contentType === "string"
    ? contentType.split(";", 1)[0]?.trim().toLowerCase()
    : undefined;
}

function requestIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers["idempotency-key"];
  const distinct = request.raw.headersDistinct?.["idempotency-key"];
  const rawValues: string[] = [];
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    if (request.raw.rawHeaders[index]?.toLowerCase() === "idempotency-key") {
      const rawValue = request.raw.rawHeaders[index + 1];
      if (rawValue !== undefined) rawValues.push(rawValue);
    }
  }
  if (
    typeof value !== "string" ||
    !IDEMPOTENCY_KEY.test(value) ||
    rawValues.length !== 1 ||
    rawValues[0] !== value ||
    (distinct !== undefined &&
      (distinct.length !== 1 || distinct[0] !== value))
  ) {
    throw invalidRequest();
  }
  return value;
}

function callbackHeaders(
  request: FastifyRequest,
): Record<string, string | undefined> {
  const read = (name: string): string | undefined => {
    const value = request.headers[name];
    return typeof value === "string" ? value : undefined;
  };
  return {
    "wechatpay-timestamp": read("wechatpay-timestamp"),
    "wechatpay-nonce": read("wechatpay-nonce"),
    "wechatpay-signature": read("wechatpay-signature"),
    "wechatpay-serial": read("wechatpay-serial"),
  };
}

function callbackErrorHandler(
  _error: Error,
  _request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  return sendCallbackFailure(reply);
}

export function registerBillingRoutes(
  app: FastifyInstance,
  options: BillingRoutesOptions,
): void {
  const now = options.now ?? (() => new Date());
  const salesAvailable = options.salesAvailable ?? false;
  const rateLimiter = new BillingRouteRateLimiter(
    options.rateLimitNow ?? (() => performance.now()),
  );
  const noStore = async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
  };
  app.addHook("onClose", async () => {
    rateLimiter.dispose();
  });

  app.get("/api/community/v1/billing/offer", { onRequest: noStore }, async (request, reply) => {
    try {
      noQuery(request);
      const identity = await options.authService.authenticateAccessToken(
        bearerToken(request),
      );
      const rate = rateLimiter.consume(identity.accountId, "offer", 60);
      if (!rate.allowed) {
        return sendRateFailure(reply, rate.retryAfterSeconds ?? 60);
      }
      return reply.code(200).send(
        publicOffer(options.catalog.publicOffer(now()), salesAvailable),
      );
    } catch (error) {
      return sendFailure(reply, error);
    }
  });

  app.get("/api/community/v1/billing/status", { onRequest: noStore }, async (request, reply) => {
    try {
      noQuery(request);
      const identity = await options.authService.authenticateAccessToken(
        bearerToken(request),
      );
      const rate = rateLimiter.consume(identity.accountId, "status", 60);
      if (!rate.allowed) {
        return sendRateFailure(reply, rate.retryAfterSeconds ?? 60);
      }
      const decisionAt = now();
      let purchaseAvailable = false;
      try {
        purchaseAvailable = publicOffer(
          options.catalog.publicOffer(decisionAt),
          salesAvailable,
        ).purchasable;
      } catch (error) {
        if (
          !(error instanceof BillingFailure) ||
          (error.code !== "BILLING_SALES_PAUSED" &&
            error.code !== "BILLING_NOT_CONFIGURED")
        ) {
          throw error;
        }
      }
      return reply.code(200).send(
        publicStatus(
          options.entitlements.status(identity.accountId, decisionAt),
          purchaseAvailable,
        ),
      );
    } catch (error) {
      return sendFailure(reply, error);
    }
  });

  app.post(
    "/api/community/v1/billing/orders",
    {
      bodyLimit: 4_096,
      onRequest: noStore,
      errorHandler: (_error, _request, reply) =>
        sendFailure(reply, invalidRequest()),
    },
    async (request, reply) => {
      try {
        noQuery(request);
        const identity = await options.authService.authenticateAccessToken(
          bearerToken(request),
        );
        const rate = rateLimiter.consume(identity.accountId, "createOrder", 10);
        if (!rate.allowed) {
          return sendRateFailure(reply, rate.retryAfterSeconds ?? 60);
        }
        if (
          requestContentType(request) !== "application/json" ||
          !isPlainDataObject(request.body) ||
          !hasExactKeys(request.body, ["productId"]) ||
          request.body.productId !== MONTHLY_PRODUCT_ID
        ) {
          throw invalidRequest();
        }
        const idempotencyKey = requestIdempotencyKey(request);
        if (!salesAvailable) {
          throw new BillingFailure("BILLING_SALES_PAUSED", 409);
        }
        const order = await options.billingService.createOrder({
          userId: identity.accountId,
          idempotencyKey,
          productId: MONTHLY_PRODUCT_ID,
        });
        return reply.code(201).send(publicOrder(order));
      } catch (error) {
        return sendFailure(reply, error);
      }
    },
  );

  app.get(
    "/api/community/v1/billing/orders/current",
    { onRequest: noStore },
    async (request, reply) => {
      try {
        noQuery(request);
        const identity = await options.authService.authenticateAccessToken(
          bearerToken(request),
        );
        const rate = rateLimiter.consume(identity.accountId, "currentOrder", 60);
        if (!rate.allowed) {
          return sendRateFailure(reply, rate.retryAfterSeconds ?? 60);
        }
        const order = await options.billingService.getCurrentOrder({
          userId: identity.accountId,
        });
        if (order === null) return reply.code(204).send();
        return reply.code(200).send(publicOrder(order));
      } catch (error) {
        return sendFailure(reply, error);
      }
    },
  );

  app.post(
    "/api/community/v1/billing/orders/:orderId/recover",
    {
      bodyLimit: 4_096,
      onRequest: noStore,
      errorHandler: (_error, _request, reply) =>
        sendFailure(reply, invalidRequest()),
    },
    async (request, reply) => {
      try {
        noQuery(request);
        const identity = await options.authService.authenticateAccessToken(
          bearerToken(request),
        );
        const rate = rateLimiter.consume(identity.accountId, "recoverOrder", 6);
        if (!rate.allowed) {
          return sendRateFailure(reply, rate.retryAfterSeconds ?? 60);
        }
        if (
          !salesAvailable ||
          requestContentType(request) !== "application/json" ||
          !isPlainDataObject(request.body) ||
          !hasExactKeys(request.body, []) ||
          !isFrameworkDataRecord(request.params) ||
          !hasExactKeys(request.params, ["orderId"]) ||
          typeof request.params.orderId !== "string" ||
          !ORDER_ID.test(request.params.orderId)
        ) {
          if (!salesAvailable) {
            throw new BillingFailure("BILLING_SALES_PAUSED", 409);
          }
          throw invalidRequest();
        }
        const idempotencyKey = requestIdempotencyKey(request);
        const order = await options.billingService.recoverOrder({
          userId: identity.accountId,
          orderId: request.params.orderId,
          idempotencyKey,
        });
        return reply.code(200).send(publicOrder(order));
      } catch (error) {
        return sendFailure(reply, error);
      }
    },
  );

  app.get(
    "/api/community/v1/billing/orders/:orderId",
    { onRequest: noStore },
    async (request, reply) => {
    try {
      noQuery(request);
      const identity = await options.authService.authenticateAccessToken(
        bearerToken(request),
      );
      const rate = rateLimiter.consume(identity.accountId, "getOrder", 60);
      if (!rate.allowed) {
        return sendRateFailure(reply, rate.retryAfterSeconds ?? 60);
      }
      if (
        !isFrameworkDataRecord(request.params) ||
        !hasExactKeys(request.params, ["orderId"]) ||
        typeof request.params.orderId !== "string" ||
        !ORDER_ID.test(request.params.orderId)
      ) {
        throw invalidRequest();
      }
      const order = await options.billingService.getOrder({
        userId: identity.accountId,
        orderId: request.params.orderId,
      });
      return reply.code(200).send(publicOrder(order));
    } catch (error) {
      return sendFailure(reply, error);
    }
    },
  );

  void app.register(async (callbackScope) => {
    callbackScope.removeContentTypeParser("application/json");
    callbackScope.addContentTypeParser(
      "application/json",
      { parseAs: "string", bodyLimit: CALLBACK_BODY_LIMIT },
      (_request, body, done) => done(null, body),
    );
    callbackScope.post(
      "/api/community/v1/billing/wechat/notify",
      {
        bodyLimit: CALLBACK_BODY_LIMIT,
        errorHandler: callbackErrorHandler,
      },
      async (request, reply) => {
        try {
          if (
            requestContentType(request) !== "application/json" ||
            typeof request.body !== "string" ||
            !isFrameworkDataRecord(request.query) ||
            Object.keys(request.query).length !== 0
          ) {
            return sendCallbackFailure(reply);
          }
          const transaction: VerifiedWeChatNotificationTransaction =
            options.payment.verifyNotification({
              headers: callbackHeaders(request),
              body: request.body,
            });
          options.billingService.completePaidTransaction(transaction, now());
          return reply.code(204).send();
        } catch {
          return sendCallbackFailure(reply);
        }
      },
    );
  });
}
