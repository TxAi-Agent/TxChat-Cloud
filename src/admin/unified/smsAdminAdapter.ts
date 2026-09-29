import { createHmac } from "node:crypto";

import { isInternalId } from "../../ids/internalId.js";
import {
  SmsAdministrationError,
  type SmsAdministrationRepository,
} from "../../smsAdmin/smsAdministrationRepository.js";
import {
  RuntimeSmsConfigurationRegistry,
  type SafeSmsAdministrationStatus,
} from "../../smsAdmin/runtimeSmsConfigurationRegistry.js";
import type { SafeSmsConfiguration } from "../../smsAdmin/smsAdminTypes.js";
import type { AdminIdentity } from "./adminAuthorization.js";
import type {
  AdminAuditAction,
  AdminAuditRepository,
  AdminAuditResult,
} from "./adminAuditRepository.js";

const REQUEST = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PHONE = /^\+86(1[3-9][0-9]{9})$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;

export type SmsAdminErrorCode =
  | "ADMIN_INVALID_REQUEST"
  | "ADMIN_SMS_NOT_FOUND"
  | "ADMIN_SMS_TEST_FAILED"
  | "ADMIN_SMS_RATE_LIMITED"
  | "ADMIN_SMS_STATE_CONFLICT"
  | "ADMIN_REVISION_CONFLICT"
  | "ADMIN_SERVICE_UNAVAILABLE";

export class SmsAdminError extends Error {
  constructor(readonly code: SmsAdminErrorCode) {
    super(code);
    this.name = "SmsAdminError";
  }
}

type MutationContext = Readonly<{ actor: AdminIdentity; requestId: string }>;

function fail(code: SmsAdminErrorCode): never { throw new SmsAdminError(code); }

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("ADMIN_INVALID_REQUEST");
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) fail("ADMIN_INVALID_REQUEST");
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail("ADMIN_INVALID_REQUEST");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) fail("ADMIN_INVALID_REQUEST");
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, required: readonly string[]): void {
  const keys = Object.keys(value);
  if (required.some((key) => !Object.hasOwn(value, key)) ||
      keys.some((key) => !required.includes(key))) fail("ADMIN_INVALID_REQUEST");
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.isWellFormed() || value.length < 1 ||
      value.length > maximum || value.trim() !== value || CONTROL.test(value)) {
    return fail("ADMIN_INVALID_REQUEST");
  }
  return value;
}

function mutationContext(value: unknown): MutationContext {
  const row = record(value); const actor = record(row.actor);
  if (!isInternalId(actor.accountId) || typeof actor.username !== "string" ||
      !REQUEST.test(String(row.requestId))) fail("ADMIN_INVALID_REQUEST");
  return Object.freeze({ actor: row.actor as AdminIdentity, requestId: String(row.requestId) });
}

function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail("ADMIN_INVALID_REQUEST");
  return value as number;
}

function mapped(error: unknown): SmsAdminError {
  if (error instanceof SmsAdminError) return error;
  if (error instanceof SmsAdministrationError) {
    if (error.code === "NOT_INITIALIZED") return new SmsAdminError("ADMIN_SMS_NOT_FOUND");
    if (error.code === "REVISION_CONFLICT") return new SmsAdminError("ADMIN_REVISION_CONFLICT");
    if (error.code === "INVALID_STATE") return new SmsAdminError("ADMIN_SMS_STATE_CONFLICT");
    if (error.code === "INVALID_REQUEST") return new SmsAdminError("ADMIN_INVALID_REQUEST");
  }
  return new SmsAdminError("ADMIN_SERVICE_UNAVAILABLE");
}

function result(error: SmsAdminError): AdminAuditResult {
  if (error.code === "ADMIN_SMS_RATE_LIMITED") return "rate_limited";
  if (error.code === "ADMIN_REVISION_CONFLICT" || error.code === "ADMIN_SMS_STATE_CONFLICT") return "conflict";
  if (error.code === "ADMIN_SMS_TEST_FAILED" || error.code === "ADMIN_SERVICE_UNAVAILABLE") return "failed";
  return "rejected";
}

export class SmsAdminAdapter {
  readonly #repository: SmsAdministrationRepository;
  readonly #registry: RuntimeSmsConfigurationRegistry;
  readonly #audit: AdminAuditRepository;
  readonly #rateLimitKey: Buffer;
  readonly #now: () => Date;

  constructor(options: Readonly<{
    repository: SmsAdministrationRepository;
    registry: RuntimeSmsConfigurationRegistry;
    audit: AdminAuditRepository;
    rateLimitKey: Buffer;
    now?: () => Date;
  }>) {
    if (!Buffer.isBuffer(options.rateLimitKey) || options.rateLimitKey.length < 32) {
      throw new TypeError("Invalid unified SMS administration options");
    }
    this.#repository = options.repository;
    this.#registry = options.registry;
    this.#audit = options.audit;
    this.#rateLimitKey = Buffer.from(options.rateLimitKey);
    this.#now = options.now ?? (() => new Date());
  }

