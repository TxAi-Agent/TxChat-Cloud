import type { CoreDatabase } from "../db/database.js";
import {
  type InternalIdGenerator,
} from "../ids/internalId.js";
import { allocateRuntimeEntityId } from "../ids/runtimeEntityId.js";
import { BillingEntitlementRepository } from "./billingEntitlementRepository.js";
import { BillingFailure } from "./billingTypes.js";

export type BillingUsageTicket = Readonly<{
  requestId: string;
  userId: string;
  entitlementId: string;
}>;

type BillingClock = Readonly<{
  now: () => Date;
}>;

type SettlementInput = Readonly<{
  uploadedPcmBytes: number;
  outcome: "usable_text" | "user_cancelled";
  dictationRequestId?: string;
}>;

type SettlementResult = Readonly<{
  audioDurationMs: number;
  debitedDurationMs: number;
  remainingDurationMs: number;
}>;

type IssuedTicket = Readonly<{
  userId: string;
  entitlementId: string;
  requestId: string;
}>;

type ActiveTicket = Readonly<{
  ticket: BillingUsageTicket;
  timer: ReturnType<typeof setTimeout>;
}>;

type StoredEntitlement = Readonly<{
  id: string;
  user_id: string;
  status: "active" | "exhausted" | "expired" | "voided" | "refunded";
  granted_duration_ms: number;
  remaining_duration_ms: number;
}>;

