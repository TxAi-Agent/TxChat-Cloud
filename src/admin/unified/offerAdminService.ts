import type { CoreDatabase } from "../../db/database.js";
import { withImmediateTransaction } from "../../db/database.js";
import {
  generateInternalId,
  isInternalId,
  type InternalIdGenerator,
} from "../../ids/internalId.js";
import { insertWithInternalId } from "../../ids/sqliteInternalId.js";
import {
  PHASE_ONE_MONTHLY_OFFER,
  type PhaseOneMonthlyOffer,
  isStoredMonthlyOfferName,
  isMembershipDuration,
  type StoredMonthlyOfferName,
} from "../../billing/billingTypes.js";
import type { AdminIdentity } from "./adminAuthorization.js";
import type { AdminAuditRepository } from "./adminAuditRepository.js";

const MAX_AMOUNT_FEN = 100_000_000;
const REQUEST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type OfferAdminErrorCode =
  | "ADMIN_INVALID_REQUEST"
  | "ADMIN_OFFER_NOT_FOUND"
  | "ADMIN_OFFER_INVALID"
  | "ADMIN_OFFER_IMMUTABLE"
  | "ADMIN_OFFER_SCHEDULE_CONFLICT"
  | "ADMIN_REVISION_CONFLICT"
  | "ADMIN_SERVICE_UNAVAILABLE";

export class OfferAdminError extends Error {
  constructor(readonly code: OfferAdminErrorCode) {
    super(code);
    this.name = "OfferAdminError";
  }
}

export type OfferDraftFields = Readonly<{
  remark?: string | undefined;
  productCode: string;
  displayName: string;
  productType: "membership" | "addon";
  tierCode: string;
  currency: string;
  amountFen: number;
  quotaAmount: number;
  quotaUnit: string;
  includedDurationMs: number;
  periodUnit: "calendar_month" | "calendar_year";
  periodCount: number;
  timezone: string;
  rollover: boolean;
  autoRenew: boolean;
  activeMemberRepurchase: boolean;
  effectiveAt: string;
}>;

export type OfferAdminView = Omit<PhaseOneMonthlyOffer, "displayName" | "quotaAmount" | "includedDurationMs"> & Readonly<{
  displayName: StoredMonthlyOfferName;
  quotaAmount: number;
  includedDurationMs: number;
  amountFen: number;
  effectiveAt: string;
  id: string;
  productId: string;
  supersedesId: string | null;
  state: "draft" | "scheduled" | "active" | "retired";
  retiredAt: string | null;
  createdByAdminId: string | null;
  createdByUsername: string;
  revision: number;
  createdAt: string;
  publishedAt: string | null;
  remark: string | null;
}>;

type ValidatedOfferDraft = Omit<PhaseOneMonthlyOffer, "displayName" | "quotaAmount" | "includedDurationMs"> & Readonly<{
  displayName: StoredMonthlyOfferName;
  quotaAmount: number;
  includedDurationMs: number;
  amountFen: number;
  effectiveAt: string;
}>;

export type OfferCatalogView = Readonly<{
  salesState: "paused" | "active";
  activeOffer: OfferAdminView | null;
  scheduledOffer: OfferAdminView | null;
}>;

type OfferRow = Readonly<{
  id: string;
  product_id: string;
  supersedes_id: string | null;
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
  state: "draft" | "scheduled" | "active" | "retired";
  retired_at: string | null;
  created_by_admin_id: string | null;
  created_by_username_snapshot: string;
  revision: number;
  created_at: string;
  published_at: string | null;
}>;

const COLUMNS = `
  id, product_id, supersedes_id, product_code, display_name, product_type,
  tier_code, currency, amount_fen, quota_amount, quota_unit,
  included_duration_ms, period_unit, period_count, timezone, rollover,
  auto_renew, active_member_repurchase, effective_at, state, retired_at,
  created_by_admin_id, created_by_username_snapshot, revision, created_at,
  published_at`;

function fail(code: OfferAdminErrorCode): never {
  throw new OfferAdminError(code);
}

