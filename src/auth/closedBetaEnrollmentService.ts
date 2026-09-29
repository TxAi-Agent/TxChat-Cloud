import { timingSafeEqual } from "node:crypto";

import type { CoreDatabase } from "../db/database.js";
import { withImmediateTransaction } from "../db/database.js";
import { authenticationPolicy } from "./authenticationPolicy.js";
import {
  AuthAuditService,
  type AuthAuditEvent,
} from "./authAuditService.js";
import {
  ClosedBetaEnrollmentAuditService,
  type ClosedBetaEnrollmentAuditEvent,
} from "./closedBetaEnrollmentAuditService.js";
import {
  isEnrollmentCredential,
  matchesEnrollmentVerifier,
} from "./closedBetaEnrollmentCredential.js";
import {
  ConfiguredTestCodeConfigurationError,
  type ConfiguredTestCodeReader,
} from "./configuredTestCodeReader.js";
import { AuthRateLimitService } from "./authRateLimitService.js";
import {
  createIpLookupCandidates,
  createPhoneLookupCandidates,
  keyVersion,
  maskAuthenticatedPhone,
  normalizeMainlandChinaPhone,
  type VersionedKeyRing,
} from "./phoneIdentity.js";
import {
  SessionFailure,
  type SessionBundle,
  type SessionService,
} from "./sessionService.js";
import type {
  VerifiedPhoneSessionInstallation,
  VerifiedPhoneSessionInstaller,
} from "./verifiedPhoneSessionInstaller.js";

export type ClosedBetaEnrollmentFailureCode =
  | "ENROLLMENT_INVALID_OR_EXPIRED"
  | "PHONE_NOT_ALLOWED"
  | "TOO_MANY_REQUESTS"
  | "SERVICE_UNAVAILABLE";

export class ClosedBetaEnrollmentFailure extends Error {
  constructor(
    readonly code: ClosedBetaEnrollmentFailureCode,
    readonly statusCode: 400 | 429 | 503,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = "ClosedBetaEnrollmentFailure";
  }
}

type EnrollmentRow = Readonly<{
  id: string;
  phone_lookup: string;
  credential_verifier: string;
  wrong_attempts: number;
  expires_at: string;
}>;

type EnrollmentTransactionOutcome =
  | Readonly<{
      kind: "success";
      installed: VerifiedPhoneSessionInstallation;
    }>
  | Readonly<{
      kind: "invalid";
      terminalEvent?: "expired" | "locked";
    }>
  | Readonly<{
      kind: "limited";
      retryAfterSeconds: number;
      terminalEvent?: "locked";
    }>;

type Installer = Pick<
  VerifiedPhoneSessionInstaller,
  "installWithinTransaction"
>;

type RevocationNotifier = Pick<SessionService, "notifyRevoked">;

export type ClosedBetaEnrollmentServiceOptions = Readonly<{
  database: CoreDatabase;
  phoneLookupKeys: VersionedKeyRing;
  ipLookupKeys: VersionedKeyRing;
  enrollmentVerificationKeys?: VersionedKeyRing;
  configuredTestCodes?: ConfiguredTestCodeReader;
  now: () => Date;
  installer: Installer;
  sessions: RevocationNotifier;
  audit?: Pick<ClosedBetaEnrollmentAuditService, "record">;
  codeRequestAudit?: Pick<AuthAuditService, "record">;
}>;

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

function invalidFailure(): ClosedBetaEnrollmentFailure {
  return new ClosedBetaEnrollmentFailure(
    "ENROLLMENT_INVALID_OR_EXPIRED",
    400,
  );
}

export class ClosedBetaEnrollmentService {
  private readonly rates: AuthRateLimitService;
  private readonly audit: Pick<ClosedBetaEnrollmentAuditService, "record">;
  private readonly codeRequestAudit: Pick<AuthAuditService, "record">;

  constructor(private readonly options: ClosedBetaEnrollmentServiceOptions) {
    this.rates = new AuthRateLimitService(options.database);
    this.audit =
      options.audit ?? new ClosedBetaEnrollmentAuditService(options.database);
    this.codeRequestAudit =
      options.codeRequestAudit ?? new AuthAuditService(options.database);
  }