type StoredConsumeLedger = Readonly<{
  rowid: number;
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

type StoredLedgerRow = Readonly<{
  rowid: number;
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

type CanonicalInstant = Readonly<{
  iso: string;
}>;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const MAX_PCM_BYTES = 64 * 1024 * 1024;
// 64 MiB of 32 kHz PCM is about 35 minutes; leave bounded time for completion.
export const BILLING_USAGE_TICKET_LEASE_MS = 40 * 60_000;
const MIN_BILLING_YEAR = 2000;
const MAX_BILLING_YEAR = 9999;
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{3}Z$/u;

function invalidInput(): never {
  throw new TypeError("Invalid billing usage input");
}

function invalidTicket(): never {
  throw new TypeError("Invalid billing usage ticket");
}

function invalidPersistence(): never {
  throw new TypeError("Invalid billing usage persistence");
}

function assertIdentifier(value: unknown): asserts value is string {
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

function canonicalNow(now: Date): CanonicalInstant {
  let epochMs: number;
  try {
    epochMs = Date.prototype.getTime.call(now);
  } catch {
    return invalidInput();
  }
  if (!Number.isFinite(epochMs)) {
    invalidInput();
  }
  const canonical = new Date(epochMs);
  const year = canonical.getUTCFullYear();
  if (year < MIN_BILLING_YEAR || year > MAX_BILLING_YEAR) {
    invalidInput();
  }
  return Object.freeze({ iso: canonical.toISOString() });
}

function assertCanonicalPersistedInstant(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.isWellFormed() || ISO_INSTANT.exec(value) === null) {
    invalidPersistence();
  }
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
}

function snapshotSettlementInput(input: SettlementInput): Readonly<{
  audioDurationMs: number;
  outcome: "usable_text" | "user_cancelled";
  dictationRequestId: string | null;
}> {
  if (typeof input !== "object" || input === null) {
    invalidInput();
  }
  const uploadedPcmBytes = input.uploadedPcmBytes;
  const outcome = input.outcome;
  const dictationRequestId = input.dictationRequestId;
  if (
    !Number.isSafeInteger(uploadedPcmBytes) ||
    uploadedPcmBytes < 0 ||
    uploadedPcmBytes > MAX_PCM_BYTES ||
    (outcome !== "usable_text" && outcome !== "user_cancelled")
  ) {
    invalidInput();
  }
  if (dictationRequestId !== undefined) {
    assertIdentifier(dictationRequestId);
  }
  return Object.freeze({
    audioDurationMs: Math.ceil(uploadedPcmBytes / 32),
    outcome,
    dictationRequestId: dictationRequestId ?? null,
  });
}

function serviceUnavailable(): BillingFailure {
  return new BillingFailure("BILLING_SERVICE_UNAVAILABLE", 409);
}

function quotaExhausted(): BillingFailure {
  return new BillingFailure("BILLING_QUOTA_EXHAUSTED", 402);
}

export class BillingUsageService {
  readonly #activeAccounts = new Set<string>();
  readonly #activeTickets = new Map<string, ActiveTicket>();
  readonly #issuedTickets = new WeakMap<BillingUsageTicket, IssuedTicket>();
  readonly #settledResults = new WeakMap<BillingUsageTicket, SettlementResult>();
  readonly #abandonedTickets = new WeakSet<BillingUsageTicket>();
  #disposed = false;
  readonly #phaseOneSchema: boolean;

  constructor(
    private readonly database: CoreDatabase,
    private readonly entitlementRepository: BillingEntitlementRepository,
    private readonly clock: BillingClock = { now: () => new Date() },
    private readonly internalId?: InternalIdGenerator,
  ) {
    this.#phaseOneSchema = (
      this.database.prepare("PRAGMA table_info(billing_usage_ledger)").all() as Array<{
        name: string;
      }>
    ).some(({ name }) => name === "request_ref");
  }

  begin(input: Readonly<{ userId: string; requestId: string }>): BillingUsageTicket {
    if (this.#disposed) {
      throw serviceUnavailable();
    }
    if (typeof input !== "object" || input === null) {
      invalidInput();
    }
    const userId = input.userId;
    const requestId = input.requestId;
    if (this.database.inTransaction) {
      throw serviceUnavailable();
    }
    assertIdentifier(userId);
    assertIdentifier(requestId);
    if (this.#activeAccounts.has(userId)) {
      throw serviceUnavailable();
    }

    this.#activeAccounts.add(userId);
    let ticket: BillingUsageTicket | undefined;
    try {
      const status = this.entitlementRepository.status(userId, this.clock.now());
      if (status.status !== "active" || status.remainingDurationMs <= 0) {
        throw quotaExhausted();
      }
      assertIdentifier(status.entitlementId);
      ticket = Object.freeze({
        requestId,
        userId,
        entitlementId: status.entitlementId,
      });
      this.#issuedTickets.set(ticket, Object.freeze({
        requestId,
        userId,
        entitlementId: status.entitlementId,
      }));
      this.armLease(ticket, userId);
      return ticket;
    } catch (error) {
      this.release(ticket, userId);
      throw error;
    }
  }

  settle(ticket: BillingUsageTicket, input: SettlementInput): SettlementResult {
    const settled = this.#settledResults.get(ticket);
    if (settled !== undefined) {
      return settled;
    }
    const issued = this.#issuedTickets.get(ticket);
    if (issued === undefined) {
      invalidTicket();
    }

    try {
      const settlement = snapshotSettlementInput(input);
      if (this.database.inTransaction) {
        throw serviceUnavailable();
      }
      const result = this.withImmediateTransaction(() => {
        const now = canonicalNow(this.clock.now());
        const entitlement = this.entitlement(issued);
        const dedupeKey = `usage:${issued.requestId}:consume`;
        const reasonCode = settlement.outcome === "usable_text"
          ? "consume_usable_text"
          : "consume_user_cancelled";
        const existing = this.consumeLedger(dedupeKey);
        if (existing !== undefined) {
          this.assertMatchingConsumeLedger(existing, { issued, settlement, reasonCode, dedupeKey });
          const targetRemainingAfter = this.replayTargetRemaining(entitlement, existing);
          if (entitlement.remaining_duration_ms > targetRemainingAfter) {
            invalidPersistence();
          }
          return Object.freeze({
            audioDurationMs: settlement.audioDurationMs,
            debitedDurationMs: existing.debited_duration_ms,
            remainingDurationMs: targetRemainingAfter,
          });
        }

        const debitedDurationMs = Math.min(
          settlement.audioDurationMs,
          entitlement.remaining_duration_ms,
        );
        const remainingDurationMs = entitlement.remaining_duration_ms - debitedDurationMs;
        const nextStatus = entitlement.status === "active" && remainingDurationMs === 0
          ? "exhausted"
          : entitlement.status;
        const inserted = this.insertConsumeLedger({
          issued,
          settlement,
          debitedDurationMs,
          reasonCode,
          dedupeKey,
          createdAt: now,
        });
        if (!inserted.inserted) {
          const targetRemainingAfter = this.replayTargetRemaining(entitlement, inserted.ledger);
          if (entitlement.remaining_duration_ms > targetRemainingAfter) {
            invalidPersistence();
          }
          return Object.freeze({
            audioDurationMs: settlement.audioDurationMs,
            debitedDurationMs: inserted.ledger.debited_duration_ms,
            remainingDurationMs: targetRemainingAfter,
          });
        }
        const targetRemainingAfter = this.replayTargetRemaining(entitlement, inserted.ledger);
        if (targetRemainingAfter !== remainingDurationMs) {
          invalidPersistence();
        }
        const updated = this.database.prepare(
          `UPDATE billing_entitlements
           SET status = ?, remaining_duration_ms = ?, updated_at = ?
           WHERE id = ? AND user_id = ?`,
        ).run(
          nextStatus,
          remainingDurationMs,
          now.iso,
          issued.entitlementId,
          issued.userId,
        );
        if (updated.changes !== 1) {
          invalidPersistence();
        }
        return Object.freeze({
          audioDurationMs: settlement.audioDurationMs,
          debitedDurationMs,
          remainingDurationMs,
        });
      });
      this.#settledResults.set(ticket, result);
      return result;
    } finally {
      this.release(ticket, issued.userId);
    }
  }

  abandon(ticket: BillingUsageTicket): void {
    const issued = this.#issuedTickets.get(ticket);
    if (issued === undefined) {
      if (this.#abandonedTickets.has(ticket)) {
        return;
      }
      invalidTicket();
    }
    this.release(ticket, issued.userId);
    this.#abandonedTickets.add(ticket);
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    for (const [userId, active] of this.#activeTickets) {
      clearTimeout(active.timer);
      this.#issuedTickets.delete(active.ticket);
      this.#activeAccounts.delete(userId);
    }
    this.#activeTickets.clear();
    this.#activeAccounts.clear();
  }

  private armLease(ticket: BillingUsageTicket, userId: string): void {
    const timer = setTimeout(() => {
      const active = this.#activeTickets.get(userId);
      if (active?.ticket === ticket) {
        this.release(ticket, userId);
      }
    }, BILLING_USAGE_TICKET_LEASE_MS);
    timer.unref();
    this.#activeTickets.set(userId, Object.freeze({ ticket, timer }));
  }

  private release(ticket: BillingUsageTicket | undefined, userId: string): void {
    const active = this.#activeTickets.get(userId);
    if (ticket !== undefined && active?.ticket === ticket) {
      clearTimeout(active.timer);
      this.#activeTickets.delete(userId);
    }
    if (ticket !== undefined) {
      this.#issuedTickets.delete(ticket);
    }
    this.#activeAccounts.delete(userId);
  }

  private withImmediateTransaction<T>(work: () => T): T {
    if (this.database.inTransaction) {
      throw serviceUnavailable();
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.database.inTransaction) {
        this.database.exec("ROLLBACK");
      }
      throw error;
    }
  }

  private entitlement(issued: IssuedTicket): StoredEntitlement {
    const entitlement = this.database.prepare(
      `SELECT id, user_id, status, granted_duration_ms, remaining_duration_ms
       FROM billing_entitlements
       WHERE id = ? AND user_id = ?`,
    ).get(issued.entitlementId, issued.userId) as StoredEntitlement | undefined;
    if (
      entitlement === undefined ||
      entitlement.id !== issued.entitlementId ||
      entitlement.user_id !== issued.userId ||
      !Number.isSafeInteger(entitlement.granted_duration_ms) ||
      entitlement.granted_duration_ms <= 0 ||
      !Number.isSafeInteger(entitlement.remaining_duration_ms) ||
      entitlement.remaining_duration_ms < 0 ||
      entitlement.remaining_duration_ms > entitlement.granted_duration_ms ||
      !["active", "exhausted", "expired", "voided", "refunded"].includes(entitlement.status) ||
      (entitlement.status === "active" && entitlement.remaining_duration_ms === 0) ||
      (entitlement.status !== "active" && entitlement.remaining_duration_ms !== 0)
    ) {
      invalidPersistence();
    }
    return entitlement;
  }

  private consumeLedger(dedupeKey: string): StoredConsumeLedger | undefined {
    return this.database.prepare(
      `SELECT rowid, user_id, entitlement_id,
              ${this.#phaseOneSchema ? "request_ref" : "request_id"} AS request_id,
              dictation_request_id,
              event_type, duration_ms, debited_duration_ms, reason_code,
              dedupe_key, created_at
       FROM billing_usage_ledger
       WHERE dedupe_key = ?`,
    ).get(dedupeKey) as StoredConsumeLedger | undefined;
  }

  private insertConsumeLedger(input: Readonly<{
    issued: IssuedTicket;
    settlement: Readonly<{
      audioDurationMs: number;
      dictationRequestId: string | null;
    }>;
    debitedDurationMs: number;
    reasonCode: string;
    dedupeKey: string;
    createdAt: CanonicalInstant;
  }>): Readonly<{
    inserted: boolean;
    ledger: StoredConsumeLedger & Readonly<{ debited_duration_ms: number }>;
  }> {
    const result = this.database.prepare(
      `INSERT INTO billing_usage_ledger (
        id, user_id, entitlement_id,
        ${this.#phaseOneSchema ? "request_ref" : "request_id"},
        dictation_request_id,
        event_type, duration_ms, debited_duration_ms, reason_code,
        dedupe_key, created_at
      ) VALUES (?, ?, ?, ?, ?, 'consume', ?, ?, ?, ?, ?)
      ON CONFLICT(dedupe_key) DO NOTHING`,
    ).run(
      allocateRuntimeEntityId(this.#phaseOneSchema, this.internalId),
      input.issued.userId,
      input.issued.entitlementId,
      input.issued.requestId,
      input.settlement.dictationRequestId,
      input.settlement.audioDurationMs,
      input.debitedDurationMs,
      input.reasonCode,
      input.dedupeKey,
      input.createdAt.iso,
    );
    if (result.changes === 0) {
      const existing = this.consumeLedger(input.dedupeKey);
      this.assertMatchingConsumeLedger(existing, input);
      return Object.freeze({ inserted: false, ledger: existing });
    }
    const inserted = this.consumeLedger(input.dedupeKey);
    this.assertMatchingConsumeLedger(inserted, input);
    return Object.freeze({ inserted: true, ledger: inserted });
  }

  private assertMatchingConsumeLedger(
    ledger: StoredConsumeLedger | undefined,
    input: Readonly<{
      issued: IssuedTicket;
      settlement: Readonly<{
        audioDurationMs: number;
        dictationRequestId: string | null;
      }>;
      reasonCode: string;
      dedupeKey: string;
      createdAt?: CanonicalInstant;
      debitedDurationMs?: number;
    }>,
  ): asserts ledger is StoredConsumeLedger & Readonly<{ debited_duration_ms: number }> {
    if (
      ledger === undefined ||
      ledger.user_id !== input.issued.userId ||
      ledger.entitlement_id !== input.issued.entitlementId ||
      ledger.request_id !== input.issued.requestId ||
      ledger.dictation_request_id !== input.settlement.dictationRequestId ||
      ledger.event_type !== "consume" ||
      ledger.duration_ms !== input.settlement.audioDurationMs ||
      ledger.debited_duration_ms === null ||
      !Number.isSafeInteger(ledger.debited_duration_ms) ||
      ledger.debited_duration_ms < 0 ||
      ledger.debited_duration_ms > input.settlement.audioDurationMs ||
      (input.debitedDurationMs !== undefined && ledger.debited_duration_ms !== input.debitedDurationMs) ||
      ledger.reason_code !== input.reasonCode ||
      ledger.dedupe_key !== input.dedupeKey ||
      (input.createdAt !== undefined && ledger.created_at !== input.createdAt.iso)
    ) {
      invalidPersistence();
    }
    assertCanonicalPersistedInstant(ledger.created_at);
  }

  private replayTargetRemaining(
    entitlement: StoredEntitlement,
    target: StoredConsumeLedger & Readonly<{ debited_duration_ms: number }>,
  ): number {
    const ledger = this.database.prepare(
      `SELECT rowid, user_id, entitlement_id,
              ${this.#phaseOneSchema ? "request_ref" : "request_id"} AS request_id,
              dictation_request_id,
              event_type, duration_ms, debited_duration_ms, reason_code,
              dedupe_key, created_at
       FROM billing_usage_ledger
       WHERE entitlement_id = ? AND rowid <= ?
       ORDER BY rowid`,
    ).all(entitlement.id, target.rowid) as StoredLedgerRow[];
    let balance: number | undefined;
    let grants = 0;
    let foundTarget = false;
    for (const row of ledger) {
      if (
        row.user_id !== entitlement.user_id ||
        row.entitlement_id !== entitlement.id ||
        !Number.isSafeInteger(row.rowid) ||
        row.rowid < 1 ||
        !Number.isSafeInteger(row.duration_ms) ||
        row.duration_ms < 0 ||
        typeof row.reason_code !== "string" ||
        row.reason_code.length < 1 ||
        typeof row.dedupe_key !== "string" ||
        row.dedupe_key.length < 1
      ) {
        invalidPersistence();
      }
      assertCanonicalPersistedInstant(row.created_at);
      if (row.event_type === "grant") {
        if (
          balance !== undefined ||
          row.debited_duration_ms !== null ||
          row.duration_ms !== entitlement.granted_duration_ms
        ) {
          invalidPersistence();
        }
        grants += 1;
        balance = row.duration_ms;
      } else {
        if (balance === undefined) {
          invalidPersistence();
        }
        if (row.event_type === "consume") {
          if (
            row.debited_duration_ms === null ||
            !Number.isSafeInteger(row.debited_duration_ms) ||
            row.debited_duration_ms < 0 ||
            row.debited_duration_ms !== Math.min(row.duration_ms, balance)
          ) {
            invalidPersistence();
          }
          balance -= row.debited_duration_ms;
        } else if (
          row.event_type === "expire" ||
          row.event_type === "void_trial" ||
          row.event_type === "refund_revoke"
        ) {
          if (row.debited_duration_ms !== null || row.duration_ms !== balance) {
            invalidPersistence();
          }
          balance = 0;
        } else {
          invalidPersistence();
        }
      }
      if (row.rowid === target.rowid) {
        if (row.event_type !== "consume") {
          invalidPersistence();
        }
        foundTarget = true;
      }
    }
    if (grants !== 1 || balance === undefined || !foundTarget) {
      invalidPersistence();
    }
    return balance;
  }
}