  status(): SafeSmsAdministrationStatus { return this.#registry.safeStatus(); }
  list(): readonly SafeSmsConfiguration[] { return this.#repository.listSafe(); }

  createDraft(value: unknown): SafeSmsConfiguration {
    const context = mutationContext(value); const row = record(value);
    try {
      exact(row, ["actor", "requestId", "input"]);
      const input = record(row.input);
      const allowed = ["templateCode", "accessKeyId", "accessKeySecret", "expectedRevision"];
      if (Object.keys(input).some((key) => !allowed.includes(key)) ||
          !["templateCode", "accessKeyId", "accessKeySecret"].every((key) => Object.hasOwn(input, key))) {
        fail("ADMIN_INVALID_REQUEST");
      }
      const expected = input.expectedRevision === undefined || input.expectedRevision === null
        ? null : revision(input.expectedRevision);
      const created = this.#registry.saveDraft({
        expectedRevision: expected,
        templateCode: text(input.templateCode, 36),
        accessKeyId: text(input.accessKeyId, 512),
        accessKeySecret: text(input.accessKeySecret, 512),
      });
      this.#record("sms_drafted", "accepted", context, created.id, created.revision);
      return created;
    } catch (error) {
      const failure = mapped(error); this.#record("sms_drafted", result(failure), context);
      throw failure;
    }
  }

  async test(value: unknown): Promise<SafeSmsConfiguration> {
    const context = mutationContext(value); const row = record(value);
    let id: string | undefined; let targetRevision: number | undefined;
    try {
      exact(row, ["actor", "requestId", "id", "expectedRevision", "phone"]);
      if (!isInternalId(row.id) || typeof row.phone !== "string" || !PHONE.test(row.phone)) {
        fail("ADMIN_INVALID_REQUEST");
      }
      id = row.id; targetRevision = revision(row.expectedRevision);
      this.#takeRateLimits(context.actor.accountId, row.phone);
      const draft = this.#repository.safeDraft();
      if (draft === null || draft.id !== id) fail("ADMIN_SMS_NOT_FOUND");
      const tested = await this.#registry.testDraft({ draftRevision: targetRevision, phone: row.phone });
      if (tested.status !== "accepted") fail("ADMIN_SMS_TEST_FAILED");
      const safe = this.#repository.safeDraft();
      if (safe === null) fail("ADMIN_SERVICE_UNAVAILABLE");
      this.#record("sms_tested", "accepted", context, id, safe.revision);
      return safe;
    } catch (error) {
      const failure = mapped(error); this.#record("sms_tested", result(failure), context, id, targetRevision);
      throw failure;
    }
  }

  activate(value: unknown): SafeSmsAdministrationStatus {
    const context = mutationContext(value); const row = record(value);
    let id: string | undefined; let targetRevision: number | undefined;
    try {
      exact(row, ["actor", "requestId", "id", "expectedRevision"]);
      if (!isInternalId(row.id)) fail("ADMIN_INVALID_REQUEST");
      id = row.id; targetRevision = revision(row.expectedRevision);
      const status = this.#registry.activateDraft(id, targetRevision);
      this.#record("sms_activated", "accepted", context, id, targetRevision);
      return status;
    } catch (error) {
      const failure = mapped(error); this.#record("sms_activated", result(failure), context, id, targetRevision);
      throw failure;
    }
  }

  rollback(value: unknown): SafeSmsAdministrationStatus {
    const context = mutationContext(value); const row = record(value);
    try {
      exact(row, ["actor", "requestId"]);
      const status = this.#registry.rollback();
      this.#record("sms_rolled_back", "accepted", context, status.active?.id, status.active?.revision);
      return status;
    } catch (error) {
      const failure = mapped(error); this.#record("sms_rolled_back", result(failure), context);
      throw failure;
    }
  }

  dispose(): void { this.#rateLimitKey.fill(0); }

  #takeRateLimits(adminId: string, phone: string): void {
    const now = this.#date();
    const shanghai = new Date(now.getTime() + 8 * 60 * 60_000);
    const dayStart = new Date(Date.UTC(shanghai.getUTCFullYear(), shanghai.getUTCMonth(), shanghai.getUTCDate()) - 8 * 60 * 60_000);
    const checks = [
      { scopeKind: "administrator" as const, subject: adminId, start: dayStart, limit: 20 },
      // Stored instants have millisecond precision and repository bounds are
      // inclusive. Exclude exactly one-hour-old events from the rolling window.
      { scopeKind: "test_phone" as const, subject: phone, start: new Date(now.getTime() - 60 * 60_000 + 1), limit: 5 },
    ];
    for (const check of checks) {
      const subjectLookup = createHmac("sha256", this.#rateLimitKey).update(check.subject, "utf8").digest("hex");
      const allowed = this.#repository.rateLimit({ scopeKind: check.scopeKind,
        subjectLookup, eventType: "test_attempt", windowStartedAt: check.start.toISOString(),
        now: now.toISOString(), limit: check.limit });
      if (!allowed.allowed) fail("ADMIN_SMS_RATE_LIMITED");
    }
  }

  #date(): Date {
    const now = this.#now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail("ADMIN_SERVICE_UNAVAILABLE");
    return now;
  }

  #record(action: AdminAuditAction, auditResult: AdminAuditResult, context: MutationContext,
    targetId?: string, targetRevision?: number): void {
    this.#audit.record({ occurredAt: this.#date().toISOString(), actorAdminId: context.actor.accountId,
      actorUsernameSnapshot: context.actor.username, action, result: auditResult,
      requestCorrelation: context.requestId, ...(targetId === undefined ? {} : { targetId }),
      ...(targetRevision === undefined ? {} : { targetRevision }) });
  }
}