  async requestCode(input: {
    phone: string;
    ipAddress: string;
    requestId: string;
  }): Promise<{
    enrollmentCredential: string;
  }> {
    const reader = this.options.configuredTestCodes;
    if (reader === undefined) {
      throw new ClosedBetaEnrollmentFailure("SERVICE_UNAVAILABLE", 503);
    }
    let phone: string | undefined;
    let phoneCandidates: readonly string[] = [];
    let ipCandidates: readonly string[];
    try {
      phone = normalizeMainlandChinaPhone(input.phone);
      phoneCandidates = createPhoneLookupCandidates(
        phone,
        this.options.phoneLookupKeys,
      );
    } catch {
      phone = undefined;
    }
    try {
      ipCandidates = createIpLookupCandidates(
        input.ipAddress,
        this.options.ipLookupKeys,
      );
    } catch {
      throw new ClosedBetaEnrollmentFailure("SERVICE_UNAVAILABLE", 503);
    }
    const now = this.options.now();
    let configuredCredential: string | undefined;
    try {
      configuredCredential =
        phone === undefined ? undefined : reader.readCode(phone);
    } catch (error) {
      if (error instanceof ConfiguredTestCodeConfigurationError) {
        throw new ClosedBetaEnrollmentFailure("SERVICE_UNAVAILABLE", 503);
      }
      throw new ClosedBetaEnrollmentFailure("SERVICE_UNAVAILABLE", 503);
    }
    const auditBase = {
      requestId: input.requestId,
      ipLookup: ipCandidates[0]!,
      ipKeyVersion: keyVersion(ipCandidates[0]!),
      occurredAt: now,
    } as const;
    if (configuredCredential !== undefined) {
      this.safeCodeRequestAudit({
        ...auditBase,
        type: "challenge_sent",
        outcome: "accepted",
        mockMode: false,
      });
      return { enrollmentCredential: configuredCredential };
    }
    type RequestCodeOutcome =
      | Readonly<{ kind: "invalid" }>
      | Readonly<{ kind: "limited"; retryAfterSeconds: number }>;
    let outcome: RequestCodeOutcome;
    try {
      outcome = withImmediateTransaction(this.options.database, () => {
        const rateDecision = this.rates.checkSend(
          phoneCandidates,
          ipCandidates,
          now,
        );
        if (!rateDecision.allowed) {
          return {
            kind: "limited" as const,
            retryAfterSeconds: rateDecision.retryAfterSeconds,
          };
        }
        if (phoneCandidates[0] !== undefined) {
          this.rates.recordSend("phone", phoneCandidates[0], now);
        }
        this.rates.recordSend("ip", ipCandidates[0]!, now);
        return { kind: "invalid" as const };
      });
    } catch (error) {
      if (error instanceof ConfiguredTestCodeConfigurationError) {
        throw new ClosedBetaEnrollmentFailure("SERVICE_UNAVAILABLE", 503);
      }
      throw new ClosedBetaEnrollmentFailure("SERVICE_UNAVAILABLE", 503);
    }
    if (outcome.kind === "limited") {
      this.safeCodeRequestAudit({
        ...auditBase,
        type: "verification_failed",
        outcome: "limited",
        mockMode: false,
      });
      throw new ClosedBetaEnrollmentFailure(
        "TOO_MANY_REQUESTS",
        429,
        outcome.retryAfterSeconds,
      );
    }
    this.safeCodeRequestAudit({
      ...auditBase,
      type: "verification_failed",
      outcome: "invalid",
      mockMode: false,
    });
    throw new ClosedBetaEnrollmentFailure("PHONE_NOT_ALLOWED", 400);
  }

