import { createHash } from "node:crypto";

import type { CoreDatabase } from "../db/database.js";
import {
  allocateInternalId,
  generateInternalId,
  type InternalIdGenerator,
} from "../ids/internalId.js";

export const closedBetaEnrollmentAuditEventTypes = [
  "verification_failed",
  "verification_succeeded",
  "consumed",
  "locked",
  "revoked",
  "expired",
] as const;

export type ClosedBetaEnrollmentAuditEventType =
  (typeof closedBetaEnrollmentAuditEventTypes)[number];

export type ClosedBetaEnrollmentAuditOutcome =
  | "invalid"
  | "limited"
  | "success"
  | "consumed"
  | "locked"
  | "revoked"
  | "expired";

type ClosedBetaEnrollmentAuditReferences = Readonly<{
  requestId?: string;
  accountId?: string;
  sessionId?: string;
  ipLookup?: string;
  ipKeyVersion?: string;
  occurredAt: Date;
}>;

export type ClosedBetaEnrollmentAuditEvent =
  ClosedBetaEnrollmentAuditReferences &
    (
      | Readonly<{
          type: "verification_failed";
          outcome: "invalid" | "limited";
        }>
      | Readonly<{
          type: "verification_succeeded";
          outcome: "success";
        }>
      | Readonly<{ type: "consumed"; outcome: "consumed" }>
      | Readonly<{ type: "locked"; outcome: "locked" }>
      | Readonly<{ type: "revoked"; outcome: "revoked" }>
      | Readonly<{ type: "expired"; outcome: "expired" }>
    );

const allowedTypes = new Set<string>(closedBetaEnrollmentAuditEventTypes);
const allowedOutcomesByType: Readonly<
  Record<ClosedBetaEnrollmentAuditEventType, ReadonlySet<string>>
> = Object.freeze({
  verification_failed: new Set(["invalid", "limited"]),
  verification_succeeded: new Set(["success"]),
  consumed: new Set(["consumed"]),
  locked: new Set(["locked"]),
  revoked: new Set(["revoked"]),
  expired: new Set(["expired"]),
});
const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function pseudonymousReference(value: string | undefined): string | null {
  return value === undefined
    ? null
    : createHash("sha256").update(value).digest("hex");
}

export class ClosedBetaEnrollmentAuditService {
  private readonly phaseOneSchema: boolean;

  constructor(
    private readonly database: CoreDatabase,
    private readonly internalId: InternalIdGenerator = generateInternalId,
  ) {
    this.phaseOneSchema = (
      this.database
        .prepare("PRAGMA table_info(closed_beta_enrollment_audit_events)")
        .all() as Array<{ name: string }>
    ).some(({ name }) => name === "request_ref");
  }

  record(event: ClosedBetaEnrollmentAuditEvent): void {
    if (!allowedTypes.has(event.type)) {
      throw new Error("Closed-beta enrollment audit type is not allow-listed");
    }
    if (
      !allowedOutcomesByType[
        event.type as ClosedBetaEnrollmentAuditEventType
      ].has(event.outcome)
    ) {
      throw new Error("Closed-beta enrollment audit type/outcome pair is invalid");
    }
    if (
      event.requestId !== undefined &&
      !requestIdPattern.test(event.requestId)
    ) {
      throw new Error("Closed-beta enrollment audit request ID is invalid");
    }

    let ipReference: string | null = null;
    let ipKeyVersion: string | null = null;
    if (event.ipLookup !== undefined || event.ipKeyVersion !== undefined) {
      const separator = event.ipLookup?.indexOf(":") ?? -1;
      if (
        separator <= 0 ||
        event.ipKeyVersion === undefined ||
        event.ipLookup?.slice(0, separator) !== event.ipKeyVersion ||
        !/^[a-f0-9]{64}$/.test(event.ipLookup.slice(separator + 1))
      ) {
        throw new Error("Closed-beta enrollment audit IP pseudonym is invalid");
      }
      ipReference = event.ipLookup.slice(separator + 1);
      ipKeyVersion = event.ipKeyVersion;
    }

    const id = allocateInternalId(this.internalId);
    if (this.phaseOneSchema) {
      this.database.prepare(
        `INSERT INTO closed_beta_enrollment_audit_events (
          id, event_type, request_ref, account_id, session_id,
          account_ref, session_ref, ip_ref, ip_key_version,
          outcome, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        event.type,
        event.requestId ?? null,
        event.accountId ?? null,
        event.sessionId ?? null,
        pseudonymousReference(event.accountId),
        pseudonymousReference(event.sessionId),
        ipReference,
        ipKeyVersion,
        event.outcome,
        event.occurredAt.toISOString(),
      );
      return;
    }
    this.database.prepare(
      `INSERT INTO closed_beta_enrollment_audit_events (
        id, event_type, request_id, account_ref, session_ref,
        ip_ref, ip_key_version, outcome, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      event.type,
      event.requestId ?? null,
      pseudonymousReference(event.accountId),
      pseudonymousReference(event.sessionId),
      ipReference,
      ipKeyVersion,
      event.outcome,
      event.occurredAt.toISOString(),
    );
  }
}
