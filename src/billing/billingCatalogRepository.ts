import {
  type CoreDatabase,
  withImmediateTransaction,
} from "../db/database.js";
import {
  type InternalIdGenerator,
} from "../ids/internalId.js";
import { allocateRuntimeEntityId } from "../ids/runtimeEntityId.js";
import {
  BillingFailure,
  MEMBERSHIP_DURATION_MS,
  MONTHLY_PRODUCT_ID,
  PHASE_ONE_MONTHLY_OFFER,
  isStoredMonthlyOfferName,
  isMembershipDuration,
  type StoredMonthlyOfferName,
} from "./billingTypes.js";
import { isInternalId } from "../ids/internalId.js";

export type BillingOffer = Readonly<{
  productId: typeof MONTHLY_PRODUCT_ID;
  displayName: StoredMonthlyOfferName;
  amountFen: number;
  includedDurationMs: number;
  purchasable: boolean;
}>;

export type BillingActiveOffer = Readonly<{
  id: string;
  productDatabaseId: string;
  productCode: typeof PHASE_ONE_MONTHLY_OFFER.productCode;
  displayName: StoredMonthlyOfferName;
  productType: typeof PHASE_ONE_MONTHLY_OFFER.productType;
  tierCode: typeof PHASE_ONE_MONTHLY_OFFER.tierCode;
  currency: typeof PHASE_ONE_MONTHLY_OFFER.currency;
  amountFen: number;
  quotaAmount: number;
  quotaUnit: typeof PHASE_ONE_MONTHLY_OFFER.quotaUnit;
  includedDurationMs: number;
  periodUnit: typeof PHASE_ONE_MONTHLY_OFFER.periodUnit;
  periodCount: typeof PHASE_ONE_MONTHLY_OFFER.periodCount;
  timezone: typeof PHASE_ONE_MONTHLY_OFFER.timezone;
  rollover: typeof PHASE_ONE_MONTHLY_OFFER.rollover;
  autoRenew: typeof PHASE_ONE_MONTHLY_OFFER.autoRenew;
  activeMemberRepurchase:
    typeof PHASE_ONE_MONTHLY_OFFER.activeMemberRepurchase;
  effectiveAt: string;
  state: "active";
}>;

export const MAX_BILLING_AMOUNT_FEN = 100_000_000;

export type BillingAdminPrice = Readonly<{
  id: string;
  amountFen: number;
  effectiveAt: string;
}>;

export type BillingAdminCatalogView = Readonly<{
  salesState: "paused" | "active";
  activePrice: BillingAdminPrice | null;
  scheduledPrice: BillingAdminPrice | null;
  lastChange: Readonly<{
    eventType: "price_published" | "sales_paused" | "sales_resumed";
    actorRef: string;
    occurredAt: string;
  }> | null;
}>;

type BillingClock = Readonly<{
  now: () => Date;
  internalId?: InternalIdGenerator;
}>;

type PublishPriceInput = Readonly<{
  amountFen: number;
  effectiveAt: string;
  administrator: string;
}>;

type CanonicalInstant = Readonly<{
  iso: string;
  epochMs: number;
}>;

type ProductRow = Readonly<{
  sales_state: "paused" | "active";
}>;

type StoredPriceRow = Readonly<{
  id: string;
  amount_fen: number;
  effective_at: string;
}>;

type StoredOfferRow = Readonly<{
  id: string;
  product_id: string;
  product_code: string;
  display_name: string;
  product_type: string;
  tier_code: string;
  currency: string;
  amount_fen: number;
  quota_amount: number;
  quota_unit: string;
  included_duration_ms: number;
  period_unit: string;
  period_count: number;
  timezone: string;
  rollover: number;
  auto_renew: number;
  active_member_repurchase: number;
  effective_at: string;
  state: string;
}>;

type AdminAuditRow = Readonly<{
  event_type: "price_published" | "sales_paused" | "sales_resumed";
  actor_ref: string;
  occurred_at: string;
}>;

type PriceRow = Readonly<{
  id: string;
  amountFen: number;
  effectiveAt: CanonicalInstant;
}>;

const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const MIN_CATALOG_YEAR = 2000;
const MAX_CATALOG_YEAR = 9999;

function invalidInput(): never {
  throw new TypeError("Invalid billing catalog input");
}

