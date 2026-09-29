import {
  type CoreDatabase,
  withImmediateTransaction,
} from "../db/database.js";
import {
  type InternalIdGenerator,
} from "../ids/internalId.js";
import { allocateRuntimeEntityId } from "../ids/runtimeEntityId.js";
import { nextShanghaiCalendarMonth } from "./billingClock.js";
import {
  BillingFailure,
  MEMBERSHIP_DURATION_MS,
  isMembershipDuration,
  MONTHLY_PRODUCT_ID,
  TRIAL_DURATION_MS,
} from "./billingTypes.js";

export type BillingEntitlementStatus = Readonly<{
  entitlementId: string;
  kind: "trial" | "monthly_membership" | "none";
  status: "active" | "exhausted" | "expired" | "voided" | "refunded" | "unavailable";
  remainingDurationMs: number;
  startsAt: string | null;
  endsAt: string | null;
  purchaseAllowed: boolean;
  membershipPurchase: Readonly<{
    paidAmountFen: number;
    currency: "CNY";
  }> | null;
}>;

type BillingClock = Readonly<{
  now: () => Date;
}>;

type ActivateMonthlyInput = Readonly<{
  userId: string;
  order: Readonly<{ id: string }>;
  paidAt: Date;
}>;

type CanonicalInstant = Readonly<{
  iso: string;
  epochMs: number;
}>;

type EntitlementKind = "trial" | "monthly_membership";
type EntitlementState = "active" | "exhausted" | "expired" | "voided" | "refunded";

type StoredEntitlement = Readonly<{
  id: string;
  user_id: string;
  kind: EntitlementKind;
  source_order_id: string | null;
  status: EntitlementState;
  starts_at: string;
  ends_at: string | null;
  granted_duration_ms: number;
  remaining_duration_ms: number;
  created_at: string;
  updated_at: string;
}>;

type OrderRow = Readonly<{
  user_id: string;
  product_id: string;
  status: string;
  paid_at: string | null;
}>;

type MembershipPurchaseOrderRow = Readonly<{
  user_id: string;
  product_id: string;
  status: string;
  paid_at: string | null;
  amount_fen: number;
  currency: string;
}>;

type StoredLedger = Readonly<{
  user_id: string;
  entitlement_id: string;
  request_id: string | null;
  dictation_request_id: string | null;
  event_type: string;
  duration_ms: number;
  debited_duration_ms: number | null;
  reason_code: string;
  dedupe_key: string;
  created_at: string;
}>;

const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/u;
const MIN_BILLING_YEAR = 2000;
const MAX_BILLING_YEAR = 9999;
const MAX_BILLING_AMOUNT_FEN = 100_000_000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

function invalidInput(): never {
  throw new TypeError("Invalid billing entitlement input");
}

function invalidPersistence(): never {
  throw new TypeError("Invalid billing entitlement persistence");
}

function nativeEpoch(value: Date, onInvalid: () => never): number {
  try {
    const epoch = Date.prototype.getTime.call(value);
    if (!Number.isFinite(epoch)) {
      return onInvalid();
    }
    return epoch;
  } catch {
    return onInvalid();
  }
}

function canonicalDate(value: Date): CanonicalInstant {
  const epochMs = nativeEpoch(value, invalidInput);
  const canonical = new Date(epochMs);
  const year = canonical.getUTCFullYear();
  if (year < MIN_BILLING_YEAR || year > MAX_BILLING_YEAR) {
    invalidInput();
  }
  return Object.freeze({ iso: canonical.toISOString(), epochMs });
}

