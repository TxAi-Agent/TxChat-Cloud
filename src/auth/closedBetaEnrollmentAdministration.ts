import {
  type CoreDatabase,
  withImmediateTransaction,
} from "../db/database.js";
import {
  allocateInternalId,
  generateInternalId,
  type InternalIdGenerator,
} from "../ids/internalId.js";
import { authenticationPolicy } from "./authenticationPolicy.js";
import { ClosedBetaEnrollmentAuditService } from "./closedBetaEnrollmentAuditService.js";
import {
  createEnrollmentVerifier,
  isEnrollmentCredential,
} from "./closedBetaEnrollmentCredential.js";
import {
  createPhoneLookupCandidates,
  normalizeMainlandChinaPhone,
  type VersionedKeyRing,
} from "./phoneIdentity.js";

export type ClosedBetaEnrollmentImportEntry = Readonly<{
  phone: string;
  enrollmentCredential: string;
}>;

export type ClosedBetaEnrollmentImportResult = Readonly<{
  schemaVersion: 1;
  requestedCount: number;
  importedCount: number;
  status: "imported";
}>;

export type ClosedBetaEnrollmentRevokeResult = Readonly<{
  schemaVersion: 1;
  revokedCount: number;
  status: "revoked";
}>;

type ClosedBetaEnrollmentAdministrationInput = Readonly<{
  database: CoreDatabase;
  phoneLookupKeys: VersionedKeyRing;
  enrollmentVerificationKeys: VersionedKeyRing;
  now?: () => Date;
  internalId?: InternalIdGenerator;
}>;

type ValidatedEntry = Readonly<{
  phone: string;
  enrollmentCredential: string;
}>;

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function validateEntries(entries: unknown): readonly ValidatedEntry[] {
  if (
    !Array.isArray(entries) ||
    entries.length < 1 ||
    entries.length > authenticationPolicy.enrollmentMaxActive
  ) {
    throw new Error("Closed-beta enrollment import is invalid");
  }

  const validated: ValidatedEntry[] = [];
  try {
    for (const entry of entries) {
      if (
        !exactObject(entry, ["phone", "enrollmentCredential"]) ||
        typeof entry.phone !== "string" ||
        typeof entry.enrollmentCredential !== "string" ||
        !isEnrollmentCredential(entry.enrollmentCredential)
      ) {
        throw new Error();
      }
      const normalizedPhone = normalizeMainlandChinaPhone(entry.phone);
      if (normalizedPhone !== entry.phone) {
        throw new Error();
      }
      validated.push(
        Object.freeze({
          phone: normalizedPhone,
          enrollmentCredential: entry.enrollmentCredential,
        }),
      );
    }
  } catch {
    throw new Error("Closed-beta enrollment import is invalid");
  }

  if (new Set(validated.map(({ phone }) => phone)).size !== validated.length) {
    throw new Error("Closed-beta enrollment import is invalid");
  }
  return Object.freeze(validated);
}

