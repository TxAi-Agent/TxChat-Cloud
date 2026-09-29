import {
  type CoreDatabase,
  withImmediateTransaction,
} from "../../db/database.js";
import {
  generateInternalId,
  type InternalIdGenerator,
  isInternalId,
} from "../../ids/internalId.js";
import { insertWithInternalId } from "../../ids/sqliteInternalId.js";
import { normalizeAdminUsername } from "./adminPassword.js";

export const ADMIN_AUDIT_ACTIONS = Object.freeze([
  "setup_issued",
  "setup_consumed",
  "login",
  "logout",
  "rate_limited",
  "account_created",
  "account_deleted",
  "password_reset_issued",
  "password_reset_consumed",
  "permissions_changed",
  "user_disabled",
  "user_restored",
  "offer_drafted",
  "offer_published",
  "offer_scheduled",
  "sales_paused",
  "sales_resumed",
  "refund_recorded",
  "model_drafted",
  "model_tested",
  "model_activated",
  "model_rolled_back",
  "sms_drafted",
  "sms_tested",
  "sms_activated",
  "sms_rolled_back",
  "access_denied",
  "revision_conflict",
  "service_failed",
  "migration_normalized",
] as const);

export const ADMIN_AUDIT_RESULTS = Object.freeze([
  "accepted",
  "rejected",
  "rate_limited",
  "conflict",
  "failed",
  "uncertain",
] as const);

export type AdminAuditAction = typeof ADMIN_AUDIT_ACTIONS[number];
export type AdminAuditResult = typeof ADMIN_AUDIT_RESULTS[number];

export type AdminAuditInput = Readonly<{
  occurredAt: string;
  actorAdminId?: string;
  actorUsernameSnapshot?: string;
  targetId?: string;
  targetUsernameSnapshot?: string;
  requestRef?: string;
  action: AdminAuditAction;
  result: AdminAuditResult;
  targetRevision?: number;
  requestCorrelation?: string;
}>;

export type AdminAuditEvent = Readonly<{
  id: string;
  occurredAt: string;
  actorAdminId: string | null;
  actorUsernameSnapshot: string | null;
  targetId: string | null;
  targetUsernameSnapshot: string | null;
  requestRef: string | null;
  action: AdminAuditAction;
  result: AdminAuditResult;
  targetRevision: number | null;
  requestCorrelation: string | null;
}>;

export type AdminAuditErrorCode =
  | "ADMIN_AUDIT_REJECTED"
  | "ADMIN_AUDIT_SERVICE_UNAVAILABLE";

export class AdminAuditError extends Error {
  constructor(readonly code: AdminAuditErrorCode) {
    super(code);
    this.name = "AdminAuditError";
  }
}

const ACTIONS = new Set<string>(ADMIN_AUDIT_ACTIONS);
const RESULTS = new Set<string>(ADMIN_AUDIT_RESULTS);
const INPUT_FIELDS = new Set([
  "occurredAt",
  "actorAdminId",
  "actorUsernameSnapshot",
  "targetId",
  "targetUsernameSnapshot",
  "requestRef",
  "action",
  "result",
  "targetRevision",
  "requestCorrelation",
]);
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function reject(): never {
  throw new AdminAuditError("ADMIN_AUDIT_REJECTED");
}

function canonicalTimestamp(value: string): string {
  if (typeof value !== "string" || !value.isWellFormed()) reject();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    reject();
  }
  return value;
}

function optionalInternalId(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !isInternalId(value)) reject();
  return value;
}

function optionalUsername(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") reject();
  try {
    normalizeAdminUsername(value);
  } catch {
    reject();
  }
  return value;
}

function optionalReference(value: unknown): string | null {
  if (value === undefined) return null;
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    !SAFE_REFERENCE.test(value)
  ) {
    reject();
  }
  return value;
}

function optionalRevision(value: unknown): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1) reject();
  return value as number;
}

function parseInput(input: AdminAuditInput): Omit<AdminAuditEvent, "id"> {
  if (
    input === null ||
    typeof input !== "object" ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  ) {
    reject();
  }
  for (const key of Object.keys(input)) {
    if (!INPUT_FIELDS.has(key)) reject();
  }
  if (!ACTIONS.has(input.action) || !RESULTS.has(input.result)) reject();

  const actorAdminId = optionalInternalId(input.actorAdminId);
  const actorUsernameSnapshot = optionalUsername(input.actorUsernameSnapshot);
  const targetId = optionalInternalId(input.targetId);
  const targetUsernameSnapshot = optionalUsername(input.targetUsernameSnapshot);
  if ((actorAdminId === null) !== (actorUsernameSnapshot === null)) reject();
  if (targetId === null && targetUsernameSnapshot !== null) reject();

  return Object.freeze({
    occurredAt: canonicalTimestamp(input.occurredAt),
    actorAdminId,
    actorUsernameSnapshot,
    targetId,
    targetUsernameSnapshot,
    requestRef: optionalReference(input.requestRef),
    action: input.action,
    result: input.result,
    targetRevision: optionalRevision(input.targetRevision),
    requestCorrelation: optionalReference(input.requestCorrelation),
  });
}

export class AdminAuditRepository {
  constructor(
    private readonly database: CoreDatabase,
    private readonly internalId: InternalIdGenerator = generateInternalId,
  ) {}

  record(input: AdminAuditInput): AdminAuditEvent {
    const event = parseInput(input);
    try {
      return withImmediateTransaction(this.database, () => {
        const statement = this.database.prepare(
          `INSERT INTO admin_audit_events (
            id, occurred_at, actor_admin_id, actor_username_snapshot,
            target_id, target_username_snapshot, request_ref,
            action_code, result_category, target_revision, request_correlation
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING`,
        );
        const id = insertWithInternalId({
          generate: this.internalId,
          insert: (candidate) => statement.run(
            candidate,
            event.occurredAt,
            event.actorAdminId,
            event.actorUsernameSnapshot,
            event.targetId,
            event.targetUsernameSnapshot,
            event.requestRef,
            event.action,
            event.result,
            event.targetRevision,
            event.requestCorrelation,
          ).changes === 1,
        });
        return Object.freeze({ id, ...event });
      });
    } catch (error) {
      if (error instanceof AdminAuditError) throw error;
      throw new AdminAuditError("ADMIN_AUDIT_SERVICE_UNAVAILABLE");
    }
  }
}