function canonicalIsoInstant(value: string): CanonicalInstant {
  if (typeof value !== "string" || !value.isWellFormed()) {
    invalidPersistence();
  }
  const match = ISO_INSTANT.exec(value);
  if (match === null) {
    invalidPersistence();
  }
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = match;
  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const hourNumber = Number(hour);
  const minuteNumber = Number(minute);
  const secondNumber = Number(second);
  const offsetHourNumber = offsetHour === undefined ? 0 : Number(offsetHour);
  const offsetMinuteNumber = offsetMinute === undefined ? 0 : Number(offsetMinute);
  if (
    yearNumber < MIN_BILLING_YEAR ||
    yearNumber > MAX_BILLING_YEAR ||
    monthNumber < 1 ||
    monthNumber > 12 ||
    dayNumber < 1 ||
    dayNumber > new Date(Date.UTC(yearNumber, monthNumber, 0)).getUTCDate() ||
    hourNumber > 23 ||
    minuteNumber > 59 ||
    secondNumber > 59 ||
    offsetHourNumber > 14 ||
    offsetMinuteNumber > 59 ||
    (offsetHourNumber === 14 && offsetMinuteNumber !== 0)
  ) {
    invalidPersistence();
  }
  const instant = new Date(value);
  const epochMs = nativeEpoch(instant, invalidPersistence);
  const canonical = new Date(epochMs);
  const canonicalYear = canonical.getUTCFullYear();
  if (canonicalYear < MIN_BILLING_YEAR || canonicalYear > MAX_BILLING_YEAR) {
    invalidPersistence();
  }
  return Object.freeze({ iso: canonical.toISOString(), epochMs });
}

function canonicalPersistedInstant(value: string): CanonicalInstant {
  const instant = canonicalIsoInstant(value);
  if (instant.iso !== value) {
    invalidPersistence();
  }
  return instant;
}

function assertIdentifier(value: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value.trim() !== value ||
    !value.isWellFormed() ||
    CONTROL_CHARACTERS.test(value)
  ) {
    invalidInput();
  }
}

function userNotFound(): never {
  throw new Error("BILLING_USER_NOT_FOUND");
}

function orderNotFound(): never {
  throw new Error("BILLING_ORDER_NOT_FOUND");
}

function orderNotPaid(): never {
  throw new Error("BILLING_ORDER_NOT_PAID");
}

function orderPaidAtMismatch(): never {
  throw new Error("BILLING_ORDER_PAID_AT_MISMATCH");
}

function transactionRequired(): never {
  throw new Error("BILLING_TRANSACTION_REQUIRED");
}

function transactionOwnershipRequired(): never {
  throw new Error("BILLING_TRANSACTION_OWNERSHIP_REQUIRED");
}

function orderProductMismatch(): never {
  throw new Error("BILLING_ORDER_PRODUCT_MISMATCH");
}

function entitlementIdCollision(): never {
  throw new Error("BILLING_ENTITLEMENT_ID_COLLISION (UNIQUE constraint failed: billing_entitlements.id)");
}

export class BillingEntitlementRepository {
  private readonly phaseOneSchema: boolean;
  private readonly trialRegrantSchema: boolean;