function lookupVersion(lookup: string): string {
  const separator = lookup.indexOf(":");
  if (separator <= 0) {
    throw new Error("Closed-beta enrollment lookup is invalid");
  }
  return lookup.slice(0, separator);
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

export class ClosedBetaEnrollmentAdministration {
  private readonly database: CoreDatabase;
  private readonly phoneLookupKeys: VersionedKeyRing;
  private readonly enrollmentVerificationKeys: VersionedKeyRing;
  private readonly now: () => Date;
  private readonly internalId: InternalIdGenerator;

  constructor(input: ClosedBetaEnrollmentAdministrationInput) {
    this.database = input.database;
    this.phoneLookupKeys = input.phoneLookupKeys;
    this.enrollmentVerificationKeys = input.enrollmentVerificationKeys;
    this.now = input.now ?? (() => new Date());
    this.internalId = input.internalId ?? generateInternalId;
  }

  importEntries(entries: unknown): ClosedBetaEnrollmentImportResult {
    const validated = validateEntries(entries);
    const now = this.now();
    const createdAt = now.toISOString();
    const expiresAt = new Date(
      now.getTime() + authenticationPolicy.enrollmentTtlMs,
    ).toISOString();

    const importedCount = withImmediateTransaction(this.database, () => {
      const activeCount = this.database
        .prepare(
          "SELECT COUNT(*) AS count FROM closed_beta_enrollments WHERE status = 'active'",
        )
        .get() as { count: number };
      if (
        activeCount.count + validated.length >
        authenticationPolicy.enrollmentMaxActive
      ) {
        throw new Error("Closed-beta enrollment capacity exceeded");
      }

      const insert = this.database.prepare(
        `INSERT INTO closed_beta_enrollments (
          id, phone_lookup, phone_key_version,
          credential_verifier, credential_key_version,
          status, wrong_attempts, created_at, expires_at,
          terminal_at, consumed_by_user_id
        ) VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?, NULL, NULL)`,
      );

      for (const entry of validated) {
        const lookupCandidates = createPhoneLookupCandidates(
          entry.phone,
          this.phoneLookupKeys,
        );
        if (lookupCandidates.length < 1) {
          throw new Error("Closed-beta enrollment lookup is invalid");
        }
        const existing = this.database
          .prepare(
            `SELECT id
             FROM closed_beta_enrollments
             WHERE status = 'active'
               AND phone_lookup IN (${placeholders(lookupCandidates.length)})
             LIMIT 1`,
          )
          .get(...lookupCandidates);
        if (existing !== undefined) {
          throw new Error("Closed-beta enrollment already active");
        }

        const phoneLookup = lookupCandidates[0]!;
        const verifier = createEnrollmentVerifier(
          phoneLookup,
          entry.enrollmentCredential,
          this.enrollmentVerificationKeys,
        );
        insert.run(
          allocateInternalId(this.internalId),
          phoneLookup,
          lookupVersion(phoneLookup),
          verifier,
          this.enrollmentVerificationKeys.activeVersion,
          createdAt,
          expiresAt,
        );
      }
      return validated.length;
    });

    return Object.freeze({
      schemaVersion: 1,
      requestedCount: validated.length,
      importedCount,
      status: "imported",
    });
  }

  revokePhone(phone: string): ClosedBetaEnrollmentRevokeResult {
    let normalizedPhone: string;
    try {
      normalizedPhone = normalizeMainlandChinaPhone(phone);
    } catch {
      throw new Error("Closed-beta enrollment revoke is invalid");
    }
    const now = this.now();
    const occurredAt = now.toISOString();
    const lookupCandidates = createPhoneLookupCandidates(
      normalizedPhone,
      this.phoneLookupKeys,
    );

    const revokedCount = withImmediateTransaction(this.database, () => {
      const matches = this.database
        .prepare(
          `SELECT id
           FROM closed_beta_enrollments
           WHERE status = 'active'
             AND phone_lookup IN (${placeholders(lookupCandidates.length)})`,
        )
        .all(...lookupCandidates) as { id: string }[];
      if (matches.length > 1) {
        throw new Error("Closed-beta enrollment state is invalid");
      }
      const match = matches[0];
      if (match === undefined) {
        return 0;
      }

      const update = this.database
        .prepare(
          `UPDATE closed_beta_enrollments
           SET status = 'revoked',
               credential_verifier = NULL,
               terminal_at = ?
           WHERE id = ? AND status = 'active'`,
        )
        .run(occurredAt, match.id);
      if (update.changes !== 1) {
        throw new Error("Closed-beta enrollment state changed");
      }
      new ClosedBetaEnrollmentAuditService(this.database).record({
        type: "revoked",
        outcome: "revoked",
        occurredAt: now,
      });
      return 1;
    });

    return Object.freeze({
      schemaVersion: 1,
      revokedCount,
      status: "revoked",
    });
  }
}
