export const MONTHLY_PRODUCT_ID = "txchat-monthly-cloud-10h" as const;
export const TRIAL_DURATION_MS = 3_600_000 as const;
export const MEMBERSHIP_DURATION_MS = 36_000_000 as const;
export const MAX_MEMBERSHIP_DURATION_MS = 3_600_000_000_000;
export function isMembershipDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 60_000 && value % 60_000 === 0 && value <= MAX_MEMBERSHIP_DURATION_MS;
}
export const ORDER_TTL_MS = 15 * 60_000;
export const LEGACY_MONTHLY_OFFER_NAME = "TxChat 月度会员" as const;
export type StoredMonthlyOfferName = string;
export function isStoredMonthlyOfferName(value: unknown): value is StoredMonthlyOfferName {
  return typeof value === "string" && value.isWellFormed() && value.length >= 1 && value.length <= 80 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

export const PHASE_ONE_MONTHLY_OFFER = Object.freeze({
  productCode: MONTHLY_PRODUCT_ID,
  displayName: "会员套餐",
  productType: "membership",
  tierCode: "standard",
  currency: "CNY",
  quotaAmount: MEMBERSHIP_DURATION_MS,
  quotaUnit: "milliseconds",
  includedDurationMs: MEMBERSHIP_DURATION_MS,
  periodUnit: "calendar_month",
  periodCount: 1,
  timezone: "Asia/Shanghai",
  rollover: false,
  autoRenew: false,
  activeMemberRepurchase: false,
} as const);

export type PhaseOneMonthlyOffer = typeof PHASE_ONE_MONTHLY_OFFER;

export type BillingFailureCode =
  | "BILLING_NOT_CONFIGURED"
  | "BILLING_SALES_PAUSED"
  | "BILLING_ORDER_PENDING"
  | "BILLING_MEMBERSHIP_ACTIVE"
  | "BILLING_QUOTA_EXHAUSTED"
  | "BILLING_PAYMENT_EXCEPTION"
  | "BILLING_INVALID_REQUEST"
  | "BILLING_SERVICE_UNAVAILABLE";

export class BillingFailure extends Error {
  readonly code: BillingFailureCode;
  readonly statusCode: number;

  constructor(code: BillingFailureCode, statusCode: number) {
    super(code);
    this.name = "BillingFailure";
    this.code = code;
    this.statusCode = statusCode;
  }
}
