import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { openDatabase, withImmediateTransaction, type CoreDatabase } from "../src/db/database.js";
import { applyPublicSchema } from "../src/db/migrator.js";
import { generateInternalId } from "../src/ids/internalId.js";
import { BillingCatalogRepository } from "../src/billing/billingCatalogRepository.js";
import { BillingEntitlementRepository } from "../src/billing/billingEntitlementRepository.js";
import { BillingOrderRepository, type BillingOrder } from "../src/billing/billingOrderRepository.js";
import { BillingService } from "../src/billing/billingService.js";
import { MEMBERSHIP_DURATION_MS, MONTHLY_PRODUCT_ID, ORDER_TTL_MS } from "../src/billing/billingTypes.js";
import type { VerifiedWeChatTransaction, WeChatPaymentProvider } from "../src/billing/wechatNativePayment.js";

const databases: CoreDatabase[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function fixture() {
  const database = openDatabase(":memory:"); databases.push(database);
  applyPublicSchema(database, "core");
  let time = Math.floor(Date.now() / 1000) * 1000;
  const start = time;
  const clock = { now: () => new Date(time) };
  const userId = generateInternalId();
  const productId = generateInternalId();
  const partner = {
    spMerchantId: String(randomInt(1_000_000_000, 9_999_999_999)),
    spAppId: randomBytes(16).toString("hex"),
    subMerchantId: String(randomInt(1_000_000_000, 9_999_999_999)),
  };
  const instant = clock.now().toISOString();
  database.prepare(`INSERT INTO users (id, phone_lookup, phone_ciphertext, phone_key_version,
    status, revision, current_session_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'enabled', 1, NULL, ?, ?)`)
    .run(userId, randomBytes(32).toString("hex"), randomBytes(64).toString("base64url"), randomUUID(), instant, instant);
  database.prepare(`INSERT INTO billing_products (id, product_code, sales_state, created_at, updated_at)
    VALUES (?, ?, 'active', ?, ?)`).run(productId, MONTHLY_PRODUCT_ID, instant, instant);
  database.prepare(`INSERT INTO billing_offer_versions (
    id, product_id, supersedes_id, product_code, display_name, product_type, tier_code,
    currency, amount_fen, quota_amount, quota_unit, included_duration_ms, period_unit, period_count,
    timezone, rollover, auto_renew, active_member_repurchase, effective_at, state, retired_at,
    created_by_admin_id, created_by_username_snapshot, revision, created_at, published_at)
    VALUES (?, ?, NULL, ?, '会员套餐', 'membership', 'standard', 'CNY', 100,
      ?, 'milliseconds', ?, 'calendar_month', 1, 'Asia/Shanghai', 0, 0, 0, ?, 'active', NULL,
      NULL, ?, 1, ?, ?)`)
    .run(generateInternalId(), productId, MONTHLY_PRODUCT_ID, MEMBERSHIP_DURATION_MS,
      MEMBERSHIP_DURATION_MS, instant, randomUUID().replaceAll("-", ""), instant, instant);
  const entitlement = new BillingEntitlementRepository(database, clock, generateInternalId);
  const orders = new BillingOrderRepository(database,
    new BillingCatalogRepository(database, { ...clock, internalId: generateInternalId }),
    entitlement, { ...partner, internalId: generateInternalId, outTradeNo: generateInternalId });
  const createNativeOrder = vi.fn<WeChatPaymentProvider["createNativeOrder"]>(async ({ expiresAt }) => ({
    codeUrl: `weixin://wxpay/bizpayurl?pr=${randomBytes(16).toString("hex")}`, expiresAt,
  }));
  const provider: WeChatPaymentProvider = {
    createNativeOrder,
    verifyNotification: () => { throw new Error("No external notification is used"); },
    queryByOutTradeNo: async (outTradeNo) => ({ kind: "exception", tradeState: "CLOSED", outTradeNo }),
    closeOrder: async () => undefined,
  };
  const service = new BillingService(orders, provider, { clock });
  const create = (idempotencyKey = randomUUID()) => orders.createPending({
    userId, idempotencyKey, productId: MONTHLY_PRODUCT_ID, now: clock.now(),
  });
  const transaction = (order: BillingOrder, successAt = clock.now().toISOString()): VerifiedWeChatTransaction => ({
    ...partner, source: "notification", notificationId: randomUUID(), transactionId: randomUUID(),
    outTradeNo: order.wechatOutTradeNo, tradeState: "SUCCESS", amountFen: order.amountFen, currency: "CNY", successAt,
  });
  return { database, clock, userId, entitlement, orders, service, create, transaction, createNativeOrder,
    advance: (milliseconds: number) => { time = start + milliseconds; } };
}

describe("community billing against a fresh public schema", () => {
  it("releases a verified closed order without presenting its cached payment code again", async () => {
    const f = fixture(); const idempotencyKey = randomUUID();
    const first = await f.service.createOrder({ userId: f.userId, idempotencyKey });
    expect(first.codeUrl).not.toBeNull();
    f.advance(3_000);
    const closed = await f.service.getOrder({ userId: f.userId, orderId: first.orderId });
    expect(closed).toMatchObject({ status: "expired", codeUrl: null });
    expect(await f.service.createOrder({ userId: f.userId, idempotencyKey }))
      .toMatchObject({ orderId: first.orderId, status: "expired", codeUrl: null });
    expect(f.createNativeOrder).toHaveBeenCalledTimes(1);
    const replacement = await f.service.createOrder({ userId: f.userId, idempotencyKey: randomUUID() });
    expect(replacement.orderId).not.toBe(first.orderId);
    expect(replacement.status).toBe("pending");
    expect(f.createNativeOrder).toHaveBeenCalledTimes(2);
  });

  it.each(["active", "exhausted"] as const)("blocks a new purchase while a paid membership is %s and still in term", (status) => {
    const f = fixture(); const key = randomUUID(); const original = f.create(key).order;
    f.advance(1_000);
    f.orders.completePaidTransaction(f.transaction(original), f.clock.now());
    if (status === "exhausted") f.database.prepare("UPDATE billing_entitlements SET status = 'exhausted', remaining_duration_ms = 0 WHERE kind = 'monthly_membership'").run();
    expect(f.entitlement.purchaseAllowed(f.userId, f.clock.now())).toBe(false);
    expect(() => f.create()).toThrowError("BILLING_MEMBERSHIP_ACTIVE");
    expect(f.create(key)).toMatchObject({ created: false, order: { id: original.id, status: "paid" } });
    expect(f.database.prepare("SELECT count(*) AS count FROM billing_orders").get()).toEqual({ count: 1 });
  });

  it("permits repurchase after an administrator regrants a trial without rewriting the old paid term", () => {
    const f = fixture(); const original = f.create().order;
    f.advance(1_000);
    const first = f.orders.completePaidTransaction(f.transaction(original), f.clock.now());
    const oldTerm = f.database.prepare("SELECT starts_at, ends_at FROM billing_entitlements WHERE id = ?").get(first.entitlementId);
    f.advance(2_000);
    withImmediateTransaction(f.database, () => f.entitlement.regrantTrial(f.userId, f.clock.now()));
    expect(f.entitlement.purchaseAllowed(f.userId, f.clock.now())).toBe(true);
    const next = f.create().order;
    const completion = f.orders.completePaidTransaction(f.transaction(next), f.clock.now());
    expect(completion).toMatchObject({ orderId: next.id, duplicate: false, manualRefundRequired: false });
    expect(completion.entitlementId).not.toBe(first.entitlementId);
    expect(f.database.prepare("SELECT starts_at, ends_at FROM billing_entitlements WHERE id = ?").get(first.entitlementId)).toEqual(oldTerm);
    expect(f.database.prepare("SELECT status, refunded_at FROM billing_orders WHERE id = ?").get(original.id)).toEqual({ status: "paid", refunded_at: null });
    expect(f.entitlement.purchaseAllowed(f.userId, f.clock.now())).toBe(false);
  });

  it("keeps genuine payments made before trial regrant in the overlap refund path", () => {
    const f = fixture(); const firstOrder = f.create().order;
    f.advance(ORDER_TTL_MS);
    const delayedOrder = f.create().order;
    f.advance(20 * 60_000);
    const first = f.orders.completePaidTransaction(f.transaction(firstOrder), f.clock.now());
    f.advance(25 * 60_000);
    const paidBeforeRegrant = new Date(f.clock.now().getTime() - 1).toISOString();
    withImmediateTransaction(f.database, () => f.entitlement.regrantTrial(f.userId, f.clock.now()));
    const delayed = f.transaction(delayedOrder, paidBeforeRegrant);
    const result = f.orders.completePaidTransaction(delayed, f.clock.now());
    expect(result).toMatchObject({ orderId: delayedOrder.id, entitlementId: first.entitlementId, manualRefundRequired: true, duplicate: false });
    expect(f.orders.completePaidTransaction({ ...delayed, notificationId: randomUUID() }, f.clock.now()))
      .toEqual({ ...result, duplicate: true });
    expect(f.database.prepare("SELECT count(*) AS count FROM billing_entitlements WHERE kind = 'monthly_membership'").get()).toEqual({ count: 1 });
  });

  it("handles order and payment replays without granting duration twice", () => {
    const f = fixture(); const key = randomUUID();
    const original = f.create(key).order;
    expect(f.create(key)).toMatchObject({ created: false, order: { id: original.id } });
    f.advance(1_000);
    const transaction = f.transaction(original);
    const first = f.orders.completePaidTransaction(transaction, f.clock.now());
    for (const replay of [transaction, { ...transaction, notificationId: randomUUID() }]) {
      expect(f.orders.completePaidTransaction(replay, f.clock.now())).toEqual({ ...first, duplicate: true });
    }
    expect(f.database.prepare("SELECT count(*) AS count FROM billing_entitlements WHERE kind = 'monthly_membership'").get()).toEqual({ count: 1 });
    expect(f.database.prepare("SELECT count(*) AS count FROM billing_usage_ledger WHERE reason_code = 'membership_granted'").get()).toEqual({ count: 1 });
    expect(f.database.pragma("foreign_key_check")).toEqual([]);
  });
});

it("rolls back a failed entitlement grant and safely retries the same confirmed transaction", () => {
  const f = fixture(); const order = f.create().order;
  f.advance(1_000);
  const transaction = f.transaction(order);
  const failedGrant = vi.spyOn(f.entitlement, "activateMonthly").mockImplementationOnce(() => {
    throw new Error("Simulated storage failure");
  });
  try {
    expect(() => f.orders.completePaidTransaction(transaction, f.clock.now())).toThrow("Simulated storage failure");
  } finally { failedGrant.mockRestore(); }
  expect(f.database.prepare("SELECT status, paid_at, wechat_transaction_id FROM billing_orders WHERE id = ?").get(order.id))
    .toEqual({ status: "pending", paid_at: null, wechat_transaction_id: null });
  expect(f.database.prepare("SELECT count(*) AS count FROM wechat_payment_events").get()).toEqual({ count: 0 });
  expect(f.database.prepare("SELECT count(*) AS count FROM billing_entitlements").get()).toEqual({ count: 0 });
  const completion = f.orders.completePaidTransaction(transaction, f.clock.now());
  expect(completion).toMatchObject({ duplicate: false, manualRefundRequired: false });
  const afterClose = f.orders.markProviderClosed({ userId: f.userId, orderId: order.id,
    outTradeNo: order.wechatOutTradeNo, at: f.clock.now() });
  expect(afterClose.status).toBe("paid");
  expect(f.database.prepare("SELECT count(*) AS count FROM billing_usage_ledger WHERE reason_code = 'membership_granted'").get()).toEqual({ count: 1 });
});
