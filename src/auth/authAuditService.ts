import { createHash } from "node:crypto";

import type { CoreDatabase } from "../db/database.js";
import {
  allocateInternalId,
  generateInternalId,
  type InternalIdGenerator,
} from "../ids/internalId.js";

export const authAuditEventTypes = [
  "challenge_sent",
  "provider_rejected",
  "verification_failed",
  "verification_succeeded",
  "account_created",
  "session_replaced",
  "session_rotated",
  "session_replayed",
  "session_revoked",
] as const;

export type AuthAuditEventType = (typeof authAuditEventTypes)[number];

export type AuthAuditOutcome =
  | "accepted"
  | "rejected"
  | "invalid"
  | "limited"
  | "success"
  | "created"
  | "replaced"
  | "rotated"
  | "replayed"
  | "revoked";

export type AuthAuditEvent = Readonly<{
  type: AuthAuditEventType;
  requestId: string;
  accountId?: string;
  sessionId?: string;
  ipLookup?: string;
  ipKeyVersion?: string;
  outcome: AuthAuditOutcome;
  mockMode: boolean;
  occurredAt: Date;
}>;

const allowedTypes = new Set<string>(authAuditEventTypes);
const allowedOutcomesByType: Readonly<
  Record<AuthAuditEventType, ReadonlySet<string>>
> = Object.freeze({
  challenge_sent: new Set(["accepted"]),
  provider_rejected: new Set(["rejected"]),
  verification_failed: new Set(["invalid", "limited"]),
  verification_succeeded: new Set(["success"]),
  account_created: new Set(["created"]),
  session_replaced: new Set(["replaced"]),
  session_rotated: new Set(["rotated"]),
  session_replayed: new Set(["replayed"]),
  session_revoked: new Set(["revoked"]),
});
const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function pseudonymousReference(value: string | undefined): string | null {
  return value === undefined
    ? null
    : createHash("sha256").update(value).digest("hex");
}

export class AuthAuditService {
  private readonly phaseOneSchema: boolean;

  constructor(
    private readonly database: CoreDatabase,
    private readonly internalId: InternalIdGenerator = generateInternalId,
  ) {
    this.phaseOneSchema = (
      this.database.prepare("PRAGMA table_info(auth_audit_events)").all() as Array<{
        name: string;
      }>
    ).some(({ name }) => name === "request_ref");
  }

  record(event: AuthAuditEvent): void {
    if (!allowedTypes.has(event.type)) {
      throw new Error(`Authentication audit type is not allow-listed`);
    }
    if (!allowedOutcomesByType[event.type].has(event.outcome)) {
      throw new Error("Authentication audit type/outcome pair is invalid");
    }
    if (!requestIdPattern.test(event.requestId)) {
      throw new Error("Authentication audit request ID is invalid");
    }
    let ipReference: string | null = null;
    let ipKeyVersion: string | null = null;
    if (
      event.ipLookup !== undefined ||
      event.ipKeyVersion !== undefined
    ) {
      const separator = event.ipLookup?.indexOf(":") ?? -1;
      if (
        separator <= 0 ||
        event.ipKeyVersion === undefined ||
        event.ipLookup?.slice(0, separator) !== event.ipKeyVersion ||
        !/^[a-f0-9]{64}$/.test(event.ipLookup.slice(separator + 1))
      ) {
        throw new Error("Authentication audit IP pseudonym is invalid");
      }
      ipReference = event.ipLookup.slice(separator + 1);
      ipKeyVersion = event.ipKeyVersion;
    }
    const id = allocateInternalId(this.internalId);
    if (this.phaseOneSchema) {
      this.database.prepare(
        `INSERT INTO auth_audit_events (
          id, event_type, request_ref, account_id, session_id,
          account_ref, session_ref, ip_ref, ip_key_version,
          outcome, mock_mode, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        event.type,
        event.requestId,
        event.accountId ?? null,
        event.sessionId ?? null,
        pseudonymousReference(event.accountId),
        pseudonymousReference(event.sessionId),
        ipReference,
        ipKeyVersion,
        event.outcome,
        event.mockMode ? 1 : 0,
        event.occurredAt.toISOString(),
      );
      return;
    }
    this.database.prepare(
      `INSERT INTO auth_audit_events (
        id, event_type, request_id, account_ref, session_ref,
        ip_ref, ip_key_version, outcome, mock_mode, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      event.type,
      event.requestId,
      pseudonymousReference(event.accountId),
      pseudonymousReference(event.sessionId),
      ipReference,
      ipKeyVersion,
      event.outcome,
      event.mockMode ? 1 : 0,
      event.occurredAt.toISOString(),
    );
  }
}