function invalidPersistence(): never {
  throw new TypeError("Invalid billing catalog persistence");
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
  if (year < MIN_CATALOG_YEAR || year > MAX_CATALOG_YEAR) {
    invalidInput();
  }
  return Object.freeze({ iso: canonical.toISOString(), epochMs });
}

function canonicalSecondDate(value: Date): CanonicalInstant {
  const current = canonicalDate(value);
  return canonicalDate(new Date(Math.floor(current.epochMs / 1_000) * 1_000));
}

function canonicalIsoInstant(value: string): CanonicalInstant {
  if (typeof value !== "string" || !value.isWellFormed()) {
    invalidInput();
  }
  const match = ISO_INSTANT.exec(value);
  if (match === null) {
    invalidInput();
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
    yearNumber < MIN_CATALOG_YEAR ||
    yearNumber > MAX_CATALOG_YEAR ||
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
    invalidInput();
  }
  const instant = new Date(value);
  const epochMs = nativeEpoch(instant, invalidInput);
  const canonical = new Date(epochMs);
  const canonicalYear = canonical.getUTCFullYear();
  if (canonicalYear < MIN_CATALOG_YEAR || canonicalYear > MAX_CATALOG_YEAR) {
    invalidInput();
  }
  return Object.freeze({ iso: canonical.toISOString(), epochMs });
}

function canonicalPersistedInstant(value: string): CanonicalInstant {
  let instant: CanonicalInstant;
  try {
    instant = canonicalIsoInstant(value);
  } catch {
    return invalidPersistence();
  }
  if (instant.iso !== value) {
    return invalidPersistence();
  }
  return instant;
}

function assertWholeSecondSource(value: string): void {
  const fraction = /\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/u.exec(value)?.[1];
  if (fraction !== undefined && /[1-9]/u.test(fraction)) invalidInput();
}

function assertAmountFen(amountFen: number): void {
  if (
    !Number.isSafeInteger(amountFen) ||
    amountFen <= 0 ||
    amountFen > MAX_BILLING_AMOUNT_FEN
  ) {
    invalidInput();
  }
}

function assertAdministrator(administrator: string): void {
  if (
    typeof administrator !== "string" ||
    administrator.length < 1 ||
    administrator.length > 128 ||
    administrator.trim() !== administrator ||
    !administrator.isWellFormed() ||
    CONTROL_CHARACTERS.test(administrator)
  ) {
    invalidInput();
  }
}

function unavailable(code: "BILLING_NOT_CONFIGURED" | "BILLING_SALES_PAUSED"): never {
  throw new BillingFailure(code, 409);
}

export class BillingCatalogRepository {
  readonly #internalId: InternalIdGenerator | undefined;
  readonly #phaseOneSchema: boolean;