function canonicalInstant(
  value: string,
  code: OfferAdminErrorCode,
): Readonly<{ iso: string; epochMs: number }> {
  if (typeof value !== "string" || !value.isWellFormed()) return fail(code);
  const parsed = new Date(value);
  const epochMs = parsed.getTime();
  if (
    !Number.isFinite(epochMs) ||
    parsed.toISOString() !== value ||
    !value.endsWith(".000Z") ||
    parsed.getUTCFullYear() < 2000 ||
    parsed.getUTCFullYear() > 9999
  ) return fail(code);
  return Object.freeze({ iso: value, epochMs });
}

function now(source: () => Date): Readonly<{ iso: string; epochMs: number }> {
  const value = source();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    return fail("ADMIN_SERVICE_UNAVAILABLE");
  }
  const epochMs = Math.floor(value.getTime() / 1_000) * 1_000;
  return Object.freeze({ iso: new Date(epochMs).toISOString(), epochMs });
}

function actor(input: AdminIdentity): void {
  if (
    input === null ||
    typeof input !== "object" ||
    !isInternalId(input.accountId) ||
    typeof input.username !== "string" ||
    input.username.length < 1 ||
    input.username.length > 64
  ) fail("ADMIN_INVALID_REQUEST");
}

function mutation(input: Readonly<{
  id?: string;
  expectedRevision?: number;
  actor: AdminIdentity;
  requestId: string;
}>): void {
  if (input === null || typeof input !== "object") {
    fail("ADMIN_INVALID_REQUEST");
  }
  if (input.id !== undefined && !isInternalId(input.id)) {
    fail("ADMIN_INVALID_REQUEST");
  }
  if (
    input.expectedRevision !== undefined &&
    (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
  ) fail("ADMIN_INVALID_REQUEST");
  actor(input.actor);
  if (typeof input.requestId !== "string" || !REQUEST_PATTERN.test(input.requestId)) {
    fail("ADMIN_INVALID_REQUEST");
  }
}

function sameDefinition(input: OfferDraftFields): boolean {
  for (const key of Object.keys(PHASE_ONE_MONTHLY_OFFER) as Array<
    keyof PhaseOneMonthlyOffer
  >) {
    if ((key === "quotaAmount" || key === "includedDurationMs") && isMembershipDuration(input[key])) continue;
    if (key === "displayName" && isStoredMonthlyOfferName(input[key])) continue;
    if (input[key] !== PHASE_ONE_MONTHLY_OFFER[key]) return false;
  }
  return true;
}

function draft(
  input: OfferDraftFields,
  errorCode: OfferAdminErrorCode = "ADMIN_OFFER_INVALID",
): ValidatedOfferDraft {
  if (
    input === null ||
    typeof input !== "object" ||
    !sameDefinition(input) ||
    input.quotaAmount !== input.includedDurationMs ||
    !Number.isSafeInteger(input.amountFen) ||
    input.amountFen < 1 ||
    input.amountFen > MAX_AMOUNT_FEN
  ) fail(errorCode);
  const effectiveAt = canonicalInstant(input.effectiveAt, errorCode);
  return Object.freeze({
    ...PHASE_ONE_MONTHLY_OFFER,
    displayName: input.displayName,
    quotaAmount: input.quotaAmount,
    includedDurationMs: input.includedDurationMs,
    amountFen: input.amountFen,
    effectiveAt: effectiveAt.iso,
  });
}

export class OfferAdminService {
  readonly #database: CoreDatabase;
  readonly #audit: AdminAuditRepository;
  readonly #internalId: InternalIdGenerator;
  readonly #now: () => Date;

  constructor(options: Readonly<{
    database: CoreDatabase;
    audit: AdminAuditRepository;
    internalId?: InternalIdGenerator;
    now?: () => Date;
  }>) {
    if (
      options === null ||
      typeof options !== "object" ||
      (options.internalId !== undefined && typeof options.internalId !== "function") ||
      (options.now !== undefined && typeof options.now !== "function")
    ) throw new TypeError("Invalid unified Offer administration options");
    this.#database = options.database;
    this.#audit = options.audit;
    this.#internalId = options.internalId ?? generateInternalId;
    this.#now = options.now ?? (() => new Date());
  }

  list(): readonly OfferAdminView[] {
    const current = now(this.#now);
    return this.read(() => withImmediateTransaction(this.#database, () => {
      this.reconcileDue(current);
      return Object.freeze((this.#database.prepare(
        `SELECT ${COLUMNS} FROM billing_offer_versions
         ORDER BY created_at DESC, id DESC`,
      ).all() as OfferRow[]).map((row) => this.safe(row)));
    }));
  }

  detail(id: string): OfferAdminView {
    if (!isInternalId(id)) fail("ADMIN_INVALID_REQUEST");
    const current = now(this.#now);
    return this.read(() => withImmediateTransaction(this.#database, () => {
      this.reconcileDue(current);
      return this.safe(this.row(id));
    }));
  }

  catalog(): OfferCatalogView {
    const current = now(this.#now);
    return this.read(() => withImmediateTransaction(this.#database, () => {
      this.reconcileDue(current);
      const product = this.product();
      const activeOffer = this.stateRow("active");
      const scheduledOffer = this.stateRow("scheduled");
      return Object.freeze({
        salesState: product.sales_state,
        activeOffer: activeOffer === undefined ? null : this.safe(activeOffer),
        scheduledOffer:
          scheduledOffer === undefined ? null : this.safe(scheduledOffer),
      });
    }));
  }

  createDraft(input: OfferDraftFields & Readonly<{
    actor: AdminIdentity;
    requestId: string;
  }>): OfferAdminView {
    mutation(input);
    const fields = draft(input);
    const remark = this.remark(input.remark);
    const current = now(this.#now);
    return this.mutate(() => withImmediateTransaction(this.#database, () => {
      const product = this.product();
      const statement = this.#database.prepare(
        `INSERT INTO billing_offer_versions (
          id, product_id, supersedes_id, product_code, display_name,
          product_type, tier_code, currency, amount_fen, quota_amount,
          quota_unit, included_duration_ms, period_unit, period_count,
          timezone, rollover, auto_renew, active_member_repurchase,
          effective_at, state, retired_at, created_by_admin_id,
          created_by_username_snapshot, revision, created_at, published_at
        ) VALUES (
          ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, 'draft', NULL, ?, ?, 1, ?, NULL
        )
        ON CONFLICT(id) DO NOTHING`,
      );
      const id = insertWithInternalId({
        generate: this.#internalId,
        insert: (candidate) => statement.run(
          candidate,
          product.id,
          fields.productCode,
          fields.displayName,
          fields.productType,
          fields.tierCode,
          fields.currency,
          fields.amountFen,
          fields.quotaAmount,
          fields.quotaUnit,
          fields.includedDurationMs,
          fields.periodUnit,
          fields.periodCount,
          fields.timezone,
          Number(fields.rollover),
          Number(fields.autoRenew),
          Number(fields.activeMemberRepurchase),
          fields.effectiveAt,
          input.actor.accountId,
          input.actor.username,
          current.iso,
        ).changes === 1,
      });
      this.saveRemark(id, remark ?? "", current.iso);
      this.audit(input, id, "offer_drafted", 1, current.iso);
      return this.safe(this.row(id));
    }));
  }

  updateDraft(input: OfferDraftFields & Readonly<{
    id: string;
    expectedRevision: number;
    actor: AdminIdentity;
    requestId: string;
  }>): OfferAdminView {
    mutation(input);
    const fields = draft(input);
    const remark = this.remark(input.remark);
    const current = now(this.#now);
    return this.mutate(() => withImmediateTransaction(this.#database, () => {
      const stored = this.row(input.id);
      if (stored.state !== "draft") fail("ADMIN_OFFER_IMMUTABLE");
      if (stored.revision !== input.expectedRevision) {
        fail("ADMIN_REVISION_CONFLICT");
      }
      const result = this.#database.prepare(
        `UPDATE billing_offer_versions
         SET amount_fen = ?, effective_at = ?, display_name = ?, quota_amount = ?, included_duration_ms = ?, revision = revision + 1,
             created_by_admin_id = ?, created_by_username_snapshot = ?
         WHERE id = ? AND state = 'draft' AND revision = ?`,
      ).run(
        fields.amountFen,
        fields.effectiveAt,
        fields.displayName,
        fields.quotaAmount,
        fields.includedDurationMs,
        input.actor.accountId,
        input.actor.username,
        input.id,
        input.expectedRevision,
      );
      if (result.changes !== 1) fail("ADMIN_REVISION_CONFLICT");
      if (remark !== undefined) this.saveRemark(input.id, remark, current.iso);
      this.audit(
        input,
        input.id,
        "offer_drafted",
        input.expectedRevision + 1,
        current.iso,
      );
      return this.safe(this.row(input.id));
    }));
  }

  publish(input: Readonly<{
    id: string;
    expectedRevision: number;
    actor: AdminIdentity;
    requestId: string;
  }>): OfferAdminView {
    mutation(input);
    const current = now(this.#now);
    return this.mutate(() => withImmediateTransaction(this.#database, () => {
      this.reconcileDue(current);
      const stored = this.row(input.id);
      if (stored.state !== "draft") fail("ADMIN_OFFER_IMMUTABLE");
      if (stored.revision !== input.expectedRevision) {
        fail("ADMIN_REVISION_CONFLICT");
      }
      const scheduled = this.stateRow("scheduled");
      if (scheduled !== undefined) fail("ADMIN_OFFER_SCHEDULE_CONFLICT");
      const requested = canonicalInstant(
        stored.effective_at,
        "ADMIN_SERVICE_UNAVAILABLE",
      );
      const active = this.stateRow("active");
      const nextState = requested.epochMs > current.epochMs
        ? "scheduled" as const
        : "active" as const;
      const effectiveAt = nextState === "active" ? current.iso : requested.iso;
      if (nextState === "active" && active !== undefined) {
        this.retire(active.id, current.iso);
      }
      const result = this.#database.prepare(
        `UPDATE billing_offer_versions
         SET supersedes_id = ?, effective_at = ?, state = ?,
             revision = revision + 1, published_at = ?
         WHERE id = ? AND state = 'draft' AND revision = ?`,
      ).run(
        active?.id ?? null,
        effectiveAt,
        nextState,
        current.iso,
        input.id,
        input.expectedRevision,
      );
      if (result.changes !== 1) fail("ADMIN_REVISION_CONFLICT");
      this.audit(
        input,
        input.id,
        nextState === "active" ? "offer_published" : "offer_scheduled",
        input.expectedRevision + 1,
        current.iso,
      );
      return this.safe(this.row(input.id));
    }));
  }

  withdraw(input: Readonly<{
    id: string;
    expectedRevision: number;
    actor: AdminIdentity;
    requestId: string;
  }>): OfferAdminView {
    mutation(input);
    return this.mutate(() => withImmediateTransaction(this.#database, () => {
      // Read the clock after acquiring the write lock: a waiting request cannot
      // withdraw a version whose effective time has already arrived.
      const current = now(this.#now);
      const stored = this.row(input.id);
      if (stored.revision !== input.expectedRevision) fail("ADMIN_REVISION_CONFLICT");
      if (stored.state !== "scheduled" ||
          canonicalInstant(stored.effective_at, "ADMIN_SERVICE_UNAVAILABLE").epochMs <= current.epochMs) {
        fail("ADMIN_OFFER_IMMUTABLE");
      }
      const result = this.#database.prepare(`UPDATE billing_offer_versions
        SET state = 'draft', supersedes_id = NULL, published_at = NULL, revision = revision + 1
        WHERE id = ? AND state = 'scheduled' AND revision = ? AND effective_at > ?`)
        .run(input.id, input.expectedRevision, current.iso);
      if (result.changes !== 1) fail("ADMIN_REVISION_CONFLICT");
      this.#audit.record({ occurredAt: current.iso, actorAdminId: input.actor.accountId,
        actorUsernameSnapshot: input.actor.username, targetId: input.id, requestRef: input.requestId,
        action: "offer_drafted", result: "accepted", targetRevision: input.expectedRevision + 1,
        requestCorrelation: "offer_schedule_withdrawn" });
      return this.safe(this.row(input.id));
    }));
  }

  setSalesState(input: Readonly<{
    state: "paused" | "active";
    actor: AdminIdentity;
    requestId: string;
  }>): OfferCatalogView {
    mutation(input);
    if (input.state !== "paused" && input.state !== "active") {
      fail("ADMIN_INVALID_REQUEST");
    }
    const current = now(this.#now);
    return this.mutate(() => withImmediateTransaction(this.#database, () => {
      this.reconcileDue(current);
      const product = this.product();
      if (input.state === "active" && this.stateRow("active") === undefined) {
        fail("ADMIN_OFFER_INVALID");
      }
      this.#database.prepare(
        `UPDATE billing_products SET sales_state = ?, updated_at = ?
         WHERE id = ?`,
      ).run(input.state, current.iso, product.id);
      this.audit(
        input,
        product.id,
        input.state === "active" ? "sales_resumed" : "sales_paused",
        undefined,
        current.iso,
      );
      return this.catalogInTransaction();
    }));
  }

  private catalogInTransaction(): OfferCatalogView {
    const product = this.product();
    const active = this.stateRow("active");
    const scheduled = this.stateRow("scheduled");
    return Object.freeze({
      salesState: product.sales_state,
      activeOffer: active === undefined ? null : this.safe(active),
      scheduledOffer: scheduled === undefined ? null : this.safe(scheduled),
    });
  }

  private product(): Readonly<{ id: string; sales_state: "paused" | "active" }> {
    const row = this.#database.prepare(
      `SELECT id, sales_state FROM billing_products WHERE product_code = ?`,
    ).get(PHASE_ONE_MONTHLY_OFFER.productCode) as
      | { id: string; sales_state: "paused" | "active" }
      | undefined;
    if (
      row === undefined ||
      !isInternalId(row.id) ||
      (row.sales_state !== "paused" && row.sales_state !== "active")
    ) fail("ADMIN_SERVICE_UNAVAILABLE");
    return Object.freeze(row);
  }

  private row(id: string): OfferRow {
    const row = this.#database.prepare(
      `SELECT ${COLUMNS} FROM billing_offer_versions WHERE id = ?`,
    ).get(id) as OfferRow | undefined;
    if (row === undefined) fail("ADMIN_OFFER_NOT_FOUND");
    return row;
  }

  private stateRow(state: "active" | "scheduled"): OfferRow | undefined {
    return this.#database.prepare(
      `SELECT ${COLUMNS} FROM billing_offer_versions
       WHERE product_id = ? AND state = ?`,
    ).get(this.product().id, state) as OfferRow | undefined;
  }

  private reconcileDue(current: Readonly<{ iso: string; epochMs: number }>): void {
    const scheduled = this.stateRow("scheduled");
    if (scheduled === undefined) return;
    const effective = canonicalInstant(
      scheduled.effective_at,
      "ADMIN_SERVICE_UNAVAILABLE",
    );
    if (effective.epochMs > current.epochMs) return;
    const active = this.stateRow("active");
    if (active !== undefined) this.retire(active.id, effective.iso);
    const result = this.#database.prepare(
      `UPDATE billing_offer_versions SET state = 'active'
       WHERE id = ? AND state = 'scheduled'`,
    ).run(scheduled.id);
    if (result.changes !== 1) fail("ADMIN_SERVICE_UNAVAILABLE");
  }

  private retire(id: string, retiredAt: string): void {
    const result = this.#database.prepare(
      `UPDATE billing_offer_versions SET state = 'retired', retired_at = ?
       WHERE id = ? AND state = 'active'`,
    ).run(retiredAt, id);
    if (result.changes !== 1) fail("ADMIN_SERVICE_UNAVAILABLE");
  }

  private safe(row: OfferRow): OfferAdminView {
    if (
      !isInternalId(row.id) ||
      !isInternalId(row.product_id) ||
      (row.supersedes_id !== null && !isInternalId(row.supersedes_id)) ||
      (row.created_by_admin_id !== null && !isInternalId(row.created_by_admin_id)) ||
      !["draft", "scheduled", "active", "retired"].includes(row.state) ||
      row.rollover !== 0 ||
      row.auto_renew !== 0 ||
      row.active_member_repurchase !== 0 ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1
    ) fail("ADMIN_SERVICE_UNAVAILABLE");
    const definition = draft({
      productCode: row.product_code,
      displayName: row.display_name,
      productType: row.product_type,
      tierCode: row.tier_code,
      currency: row.currency,
      quotaAmount: row.quota_amount,
      quotaUnit: row.quota_unit,
      includedDurationMs: row.included_duration_ms,
      periodUnit: row.period_unit,
      periodCount: row.period_count,
      timezone: row.timezone,
      rollover: false,
      autoRenew: false,
      activeMemberRepurchase: false,
      amountFen: row.amount_fen,
      effectiveAt: row.effective_at,
    } as OfferDraftFields, "ADMIN_SERVICE_UNAVAILABLE");
    const createdAt = canonicalInstant(row.created_at, "ADMIN_SERVICE_UNAVAILABLE");
    const retiredAt = row.retired_at === null
      ? null
      : canonicalInstant(row.retired_at, "ADMIN_SERVICE_UNAVAILABLE").iso;
    const publishedAt = row.published_at === null
      ? null
      : canonicalInstant(row.published_at, "ADMIN_SERVICE_UNAVAILABLE").iso;
    if (
      (row.state === "draft" &&
        (publishedAt !== null || retiredAt !== null || row.supersedes_id !== null)) ||
      ((row.state === "scheduled" || row.state === "active") &&
        (publishedAt === null || retiredAt !== null)) ||
      (row.state === "retired" &&
        (publishedAt === null || retiredAt === null))
    ) fail("ADMIN_SERVICE_UNAVAILABLE");
    return Object.freeze({
      id: row.id,
      productId: row.product_id,
      supersedesId: row.supersedes_id,
      ...definition,
      displayName: row.display_name as StoredMonthlyOfferName,
      state: row.state,
      retiredAt,
      createdByAdminId: row.created_by_admin_id,
      createdByUsername: row.created_by_username_snapshot,
      revision: row.revision,
      createdAt: createdAt.iso,
      publishedAt,
      remark: this.readRemark(row.id),
    });
  }

  private remark(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.isWellFormed() || value.trim().length > 500 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail("ADMIN_INVALID_REQUEST");
    return value.trim();
  }

  private hasRemarkStorage(): boolean {
    return this.#database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'admin_offer_remarks'").get() !== undefined;
  }

  private readRemark(id: string): string | null {
    if (!this.hasRemarkStorage()) return null;
    const stored = this.#database.prepare("SELECT remark FROM admin_offer_remarks WHERE offer_id = ?").get(id) as { remark: string } | undefined;
    return stored?.remark || null;
  }

  private saveRemark(id: string, remark: string, at: string): void {
    if (!this.hasRemarkStorage()) {
      if (remark !== "") fail("ADMIN_SERVICE_UNAVAILABLE");
      return;
    }
    this.#database.prepare(`INSERT INTO admin_offer_remarks (offer_id, remark, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(offer_id) DO UPDATE SET remark = excluded.remark, updated_at = excluded.updated_at`).run(id, remark, at);
  }

  private audit(
    input: Readonly<{ actor: AdminIdentity; requestId: string }>,
    targetId: string,
    action:
      | "offer_drafted"
      | "offer_published"
      | "offer_scheduled"
      | "sales_paused"
      | "sales_resumed",
    targetRevision: number | undefined,
    occurredAt: string,
  ): void {
    this.#audit.record({
      occurredAt,
      actorAdminId: input.actor.accountId,
      actorUsernameSnapshot: input.actor.username,
      targetId,
      requestRef: input.requestId,
      action,
      result: "accepted",
      ...(targetRevision === undefined ? {} : { targetRevision }),
    });
  }

  private read<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      if (error instanceof OfferAdminError) throw error;
      return fail("ADMIN_SERVICE_UNAVAILABLE");
    }
  }

  private mutate<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      if (error instanceof OfferAdminError) throw error;
      return fail("ADMIN_SERVICE_UNAVAILABLE");
    }
  }
}