  constructor(
    private readonly database: CoreDatabase,
    private readonly clock: BillingClock = { now: () => new Date() },
    private readonly internalId?: InternalIdGenerator,
  ) {
    this.phaseOneSchema = (
      this.database.prepare("PRAGMA table_info(billing_usage_ledger)").all() as Array<{
        name: string;
      }>
    ).some(({ name }) => name === "request_ref");
    this.trialRegrantSchema = this.database.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'admin_trial_regrant_events'",
    ).get() !== undefined;
  }

  status(userId: string, now: Date = this.clock.now()): BillingEntitlementStatus {
    if (this.database.inTransaction) {
      transactionOwnershipRequired();
    }
    assertIdentifier(userId);
    const current = canonicalDate(now);
    return withImmediateTransaction(this.database, () => {
      this.assertUserExists(userId);
      this.reconcileDueMemberships(userId, current);
      const currentMembership = this.currentMembership(userId);
      if (currentMembership !== undefined) {
        return this.asStatus(currentMembership, false);
      }

      const currentTrial = this.currentTrial(userId);
      if (currentTrial !== undefined) {
        return this.asStatus(currentTrial, true);
      }

      const terminalMembership = this.latestTerminalMembership(userId);
      if (terminalMembership !== undefined) {
        return this.asStatus(terminalMembership, true);
      }

      const terminalTrial = this.latestTrial(userId);
      if (terminalTrial !== undefined) {
        return this.asStatus(terminalTrial, true);
      }

      if (this.hasLifetimePurchaseEvidence(userId)) {
        return this.unavailableStatus();
      }
      return this.asStatus(this.createTrial(userId, current), true);
    });
  }

  purchaseAllowed(userId: string, now: Date = this.clock.now()): boolean {
    if (this.database.inTransaction) {
      transactionOwnershipRequired();
    }
    assertIdentifier(userId);
    const current = canonicalDate(now);
    return withImmediateTransaction(this.database, () => {
      this.assertUserExists(userId);
      this.reconcileDueMemberships(userId, current);
      return this.currentMembership(userId) === undefined;
    });
  }

  activateMonthly(input: ActivateMonthlyInput): BillingEntitlementStatus {
    if (!this.database.inTransaction) {
      transactionRequired();
    }
    assertIdentifier(input.userId);
    assertIdentifier(input.order.id);
    const requestedPaidAt = canonicalDate(input.paidAt);
    return withImmediateTransaction(this.database, () => {
      this.assertUserExists(input.userId);
      const paidAt = this.assertPaidOrder(
        input.userId,
        input.order.id,
        requestedPaidAt,
      );
      this.reconcileDueMemberships(input.userId, paidAt);

      const sameOrder = this.membershipForOrder(input.order.id);
      if (sameOrder !== undefined) {
        if (sameOrder.user_id !== input.userId) {
          invalidPersistence();
        }
        return this.asStatus(
          sameOrder,
          this.currentMembership(input.userId) === undefined,
        );
      }

      if (this.currentMembership(input.userId) !== undefined) {
        throw new BillingFailure("BILLING_MEMBERSHIP_ACTIVE", 409);
      }

      const trial = this.latestTrial(input.userId) ?? this.createTrial(input.userId, paidAt);
      if (trial.status === "active" && trial.remaining_duration_ms > 0) {
        this.database.prepare(
          `UPDATE billing_entitlements
           SET status = 'voided', remaining_duration_ms = 0, updated_at = ?
           WHERE id = ? AND user_id = ? AND status = 'active'`,
        ).run(paidAt.iso, trial.id, input.userId);
        this.appendLedger({
          userId: input.userId,
          entitlementId: trial.id,
          eventType: "void_trial",
          durationMs: trial.remaining_duration_ms,
          reasonCode: "trial_voided_for_membership",
          createdAt: paidAt,
        });
      }

      const snapshot = this.phaseOneSchema ? this.database.prepare(
        "SELECT offer_included_duration_ms AS duration, offer_quota_amount AS quota FROM billing_orders WHERE id = ? AND user_id = ? AND status = 'paid'",
      ).get(input.order.id, input.userId) as { duration: number; quota: number } | undefined : undefined;
      const includedDurationMs = this.phaseOneSchema ? snapshot?.duration : MEMBERSHIP_DURATION_MS;
      if (!isMembershipDuration(includedDurationMs) ||
          (this.phaseOneSchema && snapshot?.quota !== includedDurationMs)) invalidPersistence();
      const endsAt = canonicalDate(nextShanghaiCalendarMonth(new Date(paidAt.epochMs)));
      const entitlementId = allocateRuntimeEntityId(
        this.phaseOneSchema,
        this.internalId,
      );
      this.database.prepare(
        `INSERT INTO billing_entitlements (
          id, user_id, kind, source_order_id, status, starts_at, ends_at,
          granted_duration_ms, remaining_duration_ms, created_at, updated_at
        ) VALUES (?, ?, 'monthly_membership', ?, 'active', ?, ?, ?, ?, ?, ?)`,
      ).run(
        entitlementId,
        input.userId,
        input.order.id,
        paidAt.iso,
        endsAt.iso,
        includedDurationMs,
        includedDurationMs,
        paidAt.iso,
        paidAt.iso,
      );
      this.appendLedger({
        userId: input.userId,
        entitlementId,
        eventType: "grant",
        durationMs: includedDurationMs,
        reasonCode: "membership_granted",
        createdAt: paidAt,
      });
      const membership = this.entitlementById(entitlementId, input.userId);
      if (membership === undefined) {
        invalidPersistence();
      }
      return this.asStatus(membership, false);
    });
  }

  regrantTrial(userId: string, now: Date = this.clock.now()): BillingEntitlementStatus {
    if (!this.database.inTransaction) {
      transactionRequired();
    }
    assertIdentifier(userId);
    const current = canonicalDate(now);
    this.assertUserExists(userId);

    const membership = this.currentMembership(userId);
    if (membership === undefined) {
      throw new Error("BILLING_TRIAL_REGRANT_NOT_ELIGIBLE");
    }
    const trial = this.currentTrial(userId);
    if (trial !== undefined) {
      const updatedTrial = this.database.prepare(
        `UPDATE billing_entitlements
         SET status = 'voided', remaining_duration_ms = 0, updated_at = ?
         WHERE id = ? AND user_id = ? AND kind = 'trial'
           AND status IN ('active', 'exhausted')`,
      ).run(current.iso, trial.id, userId);
      if (updatedTrial.changes !== 1) invalidPersistence();
      this.appendLedger({
        userId,
        entitlementId: trial.id,
        eventType: "void_trial",
        durationMs: trial.remaining_duration_ms,
        reasonCode: "trial_voided_for_admin_regrant",
        createdAt: current,
      });
    }

    const updatedMembership = this.database.prepare(
      `UPDATE billing_entitlements
       SET status = 'expired', remaining_duration_ms = 0, updated_at = ?
       WHERE id = ? AND user_id = ? AND kind = 'monthly_membership'
         AND status IN ('active', 'exhausted')`,
    ).run(current.iso, membership.id, userId);
    if (updatedMembership.changes !== 1) invalidPersistence();
    this.appendLedger({
      userId,
      entitlementId: membership.id,
      eventType: "expire",
      durationMs: membership.remaining_duration_ms,
      reasonCode: "membership_ended_for_trial_regrant",
      createdAt: current,
    });
    return this.asStatus(this.createTrial(userId, current), true);
  }

  private assertUserExists(userId: string): void {
    const row = this.database.prepare("SELECT 1 FROM users WHERE id = ?").get(userId);
    if (row === undefined) {
      userNotFound();
    }
  }

  private assertPaidOrder(
    userId: string,
    orderId: string,
    requestedPaidAt: CanonicalInstant,
  ): CanonicalInstant {
    const row = this.database.prepare(
      `SELECT user_id,
              ${this.phaseOneSchema ? "offer_product_code" : "product_id"} AS product_id,
              status, paid_at
       FROM billing_orders
       WHERE id = ?`,
    ).get(orderId) as OrderRow | undefined;
    if (row === undefined || row.user_id !== userId) {
      orderNotFound();
    }
    if (row.status !== "paid") {
      orderNotPaid();
    }
    if (row.product_id !== MONTHLY_PRODUCT_ID) {
      orderProductMismatch();
    }
    if (row.paid_at === null) {
      invalidPersistence();
    }
    const paidAt = canonicalPersistedInstant(row.paid_at);
    if (paidAt.epochMs !== requestedPaidAt.epochMs) {
      orderPaidAtMismatch();
    }
    return paidAt;
  }

  private reconcileDueMemberships(userId: string, current: CanonicalInstant): void {
    const due = this.database.prepare(
      `SELECT id, user_id, kind, source_order_id, status, starts_at, ends_at,
              granted_duration_ms, remaining_duration_ms, created_at, updated_at
       FROM billing_entitlements
       WHERE user_id = ?
         AND kind = 'monthly_membership'
         AND status IN ('active', 'exhausted')`,
    ).all(userId) as StoredEntitlement[];
    for (const membership of due) {
      if (membership.ends_at === null) {
        invalidPersistence();
      }
      const endsAt = canonicalPersistedInstant(membership.ends_at);
      if (endsAt.epochMs > current.epochMs) {
        continue;
      }
      this.database.prepare(
        `UPDATE billing_entitlements
         SET status = 'expired', remaining_duration_ms = 0, updated_at = ?
         WHERE id = ? AND user_id = ? AND status IN ('active', 'exhausted')`,
      ).run(current.iso, membership.id, userId);
      this.appendLedger({
        userId,
        entitlementId: membership.id,
        eventType: "expire",
        durationMs: membership.remaining_duration_ms,
        reasonCode: "membership_expired",
        createdAt: current,
      });
    }
  }

  private currentMembership(userId: string): StoredEntitlement | undefined {
    return this.database.prepare(
      `SELECT id, user_id, kind, source_order_id, status, starts_at, ends_at,
              granted_duration_ms, remaining_duration_ms, created_at, updated_at
       FROM billing_entitlements
       WHERE user_id = ?
         AND kind = 'monthly_membership'
         AND status IN ('active', 'exhausted')
       ORDER BY starts_at DESC, created_at DESC
       LIMIT 1`,
    ).get(userId) as StoredEntitlement | undefined;
  }

  private latestTerminalMembership(userId: string): StoredEntitlement | undefined {
    return this.database.prepare(
      `SELECT id, user_id, kind, source_order_id, status, starts_at, ends_at,
              granted_duration_ms, remaining_duration_ms, created_at, updated_at
       FROM billing_entitlements
       WHERE user_id = ?
         AND kind = 'monthly_membership'
         AND status IN ('expired', 'voided', 'refunded')
       ORDER BY starts_at DESC, created_at DESC
       LIMIT 1`,
    ).get(userId) as StoredEntitlement | undefined;
  }

  private currentTrial(userId: string): StoredEntitlement | undefined {
    return this.database.prepare(
      `SELECT id, user_id, kind, source_order_id, status, starts_at, ends_at,
              granted_duration_ms, remaining_duration_ms, created_at, updated_at
       FROM billing_entitlements
       WHERE user_id = ? AND kind = 'trial'
         AND status IN ('active', 'exhausted')
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    ).get(userId) as StoredEntitlement | undefined;
  }

  private latestTrial(userId: string): StoredEntitlement | undefined {
    return this.database.prepare(
      `SELECT id, user_id, kind, source_order_id, status, starts_at, ends_at,
              granted_duration_ms, remaining_duration_ms, created_at, updated_at
       FROM billing_entitlements
       WHERE user_id = ? AND kind = 'trial'
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    ).get(userId) as StoredEntitlement | undefined;
  }

  private hasLifetimePurchaseEvidence(userId: string): boolean {
    const entitlement = this.database.prepare(
      `SELECT 1
       FROM billing_entitlements
       WHERE user_id = ? AND kind = 'monthly_membership'
       LIMIT 1`,
    ).get(userId);
    if (entitlement !== undefined) {
      return true;
    }
    const order = this.database.prepare(
      `SELECT 1
       FROM billing_orders
       WHERE user_id = ?
         AND (
           status IN ('paid', 'refunded')
           OR (status = 'payment_exception' AND paid_at IS NOT NULL)
         )
       LIMIT 1`,
    ).get(userId);
    return order !== undefined;
  }

  private membershipForOrder(orderId: string): StoredEntitlement | undefined {
    return this.database.prepare(
      `SELECT id, user_id, kind, source_order_id, status, starts_at, ends_at,
              granted_duration_ms, remaining_duration_ms, created_at, updated_at
       FROM billing_entitlements
       WHERE source_order_id = ? AND kind = 'monthly_membership'`,
    ).get(orderId) as StoredEntitlement | undefined;
  }

  private entitlementById(id: string, userId: string): StoredEntitlement | undefined {
    return this.database.prepare(
      `SELECT id, user_id, kind, source_order_id, status, starts_at, ends_at,
              granted_duration_ms, remaining_duration_ms, created_at, updated_at
       FROM billing_entitlements
       WHERE id = ? AND user_id = ?`,
    ).get(id, userId) as StoredEntitlement | undefined;
  }

  private createTrial(userId: string, current: CanonicalInstant): StoredEntitlement {
    const entitlementId = allocateRuntimeEntityId(
      this.phaseOneSchema,
      this.internalId,
    );
    if (
      this.database.prepare(
        "SELECT 1 FROM billing_entitlements WHERE id = ?",
      ).get(entitlementId) !== undefined
    ) {
      entitlementIdCollision();
    }
    const trialConflict = this.trialRegrantSchema
      ? "ON CONFLICT(user_id) WHERE kind = 'trial' AND status IN ('active', 'exhausted') DO NOTHING"
      : "ON CONFLICT(user_id) WHERE kind = 'trial' DO NOTHING";
    const result = this.database.prepare(
      `INSERT INTO billing_entitlements (
        id, user_id, kind, source_order_id, status, starts_at, ends_at,
        granted_duration_ms, remaining_duration_ms, created_at, updated_at
      ) VALUES (?, ?, 'trial', NULL, 'active', ?, NULL, ?, ?, ?, ?)
      ${trialConflict}`,
    ).run(
      entitlementId,
      userId,
      current.iso,
      TRIAL_DURATION_MS,
      TRIAL_DURATION_MS,
      current.iso,
      current.iso,
    );
    if (result.changes === 0) {
      const existing = this.currentTrial(userId);
      if (existing === undefined) {
        invalidPersistence();
      }
      this.assertValidCreatedTrial(existing, userId);
      return existing;
    }
    this.appendLedger({
      userId,
      entitlementId,
      eventType: "grant",
      durationMs: TRIAL_DURATION_MS,
      reasonCode: "trial_granted",
      createdAt: current,
    });
    const trial = this.entitlementById(entitlementId, userId);
    if (trial === undefined) {
      invalidPersistence();
    }
    return trial;
  }

  private assertValidCreatedTrial(trial: StoredEntitlement, userId: string): void {
    if (
      trial.user_id !== userId ||
      trial.kind !== "trial" ||
      trial.source_order_id !== null ||
      trial.ends_at !== null ||
      trial.status !== "active" ||
      trial.granted_duration_ms !== TRIAL_DURATION_MS ||
      trial.remaining_duration_ms !== TRIAL_DURATION_MS
    ) {
      invalidPersistence();
    }
    const createdAt = canonicalPersistedInstant(trial.created_at);
    canonicalPersistedInstant(trial.starts_at);
    canonicalPersistedInstant(trial.updated_at);
    const dedupeKey = `entitlement:${trial.id}:grant`;
    const ledger = this.database.prepare(
      `SELECT user_id, entitlement_id,
              ${this.phaseOneSchema ? "request_ref" : "request_id"} AS request_id,
              dictation_request_id,
              event_type, duration_ms, debited_duration_ms, reason_code,
              dedupe_key, created_at
       FROM billing_usage_ledger
       WHERE dedupe_key = ?`,
    ).get(dedupeKey) as StoredLedger | undefined;
    this.assertLedgerMatches(ledger, {
      userId,
      entitlementId: trial.id,
      eventType: "grant",
      durationMs: TRIAL_DURATION_MS,
      reasonCode: "trial_granted",
      dedupeKey,
      createdAt,
    });
  }

  private appendLedger(input: Readonly<{
    userId: string;
    entitlementId: string;
    eventType: "grant" | "expire" | "void_trial";
    durationMs: number;
    reasonCode: string;
    createdAt: CanonicalInstant;
  }>): void {
    const dedupeKey = `entitlement:${input.entitlementId}:${input.eventType}`;
    const result = this.database.prepare(
      `INSERT INTO billing_usage_ledger (
        id, user_id, entitlement_id,
        ${this.phaseOneSchema ? "request_ref" : "request_id"},
        dictation_request_id,
        event_type, duration_ms, debited_duration_ms, reason_code,
        dedupe_key, created_at
      ) VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?, ?)
      ON CONFLICT(dedupe_key) DO NOTHING`,
    ).run(
      allocateRuntimeEntityId(this.phaseOneSchema, this.internalId),
      input.userId,
      input.entitlementId,
      input.eventType,
      input.durationMs,
      input.reasonCode,
      dedupeKey,
      input.createdAt.iso,
    );
    if (result.changes === 0) {
      const existing = this.database.prepare(
        `SELECT user_id, entitlement_id,
                ${this.phaseOneSchema ? "request_ref" : "request_id"} AS request_id,
                dictation_request_id,
                event_type, duration_ms, debited_duration_ms, reason_code,
                dedupe_key, created_at
         FROM billing_usage_ledger
         WHERE dedupe_key = ?`,
      ).get(dedupeKey) as StoredLedger | undefined;
      this.assertLedgerMatches(existing, {
        userId: input.userId,
        entitlementId: input.entitlementId,
        eventType: input.eventType,
        durationMs: input.durationMs,
        reasonCode: input.reasonCode,
        dedupeKey,
        createdAt: input.createdAt,
      });
    }
  }

  private assertLedgerMatches(
    ledger: StoredLedger | undefined,
    expected: Readonly<{
      userId: string;
      entitlementId: string;
      eventType: "grant" | "expire" | "void_trial";
      durationMs: number;
      reasonCode: string;
      dedupeKey: string;
      createdAt: CanonicalInstant;
    }>,
  ): void {
    if (
      ledger === undefined ||
      ledger.user_id !== expected.userId ||
      ledger.entitlement_id !== expected.entitlementId ||
      ledger.request_id !== null ||
      ledger.dictation_request_id !== null ||
      ledger.event_type !== expected.eventType ||
      ledger.duration_ms !== expected.durationMs ||
      ledger.debited_duration_ms !== null ||
      ledger.reason_code !== expected.reasonCode ||
      ledger.dedupe_key !== expected.dedupeKey ||
      ledger.created_at !== expected.createdAt.iso
    ) {
      invalidPersistence();
    }
  }

  private asStatus(
    entitlement: StoredEntitlement,
    purchaseAllowed: boolean,
  ): BillingEntitlementStatus {
    const startsAt = canonicalPersistedInstant(entitlement.starts_at).iso;
    const endsAt = entitlement.ends_at === null
      ? null
      : canonicalPersistedInstant(entitlement.ends_at).iso;
    if (
      !Number.isSafeInteger(entitlement.remaining_duration_ms) ||
      entitlement.remaining_duration_ms < 0 ||
      entitlement.remaining_duration_ms > entitlement.granted_duration_ms
    ) {
      invalidPersistence();
    }
    const membershipPurchase = this.membershipPurchase(entitlement);
    return Object.freeze({
      entitlementId: entitlement.id,
      kind: entitlement.kind,
      status: entitlement.status,
      remainingDurationMs: entitlement.remaining_duration_ms,
      startsAt,
      endsAt,
      purchaseAllowed,
      membershipPurchase,
    });
  }

  private membershipPurchase(
    entitlement: StoredEntitlement,
  ): BillingEntitlementStatus["membershipPurchase"] {
    if (
      entitlement.kind !== "monthly_membership" ||
      (entitlement.status !== "active" && entitlement.status !== "exhausted")
    ) {
      return null;
    }
    if (entitlement.source_order_id === null) {
      invalidPersistence();
    }
    const order = this.database.prepare(
      `SELECT user_id,
              ${this.phaseOneSchema ? "offer_product_code" : "product_id"} AS product_id,
              status, paid_at, amount_fen,
              ${this.phaseOneSchema ? "currency" : "'CNY'"} AS currency
       FROM billing_orders
       WHERE id = ?`,
    ).get(entitlement.source_order_id) as MembershipPurchaseOrderRow | undefined;
    if (
      order === undefined ||
      order.user_id !== entitlement.user_id ||
      order.product_id !== MONTHLY_PRODUCT_ID ||
      order.status !== "paid" ||
      order.paid_at === null ||
      !Number.isSafeInteger(order.amount_fen) ||
      order.amount_fen < 1 ||
      order.amount_fen > MAX_BILLING_AMOUNT_FEN ||
      order.currency !== "CNY"
    ) {
      invalidPersistence();
    }
    canonicalPersistedInstant(order.paid_at);
    return Object.freeze({
      paidAmountFen: order.amount_fen,
      currency: "CNY",
    });
  }

  private unavailableStatus(): BillingEntitlementStatus {
    return Object.freeze({
      entitlementId: "",
      kind: "none",
      status: "unavailable",
      remainingDurationMs: 0,
      startsAt: null,
      endsAt: null,
      purchaseAllowed: true,
      membershipPurchase: null,
    });
  }
}