  async verify(input: {
    phone: string;
    enrollmentCredential: string;
    ipAddress: string;
    requestId: string;
  }): Promise<{
    accountCreated: boolean;
    account: { maskedPhone: string; loggedIn: true };
    session: SessionBundle;
  }> {
    if (this.options.configuredTestCodes !== undefined) {
      return this.verifyConfiguredTestCode(input);
    }
    if (this.options.database.inTransaction) {
      throw new ClosedBetaEnrollmentFailure("SERVICE_UNAVAILABLE", 503);
    }
    let phone: string;
    let phoneCandidates: readonly string[];
    let ipCandidates: readonly string[];
    try {
      phone = normalizeMainlandChinaPhone(input.phone);
      if (!isEnrollmentCredential(input.enrollmentCredential)) {
        throw new Error("Invalid enrollment credential");
      }
      phoneCandidates = createPhoneLookupCandidates(
        phone,
        this.options.phoneLookupKeys,
      );
      ipCandidates = createIpLookupCandidates(
        input.ipAddress,
        this.options.ipLookupKeys,
      );
    } catch {
      throw invalidFailure();
    }

    const now = this.options.now();
    let outcome: EnrollmentTransactionOutcome;
    try {
      outcome = withImmediateTransaction(this.options.database, () =>
        this.verifyWithinTransaction(
          phone,
          input.enrollmentCredential,
          phoneCandidates,
          now,
        ),
      );
    } catch (error) {
      if (error instanceof SessionFailure) {
        try {
          outcome = withImmediateTransaction(this.options.database, () =>
            this.recordOpaqueInstallerFailure(
              phoneCandidates,
              now,
            ),
          );
        } catch {
          throw new ClosedBetaEnrollmentFailure("SERVICE_UNAVAILABLE", 503);
        }
      } else if (error instanceof ClosedBetaEnrollmentFailure) {
        throw error;
      } else {
        throw new ClosedBetaEnrollmentFailure("SERVICE_UNAVAILABLE", 503);
      }
    }

    const auditBase = {
      requestId: input.requestId,
      ipLookup: ipCandidates[0]!,
      ipKeyVersion: keyVersion(ipCandidates[0]!),
      occurredAt: now,
    } as const;
    if (outcome.kind === "invalid") {
      this.safeAudit({
        ...auditBase,
        type: "verification_failed",
        outcome: "invalid",
      });
      if (outcome.terminalEvent === "expired") {
        this.safeAudit({
          ...auditBase,
          type: "expired",
          outcome: "expired",
        });
      } else if (outcome.terminalEvent === "locked") {
        this.safeAudit({
          ...auditBase,
          type: "locked",
          outcome: "locked",
        });
      }
      throw invalidFailure();
    }
    if (outcome.kind === "limited") {
      this.safeAudit({
        ...auditBase,
        type: "verification_failed",
        outcome: "limited",
      });
      if (outcome.terminalEvent !== undefined) {
        this.safeAudit({
          ...auditBase,
          type: "locked",
          outcome: "locked",
        });
      }
      throw new ClosedBetaEnrollmentFailure(
        "TOO_MANY_REQUESTS",
        429,
        outcome.retryAfterSeconds,
      );
    }

    const { installed } = outcome;
    this.safeAudit({
      ...auditBase,
      type: "verification_succeeded",
      outcome: "success",
      accountId: installed.user.id,
      sessionId: installed.session.access.sessionId,
    });
    this.safeAudit({
      ...auditBase,
      type: "consumed",
      outcome: "consumed",
      accountId: installed.user.id,
      sessionId: installed.session.access.sessionId,
    });
    try {
      await this.options.sessions.notifyRevoked(
        installed.revokedSessionIds,
        "replaced",
      );
    } catch {
      // Database revocation and credential consumption are already committed.
    }
    return {
      accountCreated: installed.accountCreated,
      account: {
        maskedPhone: maskAuthenticatedPhone(phone),
        loggedIn: true,
      },
      session: installed.session,
    };
  }