  constructor(
    private readonly database: CoreDatabase,
    private readonly clock: BillingClock = { now: () => new Date() },
  ) {
    if (
      clock === null ||
      typeof clock !== "object" ||
      typeof clock.now !== "function" ||
      (clock.internalId !== undefined && typeof clock.internalId !== "function")
    ) {
      invalidInput();
    }
    this.#internalId = clock.internalId;
    this.#phaseOneSchema = (
      this.database.prepare("PRAGMA table_info(billing_offer_versions)").all() as Array<{
        name: string;
      }>
    ).length > 0;
  }

  offer(now: Date): BillingOffer {
    const current = canonicalDate(now);
    return withImmediateTransaction(this.database, () => {
      this.reconcileDueScheduled(current);
      const product = this.database
        .prepare(
          `SELECT sales_state
           FROM billing_products
           WHERE ${this.#phaseOneSchema ? "product_code" : "id"} = ?`,
        )
        .get(MONTHLY_PRODUCT_ID) as ProductRow | undefined;
      if (product?.sales_state === "paused") {
        unavailable("BILLING_SALES_PAUSED");
      }
      const active = this.activeOfferInTransaction();
      if (product?.sales_state !== "active" || active === undefined) {
        unavailable("BILLING_NOT_CONFIGURED");
      }
      return Object.freeze({
        productId: MONTHLY_PRODUCT_ID,
        displayName: active.displayName,
        amountFen: active.amountFen,
        includedDurationMs: active.includedDurationMs,
        purchasable: true,
      });
    });
  }

  publicOffer(now: Date): BillingOffer {
    const current = canonicalDate(now);
    return withImmediateTransaction(this.database, () => {
      this.reconcileDueScheduled(current);
      const product = this.database
        .prepare(
          `SELECT sales_state
           FROM billing_products
           WHERE ${this.#phaseOneSchema ? "product_code" : "id"} = ?`,
        )
        .get(MONTHLY_PRODUCT_ID) as ProductRow | undefined;
      const active = this.activeOfferInTransaction();
      if (active === undefined) {
        unavailable("BILLING_NOT_CONFIGURED");
      }
      return Object.freeze({
        productId: MONTHLY_PRODUCT_ID,
        displayName: active.displayName,
        amountFen: active.amountFen,
        includedDurationMs: active.includedDurationMs,
        purchasable: product?.sales_state === "active",
      });
    });
  }

  activeOffer(now: Date): BillingActiveOffer {
    const current = canonicalDate(now);
    return withImmediateTransaction(this.database, () => {
      this.reconcileDueScheduled(current);
      const product = this.database.prepare(
        `SELECT sales_state FROM billing_products
         WHERE ${this.#phaseOneSchema ? "product_code" : "id"} = ?`,
      ).get(MONTHLY_PRODUCT_ID) as ProductRow | undefined;
      if (product?.sales_state === "paused") {
        unavailable("BILLING_SALES_PAUSED");
      }
      const offer = this.activeOfferInTransaction();
      if (product?.sales_state !== "active" || offer === undefined) {
        unavailable("BILLING_NOT_CONFIGURED");
      }
      return offer;
    });
  }

  publishPrice(input: PublishPriceInput): void {
    assertAmountFen(input.amountFen);
    assertAdministrator(input.administrator);
    const requested = canonicalIsoInstant(input.effectiveAt);
    const current = canonicalDate(this.clock.now());

    withImmediateTransaction(this.database, () => {
      this.publishPriceInTransaction(input, requested, current);
    });
  }

  setSalesState(state: "paused" | "active"): void {
    if (state !== "paused" && state !== "active") {
      invalidInput();
    }
    const current = canonicalDate(this.clock.now());
    withImmediateTransaction(this.database, () => {
      this.reconcileDueScheduled(current);
      if (state === "active" && this.activePrice() === undefined) {
        unavailable("BILLING_NOT_CONFIGURED");
      }
      this.database
        .prepare(
          `UPDATE billing_products
           SET sales_state = ?, updated_at = ?
           WHERE ${this.#phaseOneSchema ? "product_code" : "id"} = ?`,
        )
        .run(state, current.iso, MONTHLY_PRODUCT_ID);
    });
  }

  adminView(now: Date): BillingAdminCatalogView {
    const current = canonicalDate(now);
    return withImmediateTransaction(this.database, () => {
      this.reconcileDueScheduled(current);
      return this.adminViewInTransaction();
    });
  }

  publishPriceForAdmin(input: PublishPriceInput): BillingAdminCatalogView {
    assertAmountFen(input.amountFen);
    assertAdministrator(input.administrator);
    assertWholeSecondSource(input.effectiveAt);
    const requested = canonicalIsoInstant(input.effectiveAt);
    if (requested.epochMs % 1_000 !== 0) invalidInput();
    const current = canonicalSecondDate(this.clock.now());
    return withImmediateTransaction(this.database, () => {
      const priceId = this.publishPriceInTransaction(input, requested, current);
      this.insertAudit({
        eventType: "price_published",
        targetId: priceId,
        actorRef: input.administrator,
        resultCategory: "accepted",
        occurredAt: current,
      });
      return this.adminViewInTransaction();
    });
  }

  setSalesStateForAdmin(
    state: "paused" | "active",
    administrator: string,
  ): BillingAdminCatalogView {
    if (state !== "paused" && state !== "active") invalidInput();
    assertAdministrator(administrator);
    const current = canonicalSecondDate(this.clock.now());
    return withImmediateTransaction(this.database, () => {
      this.reconcileDueScheduled(current);
      if (state === "active" && this.activePrice() === undefined) {
        unavailable("BILLING_NOT_CONFIGURED");
      }
      this.database.prepare(
        `UPDATE billing_products
         SET sales_state = ?, updated_at = ?
         WHERE ${this.#phaseOneSchema ? "product_code" : "id"} = ?`,
      ).run(state, current.iso, MONTHLY_PRODUCT_ID);
      this.insertAudit({
        eventType: state === "active" ? "sales_resumed" : "sales_paused",
        targetId: MONTHLY_PRODUCT_ID,
        actorRef: administrator,
        resultCategory: "accepted",
        occurredAt: current,
      });
      return this.adminViewInTransaction();
    });
  }

  auditAdminEvent(input: Readonly<{
    eventType: "login" | "price_published" | "sales_paused" | "sales_resumed";
    targetId?: string;
    actorRef?: string;
    resultCategory: "accepted" | "rejected";
    occurredAt: Date;
  }>): void {
    if (input.actorRef !== undefined) assertAdministrator(input.actorRef);
    if (
      !["login", "price_published", "sales_paused", "sales_resumed"].includes(input.eventType) ||
      (input.targetId !== undefined &&
        (typeof input.targetId !== "string" ||
          input.targetId.length < 1 || input.targetId.length > 128 ||
          input.targetId.trim() !== input.targetId ||
          !input.targetId.isWellFormed() || CONTROL_CHARACTERS.test(input.targetId))) ||
      !["accepted", "rejected"].includes(input.resultCategory)
    ) {
      invalidInput();
    }
    const occurredAt = canonicalSecondDate(input.occurredAt);
    withImmediateTransaction(this.database, () => this.insertAudit({
      eventType: input.eventType,
      ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
      ...(input.actorRef === undefined ? {} : { actorRef: input.actorRef }),
      resultCategory: input.resultCategory,
      occurredAt,
    }));
  }

  private publishPriceInTransaction(
    input: PublishPriceInput,
    requested: CanonicalInstant,
    current: CanonicalInstant,
  ): string {
    this.reconcileDueScheduled(current);
    if (requested.epochMs <= current.epochMs) {
      this.retireActive(current);
      return this.insertPrice(
        input.amountFen,
        "active",
        current,
        current,
        input.administrator,
      );
    }
    if (this.scheduledPrice() !== undefined) {
      throw new Error("PRICE_SCHEDULE_CONFLICT");
    }
    return this.insertPrice(
      input.amountFen,
      "scheduled",
      requested,
      current,
      input.administrator,
    );
  }

  private adminViewInTransaction(): BillingAdminCatalogView {
    const product = this.database.prepare(
      `SELECT sales_state FROM billing_products
       WHERE ${this.#phaseOneSchema ? "product_code" : "id"} = ?`,
    ).get(MONTHLY_PRODUCT_ID) as ProductRow | undefined;
    if (product === undefined) invalidPersistence();
    const active = this.activePrice();
    const scheduled = this.scheduledPrice();
    const audit = this.database.prepare(
      `SELECT event_type,
              ${this.#phaseOneSchema
                ? "actor_username_snapshot"
                : "actor_ref"} AS actor_ref,
              occurred_at
       FROM billing_admin_audit
       WHERE event_type IN ('price_published', 'sales_paused', 'sales_resumed')
         AND result_category = 'accepted'
         AND ${this.#phaseOneSchema
           ? "actor_username_snapshot"
           : "actor_ref"} IS NOT NULL
       ORDER BY occurred_at DESC, rowid DESC
       LIMIT 1`,
    ).get() as AdminAuditRow | undefined;
    const price = (value: PriceRow | undefined): BillingAdminPrice | null =>
      value === undefined ? null : Object.freeze({
        id: value.id,
        amountFen: value.amountFen,
        effectiveAt: value.effectiveAt.iso,
      });
    return Object.freeze({
      salesState: product.sales_state,
      activePrice: price(active),
      scheduledPrice: price(scheduled),
      lastChange: audit === undefined ? null : Object.freeze({
        eventType: audit.event_type,
        actorRef: audit.actor_ref,
        occurredAt: canonicalPersistedInstant(audit.occurred_at).iso,
      }),
    });
  }

  private insertAudit(input: Readonly<{
    eventType: "login" | "price_published" | "sales_paused" | "sales_resumed";
    targetId?: string;
    actorRef?: string;
    resultCategory: "accepted" | "rejected";
    occurredAt: CanonicalInstant;
  }>): void {
    this.database.prepare(
      `INSERT INTO billing_admin_audit (
        id, event_type, target_id,
        ${this.#phaseOneSchema ? "actor_username_snapshot" : "actor_ref"},
        result_category, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      this.identifier(),
      input.eventType,
      input.targetId ?? null,
      input.actorRef ?? null,
      input.resultCategory,
      input.occurredAt.iso,
    );
  }

  private reconcileDueScheduled(current: CanonicalInstant): void {
    const scheduled = this.scheduledPrice();
    if (scheduled === undefined || scheduled.effectiveAt.epochMs > current.epochMs) {
      return;
    }
    this.retireActive(scheduled.effectiveAt);
    this.database
      .prepare(
        `UPDATE ${this.#phaseOneSchema
          ? "billing_offer_versions"
          : "billing_price_versions"}
         SET state = 'active'
         WHERE id = ? AND product_id = ? AND state = 'scheduled'`,
      )
      .run(scheduled.id, this.productDatabaseId());
  }

  private retireActive(retiredAt: CanonicalInstant): void {
    const active = this.activePrice();
    if (active !== undefined && active.effectiveAt.epochMs > retiredAt.epochMs) {
      invalidPersistence();
    }
    this.database
      .prepare(
        `UPDATE ${this.#phaseOneSchema
          ? "billing_offer_versions"
          : "billing_price_versions"}
         SET state = 'retired', retired_at = ?
         WHERE product_id = ? AND state = 'active'`,
      )
      .run(retiredAt.iso, this.productDatabaseId());
  }

  private activePrice(): PriceRow | undefined {
    return this.priceForState("active");
  }

  private scheduledPrice(): PriceRow | undefined {
    return this.priceForState("scheduled");
  }

  private priceForState(state: "active" | "scheduled"): PriceRow | undefined {
    const row = this.database
      .prepare(
        `SELECT id, amount_fen, effective_at
         FROM ${this.#phaseOneSchema
           ? "billing_offer_versions"
           : "billing_price_versions"}
         WHERE product_id = ? AND state = ?
         ORDER BY effective_at ASC`,
      )
      .get(this.productDatabaseId(), state) as StoredPriceRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    if (
      !Number.isSafeInteger(row.amount_fen) ||
      row.amount_fen <= 0 ||
      row.amount_fen > MAX_BILLING_AMOUNT_FEN
    ) {
      invalidPersistence();
    }
    return Object.freeze({
      id: row.id,
      amountFen: row.amount_fen,
      effectiveAt: canonicalPersistedInstant(row.effective_at),
    });
  }

  private activeOfferInTransaction(): BillingActiveOffer | undefined {
    const price = this.activePrice();
    if (price === undefined) return undefined;
    if (!this.#phaseOneSchema) {
      return Object.freeze({
        id: price.id,
        productDatabaseId: MONTHLY_PRODUCT_ID,
        ...PHASE_ONE_MONTHLY_OFFER,
        amountFen: price.amountFen,
        effectiveAt: price.effectiveAt.iso,
        state: "active" as const,
      });
    }
    const row = this.database.prepare(
      `SELECT id, product_id, product_code, display_name, product_type,
              tier_code, currency, amount_fen, quota_amount, quota_unit,
              included_duration_ms, period_unit, period_count, timezone,
              rollover, auto_renew, active_member_repurchase,
              effective_at, state
       FROM billing_offer_versions
       WHERE product_id = ? AND state = 'active'`,
    ).get(this.productDatabaseId()) as StoredOfferRow | undefined;
    if (
      row === undefined ||
      !isInternalId(row.id) ||
      !isInternalId(row.product_id) ||
      row.product_code !== PHASE_ONE_MONTHLY_OFFER.productCode ||
      !isStoredMonthlyOfferName(row.display_name) ||
      row.product_type !== PHASE_ONE_MONTHLY_OFFER.productType ||
      row.tier_code !== PHASE_ONE_MONTHLY_OFFER.tierCode ||
      row.currency !== PHASE_ONE_MONTHLY_OFFER.currency ||
      row.quota_amount !== row.included_duration_ms ||
      row.quota_unit !== PHASE_ONE_MONTHLY_OFFER.quotaUnit ||
      !isMembershipDuration(row.included_duration_ms) ||
      row.period_unit !== PHASE_ONE_MONTHLY_OFFER.periodUnit ||
      row.period_count !== PHASE_ONE_MONTHLY_OFFER.periodCount ||
      row.timezone !== PHASE_ONE_MONTHLY_OFFER.timezone ||
      row.rollover !== Number(PHASE_ONE_MONTHLY_OFFER.rollover) ||
      row.auto_renew !== Number(PHASE_ONE_MONTHLY_OFFER.autoRenew) ||
      row.active_member_repurchase !==
        Number(PHASE_ONE_MONTHLY_OFFER.activeMemberRepurchase) ||
      row.state !== "active" ||
      !Number.isSafeInteger(row.amount_fen) ||
      row.amount_fen < 1 ||
      row.amount_fen > MAX_BILLING_AMOUNT_FEN
    ) invalidPersistence();
    return Object.freeze({
      id: row.id,
      productDatabaseId: row.product_id,
      ...PHASE_ONE_MONTHLY_OFFER,
      displayName: row.display_name,
      quotaAmount: row.quota_amount,
      includedDurationMs: row.included_duration_ms,
      amountFen: row.amount_fen,
      effectiveAt: canonicalPersistedInstant(row.effective_at).iso,
      state: "active" as const,
    });
  }

  private insertPrice(
    amountFen: number,
    state: "active" | "scheduled",
    effectiveAt: CanonicalInstant,
    createdAt: CanonicalInstant,
    administrator: string,
  ): string {
    const id = this.identifier();
    if (this.#phaseOneSchema) {
      const productId = this.productDatabaseId();
      const maximum = this.database.prepare(
        "SELECT COALESCE(MAX(revision), 0) AS revision FROM billing_offer_versions",
      ).get() as { revision: number };
      this.database.prepare(
        `INSERT INTO billing_offer_versions (
          id, product_id, supersedes_id, product_code, display_name,
          product_type, tier_code, currency, amount_fen, quota_amount,
          quota_unit, included_duration_ms, period_unit, period_count,
          timezone, rollover, auto_renew, active_member_repurchase,
          effective_at, state, retired_at, created_by_admin_id,
          created_by_username_snapshot, revision, created_at, published_at
        ) VALUES (
          ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, NULL, NULL, ?, ?, ?, ?
        )`,
      ).run(
        id,
        productId,
        PHASE_ONE_MONTHLY_OFFER.productCode,
        PHASE_ONE_MONTHLY_OFFER.displayName,
        PHASE_ONE_MONTHLY_OFFER.productType,
        PHASE_ONE_MONTHLY_OFFER.tierCode,
        PHASE_ONE_MONTHLY_OFFER.currency,
        amountFen,
        PHASE_ONE_MONTHLY_OFFER.quotaAmount,
        PHASE_ONE_MONTHLY_OFFER.quotaUnit,
        PHASE_ONE_MONTHLY_OFFER.includedDurationMs,
        PHASE_ONE_MONTHLY_OFFER.periodUnit,
        PHASE_ONE_MONTHLY_OFFER.periodCount,
        PHASE_ONE_MONTHLY_OFFER.timezone,
        Number(PHASE_ONE_MONTHLY_OFFER.rollover),
        Number(PHASE_ONE_MONTHLY_OFFER.autoRenew),
        Number(PHASE_ONE_MONTHLY_OFFER.activeMemberRepurchase),
        effectiveAt.iso,
        state,
        administrator,
        maximum.revision + 1,
        createdAt.iso,
        createdAt.iso,
      );
      return id;
    }
    this.database
      .prepare(
        `INSERT INTO billing_price_versions (
          id, product_id, amount_fen, state, effective_at,
          retired_at, created_at, created_by_admin_id
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        id,
        MONTHLY_PRODUCT_ID,
        amountFen,
        state,
        effectiveAt.iso,
        createdAt.iso,
        administrator,
      );
    return id;
  }

  private productDatabaseId(): string {
    const row = this.database.prepare(
      `SELECT id FROM billing_products
       WHERE ${this.#phaseOneSchema ? "product_code" : "id"} = ?`,
    ).get(MONTHLY_PRODUCT_ID) as { id: string } | undefined;
    if (row === undefined) invalidPersistence();
    return row.id;
  }

  private identifier(): string {
    try {
      return allocateRuntimeEntityId(this.#phaseOneSchema, this.#internalId);
    } catch {
      return invalidInput();
    }
  }
}