  private async verifyConfiguredTestCode(input: {
    phone: string;
    enrollmentCredential: string;
    ipAddress: string;
    requestId: string;
  }): Promise<{
    accountCreated: boolean;
    account: { maskedPhone: string; loggedIn: true };
    session: SessionBundle;
  }> {
    if (this.options.database.inTransaction) {
      throw new ClosedBetaEnrollmentFailure("SERVICE_UNAVAILABLE", 503);
    }
    let phone: string;
    let configuredCode: string | undefined;
    let phoneCandidates: readonly string[];
    let ipCandidates: readonly string[];
    try {
      phone = normalizeMainlandChinaPhone(input.phone);
      if (!/^\d{6}$/.test(input.enrollmentCredential)) {
        throw invalidFailure();
      }
      configuredCode = this.options.configuredTestCodes!.readCode(phone);
      phoneCandidates = createPhoneLookupCandidates(
        phone,
        this.options.phoneLookupKeys,
      );
      ipCandidates = createIpLookupCandidates(
        input.ipAddress,
        this.options.ipLookupKeys,
      );
    } catch (error) {
      if (error instanceof ClosedBetaEnrollmentFailure) {
        throw error;
      }
      if (error instanceof ConfiguredTestCodeConfigurationError) {
        throw new ClosedBetaEnrollmentFailure("SERVICE_UNAVAILABLE", 503);
      }
      throw invalidFailure();
    }

    const now = this.options.now();
    let outcome: EnrollmentTransactionOutcome;
    try {
      outcome = withImmediateTransaction(this.options.database, () => {
        const rateDecision = this.rates.checkVerify(
          phoneCandidates,
          now,
        );
        if (!rateDecision.allowed) {
          return {
            kind: "limited" as const,
            retryAfterSeconds: rateDecision.retryAfterSeconds,
          };
        }
        const supplied = Buffer.from(input.enrollmentCredential, "ascii");
        const expected = Buffer.from(configuredCode ?? "000000", "ascii");
        const matched =
          configuredCode !== undefined &&
          supplied.length === expected.length &&
          timingSafeEqual(supplied, expected);
        supplied.fill(0);
        expected.fill(0);
        if (!matched) {
          return { kind: "invalid" as const };
        }
        return {
          kind: "success" as const,
          installed: this.options.installer.installWithinTransaction(
            phone,
            now,
          ),
        };
      });
    } catch (error) {
      if (error instanceof SessionFailure) {
        try {
          outcome = withImmediateTransaction(this.options.database, () =>
            this.recordOpaqueInstallerFailure(
              phoneCandidates,
              now,
            ),
          );
        } catch {
          throw new ClosedBetaEnrollmentFailure("SERVICE_UNAVAILABLE", 503);
        }
      } else {
        throw new ClosedBetaEnrollmentFailure("SERVICE_UNAVAILABLE", 503);
      }
    }

    const auditBase = {
      requestId: input.requestId,
      ipLookup: ipCandidates[0]!,
      ipKeyVersion: keyVersion(ipCandidates[0]!),
      occurredAt: now,
    } as const;
    if (outcome.kind === "invalid") {
      this.safeAudit({
        ...auditBase,
        type: "verification_failed",
        outcome: "invalid",
      });
      throw invalidFailure();
    }
    if (outcome.kind === "limited") {
      this.safeAudit({
        ...auditBase,
        type: "verification_failed",
        outcome: "limited",
      });
      throw new ClosedBetaEnrollmentFailure(
        "TOO_MANY_REQUESTS",
        429,
        outcome.retryAfterSeconds,
      );
    }

    const { installed } = outcome;
    this.safeAudit({
      ...auditBase,
      type: "verification_succeeded",
      outcome: "success",
      accountId: installed.user.id,
      sessionId: installed.session.access.sessionId,
    });
    try {
      await this.options.sessions.notifyRevoked(
        installed.revokedSessionIds,
        "replaced",
      );
    } catch {
      // Database session replacement is already committed.
    }
    return {
      accountCreated: installed.accountCreated,
      account: {
        maskedPhone: maskAuthenticatedPhone(phone),
        loggedIn: true,
      },
      session: installed.session,
    };
  }

  private verifyWithinTransaction(
    phone: string,
    credential: string,
    phoneCandidates: readonly string[],
    now: Date,
  ): EnrollmentTransactionOutcome {
    const rateDecision = this.rates.checkVerify(
      phoneCandidates,
      now,
    );
    const matchingRows = this.options.database
      .prepare(
        `SELECT id, phone_lookup, credential_verifier,
                wrong_attempts, expires_at
         FROM closed_beta_enrollments
         WHERE status = 'active'
           AND phone_lookup IN (${placeholders(phoneCandidates)})`,
      )
      .all(...phoneCandidates) as EnrollmentRow[];
    if (matchingRows.length > 1) {
      throw new Error("Closed-beta enrollment state is inconsistent");
    }
    const enrollment = matchingRows[0];
    if (!rateDecision.allowed) {
      if (enrollment !== undefined) {
        this.lockEnrollment(enrollment.id, enrollment.wrong_attempts, now);
      }
      return {
        kind: "limited",
        retryAfterSeconds: rateDecision.retryAfterSeconds,
        ...(enrollment === undefined ? {} : { terminalEvent: "locked" }),
      };
    }

    if (enrollment === undefined) {
      return { kind: "invalid" };
    }

    if (Date.parse(enrollment.expires_at) <= now.getTime()) {
      const expired = this.options.database
        .prepare(
          `UPDATE closed_beta_enrollments
           SET status = 'expired', credential_verifier = NULL,
               terminal_at = ?
           WHERE id = ? AND status = 'active'`,
        )
        .run(now.toISOString(), enrollment.id);
      if (expired.changes !== 1) {
        throw new Error("Closed-beta enrollment expiry changed");
      }
      return { kind: "invalid", terminalEvent: "expired" };
    }

    if (
      !matchesEnrollmentVerifier(
        enrollment.credential_verifier,
        enrollment.phone_lookup,
        credential,
        this.options.enrollmentVerificationKeys!,
      )
    ) {
      const wrongAttempts = enrollment.wrong_attempts + 1;
      const locked =
        wrongAttempts >= authenticationPolicy.enrollmentWrongAttempts;
      if (locked) {
        this.lockEnrollment(enrollment.id, wrongAttempts, now);
      } else {
        const updated = this.options.database
          .prepare(
            `UPDATE closed_beta_enrollments
             SET wrong_attempts = ?
             WHERE id = ? AND status = 'active'
               AND wrong_attempts = ?`,
          )
          .run(wrongAttempts, enrollment.id, enrollment.wrong_attempts);
        if (updated.changes !== 1) {
          throw new Error("Closed-beta enrollment attempt changed");
        }
      }
      return {
        kind: "invalid",
        ...(locked ? { terminalEvent: "locked" } : {}),
      };
    }

    const installed = this.options.installer.installWithinTransaction(phone, now);
    const consumed = this.options.database
      .prepare(
        `UPDATE closed_beta_enrollments
         SET status = 'consumed', credential_verifier = NULL,
             terminal_at = ?, consumed_by_user_id = ?
         WHERE id = ? AND status = 'active'`,
      )
      .run(now.toISOString(), installed.user.id, enrollment.id);
    if (consumed.changes !== 1) {
      throw new Error("Closed-beta enrollment consumption changed");
    }
    return { kind: "success", installed };
  }

  private recordOpaqueInstallerFailure(
    phoneCandidates: readonly string[],
    now: Date,
  ): EnrollmentTransactionOutcome {
    const rateDecision = this.rates.checkVerify(
      phoneCandidates,
      now,
    );
    if (!rateDecision.allowed) {
      return {
        kind: "limited",
        retryAfterSeconds: rateDecision.retryAfterSeconds,
      };
    }
    return { kind: "invalid" };
  }

  private lockEnrollment(
    enrollmentId: string,
    wrongAttempts: number,
    now: Date,
  ): void {
    const locked = this.options.database
      .prepare(
        `UPDATE closed_beta_enrollments
         SET status = 'locked', wrong_attempts = ?,
             credential_verifier = NULL, terminal_at = ?
         WHERE id = ? AND status = 'active'`,
      )
      .run(
        Math.min(
          wrongAttempts,
          authenticationPolicy.enrollmentWrongAttempts,
        ),
        now.toISOString(),
        enrollmentId,
      );
    if (locked.changes !== 1) {
      throw new Error("Closed-beta enrollment lock changed");
    }
  }

  private safeAudit(event: ClosedBetaEnrollmentAuditEvent): void {
    try {
      this.audit.record(event);
    } catch {
      // Authentication and terminal state never depend on audit availability.
    }
  }

  private safeCodeRequestAudit(event: AuthAuditEvent): void {
    try {
      this.codeRequestAudit.record(event);
    } catch {
      // Code-request outcomes never depend on audit availability.
    }
  }
}
