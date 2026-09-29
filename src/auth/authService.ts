import { createHash } from "node:crypto";

import type { CoreDatabase } from "../db/database.js";
import { withImmediateTransaction } from "../db/database.js";
import { AuthRepository } from "../db/repositories.js";
import {
  allocateInternalId,
  generateInternalId,
  type InternalIdGenerator,
} from "../ids/internalId.js";
import { authenticationPolicy } from "./authenticationPolicy.js";
import {
  AuthAuditService,
  type AuthAuditEventType,
} from "./authAuditService.js";
import { AuthRateLimitService } from "./authRateLimitService.js";
import { AuthRetentionService } from "./authRetentionService.js";
import { ClosedBetaEnrollmentService } from "./closedBetaEnrollmentService.js";
import type { ConfiguredTestCodeReader } from "./configuredTestCodeReader.js";
import {
  createIpLookupCandidates,
  createPhoneLookupCandidates,
  decryptPhone,
  encryptPhone,
  keyVersion,
  maskAuthenticatedPhone,
  normalizeMainlandChinaPhone,
  type VersionedKeyRing,
} from "./phoneIdentity.js";
import {
  SessionFailure,
  SessionService,
  type SessionBundle,
  type SessionRevocationSink,
} from "./sessionService.js";
import {
  SmsChallengeService,
} from "./smsChallengeService.js";
import type {
  SmsDeliveryOutcome,
  SmsProvider,
} from "./smsProvider.js";
import { TokenService } from "./tokenService.js";
import {
  VerifiedPhoneSessionInstaller,
  type VerifiedPhoneUser,
} from "./verifiedPhoneSessionInstaller.js";

export type AuthFailureCode =
  | "PHONE_INVALID"
  | "VERIFICATION_CODE_INVALID_OR_EXPIRED"
  | "TOO_MANY_REQUESTS"
  | "SMS_PROVIDER_UNAVAILABLE"
  | "INVALID_REQUEST"
  | "AUTH_REQUIRED"
  | "SESSION_REPLACED"
  | "SESSION_EXPIRED"
  | "ACCOUNT_DISABLED"
  | "SESSION_REPLAYED"
  | "SERVICE_UNAVAILABLE";

export type AuthFailureReason =
  | "incorrect"
  | "expired"
  | "exhausted"
  | "invalid_or_expired"
  | "verification_retry"
  | "verification_locked"
  | "send_cooldown"
  | "send_quota";

export type AuthFailureDetails = Readonly<{
  reason?: AuthFailureReason;
  attemptsRemaining?: number;
}>;

export class AuthFailure extends Error {
  constructor(
    readonly code: AuthFailureCode,
    readonly statusCode: number,
    readonly retryAfterSeconds?: number,
    readonly details: AuthFailureDetails = {},
  ) {
    super(code);
  }

  get reason(): AuthFailureReason | undefined {
    return this.details.reason;
  }

  get attemptsRemaining(): number | undefined {
    return this.details.attemptsRemaining;
  }
}

type AuthenticationKeys = Readonly<{
  jwtSigning: VersionedKeyRing;
  phoneLookup: VersionedKeyRing;
  phoneEncryption: VersionedKeyRing;
  otpVerification: VersionedKeyRing;
  ipLookup: VersionedKeyRing;
  refreshRecovery: VersionedKeyRing;
}>;

export type InviteAttributionResult =
  | "attributed"
  | "expired"
  | "invalid"
  | "unavailable";

type AuthenticationRuntimeOptions = Readonly<{
  database: CoreDatabase;
  environment: "development" | "test" | "production";
  codeMode: "mock" | "sms" | "closed_beta";
  matchesMockCode(candidate: string): boolean;
  enrollmentVerificationKeys?: VersionedKeyRing;
  configuredTestCodes?: ConfiguredTestCodeReader;
  keys: AuthenticationKeys;
  smsProvider: SmsProvider;
  now: () => Date;
  randomInt?: (minimum: number, maximum: number) => number;
  internalId?: InternalIdGenerator;
  revocationSink?: SessionRevocationSink;
  inviteAttributor?: {
    attribute(input: {
      accountId: string;
      inviteCode: string;
      occurredAt: Date;
    }): Promise<InviteAttributionResult>;
  };
}>;

type ChallengeRow = {
  id: string;
  phone_lookup: string;
  phone_ciphertext: string;
  otp_verifier: string | null;
  status:
    | "pending"
    | "active"
    | "consumed"
    | "provider_rejected"
    | "superseded"
    | "expired"
    | "exhausted"
    | "locked";
  wrong_attempts: number;
  expires_at: string;
  last_failed_code_verifier: string | null;
  last_verification_attempt_at: string | null;
};

type VerifyOutcome =
  | Readonly<{
      kind: "success";
      accountCreated: boolean;
      user: VerifiedPhoneUser;
      session: SessionBundle;
      revokedSessionIds: readonly string[];
    }>
  | Readonly<{
      kind: "failure";
      code: "VERIFICATION_CODE_INVALID_OR_EXPIRED";
      reason: Extract<
        AuthFailureReason,
        "incorrect" | "expired" | "exhausted" | "invalid_or_expired"
      >;
      attemptsRemaining?: number;
    }>
  | Readonly<{
      kind: "limited";
      retryAfterSeconds: number;
      reason: Extract<
        AuthFailureReason,
        "verification_retry" | "verification_locked"
      >;
    }>;

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

function validInviteCode(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

const verificationCodePattern = new RegExp(
  `^\\d{${authenticationPolicy.codeDigits}}$`,
);

export class AuthService {
  private readonly repository: AuthRepository;
  private readonly audit: AuthAuditService;
  private readonly rates: AuthRateLimitService;
  private readonly challenges: SmsChallengeService;
  private readonly sessions: SessionService;
  private readonly verifiedPhoneInstaller: VerifiedPhoneSessionInstaller;

  constructor(
    private readonly options: AuthenticationRuntimeOptions,
    sessions: SessionService,
    verifiedPhoneInstaller: VerifiedPhoneSessionInstaller,
  ) {
    this.repository = new AuthRepository(options.database);
    this.audit = new AuthAuditService(options.database, options.internalId);
    this.rates = new AuthRateLimitService(options.database, options.internalId);
    this.challenges = new SmsChallengeService({
      environment: options.environment,
      codeMode: options.codeMode,
      matchesMockCode: options.matchesMockCode,
      ...(options.configuredTestCodes === undefined
        ? {}
        : { configuredTestCodes: options.configuredTestCodes }),
      otpKeys: options.keys.otpVerification,
      smsProvider: options.smsProvider,
      ...(options.randomInt === undefined
        ? {}
        : { randomInt: options.randomInt }),
    });
    this.sessions = sessions;
    this.verifiedPhoneInstaller = verifiedPhoneInstaller;
  }

  async sendSms(input: {
    phone: string;
    ipAddress: string;
    requestId: string;
  }): Promise<{
    outcome: "accepted";
    challengeId: string;
    expiresInSeconds: number;
    resendAfterSeconds: number;
  }> {
    let phone: string;
    try {
      phone = normalizeMainlandChinaPhone(input.phone);
    } catch {
      throw new AuthFailure("PHONE_INVALID", 400);
    }
    const now = this.options.now();
    const phoneCandidates = createPhoneLookupCandidates(
      phone,
      this.options.keys.phoneLookup,
    );
    const ipCandidates = createIpLookupCandidates(
      input.ipAddress,
      this.options.keys.ipLookup,
    );
    const existingUser = this.options.database
      .prepare(
        `SELECT phone_lookup
         FROM users
         WHERE phone_lookup IN (${placeholders(phoneCandidates)})
         LIMIT 1`,
      )
      .get(...phoneCandidates) as { phone_lookup: string } | undefined;
    const phoneLookup =
      existingUser?.phone_lookup ?? phoneCandidates[0]!;
    const challengeId = allocateInternalId(
      this.options.internalId ?? generateInternalId,
    );
    const code = this.challenges.createCode(phone);
    const phoneCiphertext = encryptPhone(
      phone,
      this.options.keys.phoneEncryption,
    );
    const verifier = this.challenges.createVerifier(
      challengeId,
      phoneLookup,
      code,
    );
    const expiresAt = new Date(
      now.getTime() + authenticationPolicy.codeTtlMs,
    );
    const reservation = withImmediateTransaction(
      this.options.database,
      () => {
        const sendDecision = this.rates.checkSend(
          phoneCandidates,
          ipCandidates,
          now,
        );
        if (!sendDecision.allowed) {
          return sendDecision;
        }
        this.options.database
          .prepare(
            `UPDATE sms_challenges
             SET status = 'superseded',
                 otp_verifier = NULL,
                 last_failed_code_verifier = NULL,
                 terminal_at = ?
             WHERE phone_lookup IN (${placeholders(phoneCandidates)})
               AND status IN ('active', 'pending')`,
          )
          .run(now.toISOString(), ...phoneCandidates);
        this.rates.recordSend("ip", ipCandidates[0]!, now);
        this.rates.recordSend("phone", phoneLookup, now);
        const cooldownEventId = this.rates.recordProviderCooldown(
          phoneLookup,
          now,
        );
        this.options.database
          .prepare(
            `INSERT INTO sms_challenges (
              id, phone_lookup, phone_ciphertext, phone_key_version,
              otp_verifier, otp_key_version, status, wrong_attempts,
              created_at, expires_at, terminal_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, NULL)`,
          )
          .run(
            challengeId,
            phoneLookup,
            phoneCiphertext,
            keyVersion(phoneCiphertext),
            verifier,
            keyVersion(verifier),
            now.toISOString(),
            expiresAt.toISOString(),
          );
        return {
          allowed: true as const,
          cooldownEventId,
        };
      },
    );
    if (!reservation.allowed) {
      throw new AuthFailure(
        "TOO_MANY_REQUESTS",
        429,
        reservation.retryAfterSeconds,
        { reason: reservation.reason },
      );
    }

    let delivery: SmsDeliveryOutcome;
    try {
      delivery = await this.challenges.send(phone, code, challengeId);
    } catch {
      delivery = { kind: "rejected", category: "configuration" };
    }
    if (delivery.kind === "rejected") {
      const rejectedAt = this.options.now();
      withImmediateTransaction(this.options.database, () => {
        this.options.database
          .prepare(
            `UPDATE sms_challenges
             SET status = 'provider_rejected',
                 otp_verifier = NULL,
                 last_failed_code_verifier = NULL,
                 terminal_at = ?
             WHERE id = ? AND status = 'pending'`,
          )
          .run(rejectedAt.toISOString(), challengeId);
        this.rates.clearEvent(reservation.cooldownEventId);
        this.rates.recordProviderCooldown(phoneLookup, rejectedAt);
      });
      this.safeAudit(
        "provider_rejected",
        input.requestId,
        rejectedAt,
        "rejected",
        undefined,
        undefined,
        ipCandidates[0],
      );
      throw new AuthFailure(
        "SMS_PROVIDER_UNAVAILABLE",
        503,
        authenticationPolicy.resendCooldownMs / 1_000,
      );
    }

    const acceptedAt = this.options.now();
    const activated = withImmediateTransaction(
      this.options.database,
      () => {
        const activation = this.options.database
          .prepare(
            `UPDATE sms_challenges
             SET status = 'active', expires_at = ?
             WHERE id = ? AND status = 'pending'`,
          )
          .run(
            new Date(
              acceptedAt.getTime() + authenticationPolicy.codeTtlMs,
            ).toISOString(),
            challengeId,
        );
        this.rates.clearEvent(reservation.cooldownEventId);
        return activation.changes === 1;
      },
    );
    if (!activated) {
      throw new AuthFailure(
        "SMS_PROVIDER_UNAVAILABLE",
        503,
        authenticationPolicy.resendCooldownMs / 1_000,
      );
    }
    this.safeAudit(
      "challenge_sent",
      input.requestId,
      acceptedAt,
      "accepted",
      undefined,
      undefined,
      ipCandidates[0],
    );
    return {
      outcome: "accepted",
      challengeId,
      expiresInSeconds:
        authenticationPolicy.codeTtlMs / 1_000,
      resendAfterSeconds:
        authenticationPolicy.resendCooldownMs / 1_000,
    };
  }

  async verifySms(input: {
    challengeId: string;
    verificationCode: string;
    inviteCode?: string;
    ipAddress: string;
    requestId: string;
  }): Promise<{
    accountCreated: boolean;
    account: { maskedPhone: string; loggedIn: true };
    session: SessionBundle;
  }> {
    const now = this.options.now();
    const ipCandidates = createIpLookupCandidates(
      input.ipAddress,
      this.options.keys.ipLookup,
    );
    const outcome = this.repository.immediate<VerifyOutcome>(() => {
      const challenge = this.options.database
        .prepare(
          `SELECT id, phone_lookup, phone_ciphertext, otp_verifier,
                  status, wrong_attempts, expires_at,
                  last_failed_code_verifier,
                  last_verification_attempt_at
           FROM sms_challenges
           WHERE id = ?`,
        )
        .get(input.challengeId) as ChallengeRow | undefined;
      if (challenge?.status === "locked") {
        let lockedPhoneCandidates: readonly string[];
        try {
          const lockedPhone = decryptPhone(
            challenge.phone_ciphertext,
            this.options.keys.phoneEncryption,
          );
          lockedPhoneCandidates = createPhoneLookupCandidates(
            lockedPhone,
            this.options.keys.phoneLookup,
          );
          if (!lockedPhoneCandidates.includes(challenge.phone_lookup)) {
            throw new Error("Challenge phone identity mismatch");
          }
        } catch {
          return {
            kind: "failure",
            code: "VERIFICATION_CODE_INVALID_OR_EXPIRED",
            reason: "invalid_or_expired",
          };
        }
        const lockedDecision = this.rates.checkVerify(
          lockedPhoneCandidates,
          now,
        );
        if (!lockedDecision.allowed) {
          return {
            kind: "limited",
            retryAfterSeconds: lockedDecision.retryAfterSeconds,
            reason: "verification_locked",
          };
        }
        return {
          kind: "failure",
          code: "VERIFICATION_CODE_INVALID_OR_EXPIRED",
          reason: "invalid_or_expired",
        };
      }
      if (
        challenge === undefined ||
        challenge.status !== "active" ||
        challenge.otp_verifier === null
      ) {
        return {
          kind: "failure",
          code: "VERIFICATION_CODE_INVALID_OR_EXPIRED",
          reason:
            challenge?.status === "expired"
              ? "expired"
              : challenge?.status === "exhausted"
                ? "exhausted"
                : "invalid_or_expired",
        };
      }
      if (Date.parse(challenge.expires_at) <= now.getTime()) {
        this.options.database
          .prepare(
            `UPDATE sms_challenges
             SET status = 'expired', otp_verifier = NULL,
                 last_failed_code_verifier = NULL, terminal_at = ?
             WHERE id = ?`,
          )
          .run(now.toISOString(), challenge.id);
        return {
          kind: "failure",
          code: "VERIFICATION_CODE_INVALID_OR_EXPIRED",
          reason: "expired",
        };
      }
      let phone: string;
      let phoneCandidates: readonly string[];
      try {
        phone = decryptPhone(
          challenge.phone_ciphertext,
          this.options.keys.phoneEncryption,
        );
        phoneCandidates = createPhoneLookupCandidates(
          phone,
          this.options.keys.phoneLookup,
        );
        if (!phoneCandidates.includes(challenge.phone_lookup)) {
          throw new Error("Challenge phone identity mismatch");
        }
      } catch {
        this.options.database
          .prepare(
            `UPDATE sms_challenges
             SET status = 'expired', otp_verifier = NULL,
                 last_failed_code_verifier = NULL, terminal_at = ?
             WHERE id = ?`,
          )
          .run(now.toISOString(), challenge.id);
        return {
          kind: "failure",
          code: "VERIFICATION_CODE_INVALID_OR_EXPIRED",
          reason: "invalid_or_expired",
        };
      }
      const canonicalPhoneLookup = phoneCandidates[0]!;
      const rateDecision = this.rates.checkVerify(
        phoneCandidates,
        now,
      );
      if (!rateDecision.allowed) {
        if (rateDecision.phoneLocked === true) {
          this.options.database
            .prepare(
              `UPDATE sms_challenges
               SET status = 'locked',
                   otp_verifier = NULL,
                   last_failed_code_verifier = NULL,
                   terminal_at = ?
               WHERE phone_lookup IN (${placeholders(phoneCandidates)})
                 AND status = 'active'`,
            )
            .run(now.toISOString(), ...phoneCandidates);
        } else {
          this.options.database
            .prepare(
              `UPDATE sms_challenges
               SET status = 'locked',
                   otp_verifier = NULL,
                   last_failed_code_verifier = NULL,
                   terminal_at = ?
               WHERE id = ?`,
            )
            .run(now.toISOString(), challenge.id);
        }
        return {
          kind: "limited",
          retryAfterSeconds: rateDecision.retryAfterSeconds,
          reason: "verification_locked",
        };
      }
      if (!verificationCodePattern.test(input.verificationCode)) {
        return {
          kind: "failure",
          code: "VERIFICATION_CODE_INVALID_OR_EXPIRED",
          reason: "invalid_or_expired",
        };
      }
      const lastAttemptAt = challenge.last_verification_attempt_at === null
        ? undefined
        : Date.parse(challenge.last_verification_attempt_at);
      if (
        lastAttemptAt !== undefined &&
        now.getTime() - lastAttemptAt <
          authenticationPolicy.verificationRetryIntervalMs
      ) {
        return {
          kind: "limited",
          retryAfterSeconds: Math.max(
            1,
            Math.ceil(
              (lastAttemptAt +
                authenticationPolicy.verificationRetryIntervalMs -
                now.getTime()) /
                1_000,
            ),
          ),
          reason: "verification_retry",
        };
      }
      this.options.database
        .prepare(
          `UPDATE sms_challenges
           SET last_verification_attempt_at = ?
           WHERE id = ?`,
        )
        .run(now.toISOString(), challenge.id);

      if (
        this.challenges.matchesVerifier(
          challenge.otp_verifier,
          challenge.id,
          challenge.phone_lookup,
          input.verificationCode,
        )
      ) {
        this.rates.recordVerificationSucceeded(canonicalPhoneLookup, now);
        this.options.database
          .prepare(
            `UPDATE sms_challenges
             SET status = 'consumed', otp_verifier = NULL,
                 last_failed_code_verifier = NULL, terminal_at = ?
             WHERE id = ? AND status = 'active'`,
          )
          .run(now.toISOString(), challenge.id);
        const installed = (() => {
          try {
            return this.verifiedPhoneInstaller.installWithinTransaction(
              phone,
              now,
            );
          } catch (error) {
            this.rethrowSessionFailure(error);
          }
        })();
        return {
          kind: "success",
          ...installed,
        };
      }

      if (
        challenge.last_failed_code_verifier !== null &&
        this.challenges.matchesVerifier(
          challenge.last_failed_code_verifier,
          challenge.id,
          challenge.phone_lookup,
          input.verificationCode,
        )
      ) {
        return {
          kind: "failure",
          code: "VERIFICATION_CODE_INVALID_OR_EXPIRED",
          reason: "incorrect",
          attemptsRemaining:
            authenticationPolicy.codeWrongAttempts -
            challenge.wrong_attempts,
        };
      }

      const wrongAttempts = challenge.wrong_attempts + 1;
      if (wrongAttempts >= authenticationPolicy.codeWrongAttempts) {
        this.options.database
          .prepare(
            `UPDATE sms_challenges
             SET status = 'exhausted', wrong_attempts = ?,
                 otp_verifier = NULL,
                 last_failed_code_verifier = NULL,
                 terminal_at = ?
             WHERE id = ? AND status = 'active'`,
          )
          .run(wrongAttempts, now.toISOString(), challenge.id);
        this.rates.recordChallengeExhausted(canonicalPhoneLookup, now);
        if (
          this.rates.countRecentExhaustions(phoneCandidates, now) >=
          authenticationPolicy.exhaustedChallengesPerWindow
        ) {
          const lockRetry = this.rates.lockPhone(canonicalPhoneLookup, now);
          this.options.database
            .prepare(
              `UPDATE sms_challenges
               SET status = 'locked', otp_verifier = NULL,
                   last_failed_code_verifier = NULL, terminal_at = ?
               WHERE phone_lookup IN (${placeholders(phoneCandidates)})
                 AND status = 'active'`,
            )
            .run(now.toISOString(), ...phoneCandidates);
          return {
            kind: "limited",
            retryAfterSeconds: lockRetry,
            reason: "verification_locked",
          };
        }
        return {
          kind: "failure",
          code: "VERIFICATION_CODE_INVALID_OR_EXPIRED",
          reason: "exhausted",
          attemptsRemaining: 0,
        };
      }

      const failedCodeVerifier = this.challenges.createVerifier(
        challenge.id,
        challenge.phone_lookup,
        input.verificationCode,
      );
      this.options.database
        .prepare(
          `UPDATE sms_challenges
           SET wrong_attempts = ?, last_failed_code_verifier = ?
           WHERE id = ?`,
        )
        .run(wrongAttempts, failedCodeVerifier, challenge.id);
      return {
        kind: "failure",
        code: "VERIFICATION_CODE_INVALID_OR_EXPIRED",
        reason: "incorrect",
        attemptsRemaining:
          authenticationPolicy.codeWrongAttempts - wrongAttempts,
      };
    });

    if (outcome.kind === "limited") {
      this.safeAudit(
        "verification_failed",
        input.requestId,
        now,
        "limited",
        undefined,
        undefined,
        ipCandidates[0],
      );
      throw new AuthFailure(
        "TOO_MANY_REQUESTS",
        429,
        outcome.retryAfterSeconds,
        {
          reason: outcome.reason,
        },
      );
    }
    if (outcome.kind === "failure") {
      this.safeAudit(
        "verification_failed",
        input.requestId,
        now,
        "invalid",
        undefined,
        undefined,
        ipCandidates[0],
      );
      throw new AuthFailure(outcome.code, 400, undefined, {
        reason: outcome.reason,
        ...(outcome.attemptsRemaining === undefined
          ? {}
          : { attemptsRemaining: outcome.attemptsRemaining }),
      });
    }

    this.safeAudit(
      "verification_succeeded",
      input.requestId,
      now,
      "success",
      outcome.user.id,
      outcome.session.access.sessionId,
      ipCandidates[0],
    );
    if (outcome.accountCreated) {
      this.safeAudit(
        "account_created",
        input.requestId,
        now,
        "created",
        outcome.user.id,
        outcome.session.access.sessionId,
        ipCandidates[0],
      );
    }
    for (const replacedSessionId of outcome.revokedSessionIds) {
      this.safeAudit(
        "session_replaced",
        input.requestId,
        now,
        "replaced",
        outcome.user.id,
        replacedSessionId,
        ipCandidates[0],
      );
    }
    await this.sessions.notifyRevoked(
      outcome.revokedSessionIds,
      "replaced",
    );
    this.attributeInviteBestEffort(
      outcome.user.id,
      input.inviteCode,
      now,
    );
    const phone = decryptPhone(
      outcome.user.phone_ciphertext,
      this.options.keys.phoneEncryption,
    );
    return {
      accountCreated: outcome.accountCreated,
      account: {
        maskedPhone: maskAuthenticatedPhone(phone),
        loggedIn: true,
      },
      session: outcome.session,
    };
  }

  async refresh(input: {
    refreshToken: string;
    refreshRequestId: string;
    ipAddress: string;
    requestId: string;
  }): Promise<{ session: SessionBundle }> {
    if (
      input.refreshToken.length === 0 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        input.refreshRequestId,
      )
    ) {
      throw new AuthFailure("INVALID_REQUEST", 400);
    }
    const ipLookup = createIpLookupCandidates(
      input.ipAddress,
      this.options.keys.ipLookup,
    )[0]!;
    try {
      return {
        session: await this.sessions.refresh(
          input.refreshToken,
          input.refreshRequestId,
          input.requestId,
          {
            ipLookup,
            ipKeyVersion: keyVersion(ipLookup),
          },
        ),
      };
    } catch (error) {
      this.rethrowSessionFailure(error);
    }
  }

  async authenticateAccessToken(accessToken: string): Promise<{
    accountId: string;
    sessionId: string;
    deviceId: string;
    account: { maskedPhone: string; loggedIn: true };
  }> {
    try {
      const identity = this.sessions.authenticate(accessToken);
      const phone = decryptPhone(
        identity.phoneCiphertext,
        this.options.keys.phoneEncryption,
      );
      return {
        accountId: identity.accountId,
        sessionId: identity.sessionId,
        deviceId: identity.deviceId,
        account: {
          maskedPhone: maskAuthenticatedPhone(phone),
          loggedIn: true,
        },
      };
    } catch (error) {
      this.rethrowSessionFailure(error);
    }
  }

  async logout(input: {
    accessToken: string;
    ipAddress: string;
    requestId: string;
  }): Promise<void> {
    const ipLookup = createIpLookupCandidates(
      input.ipAddress,
      this.options.keys.ipLookup,
    )[0]!;
    try {
      await this.sessions.logout(input.accessToken, input.requestId, {
        ipLookup,
        ipKeyVersion: keyVersion(ipLookup),
      });
    } catch (error) {
      this.rethrowSessionFailure(error);
    }
  }

  async disableAccount(input: {
    accountId: string;
    requestId: string;
  }): Promise<void> {
    await this.sessions.disableAccount(input.accountId, input.requestId);
  }

  async adminRevoke(input: {
    sessionId: string;
    requestId: string;
  }): Promise<void> {
    await this.sessions.adminRevoke(input.sessionId, input.requestId);
  }

  private rethrowSessionFailure(error: unknown): never {
    if (error instanceof SessionFailure) {
      throw new AuthFailure(
        error.code,
        error.statusCode,
      );
    }
    throw error;
  }

  private safeAudit(
    type: AuthAuditEventType,
    requestId: string,
    occurredAt: Date,
    outcome: Parameters<AuthAuditService["record"]>[0]["outcome"],
    accountId?: string,
    sessionId?: string,
    ipLookup?: string,
  ): void {
    try {
      this.audit.record({
        type,
        requestId,
        ...(accountId === undefined ? {} : { accountId }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(ipLookup === undefined
          ? {}
          : {
              ipLookup,
              ipKeyVersion: keyVersion(ipLookup),
            }),
        outcome,
        mockMode: this.challenges.mockMode,
        occurredAt,
      });
    } catch {
      // Authentication never depends on audit availability.
    }
  }

  private attributeInviteBestEffort(
    accountId: string,
    inviteCode: string | undefined,
    occurredAt: Date,
  ): void {
    if (inviteCode === undefined) {
      return;
    }
    const inviteLookup = createHash("sha256")
      .update("community-invite-attribution-v1\u0000")
      .update(inviteCode)
      .digest("hex");
    const attributionId = allocateInternalId(
      this.options.internalId ?? generateInternalId,
    );
    const locallyKnownResult: InviteAttributionResult =
      validInviteCode(inviteCode) ? "unavailable" : "invalid";
    try {
      this.options.database
        .prepare(
          `INSERT INTO invite_attributions (
            id, user_id, invite_lookup, attribution_result, created_at
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          attributionId,
          accountId,
          inviteLookup,
          locallyKnownResult,
          occurredAt.toISOString(),
        );
    } catch {
      // Authentication success is independent of invite persistence.
      return;
    }
    if (
      locallyKnownResult === "invalid" ||
      this.options.inviteAttributor === undefined
    ) {
      return;
    }
    void Promise.resolve()
      .then(() =>
        this.options.inviteAttributor!.attribute({
          accountId,
          inviteCode,
          occurredAt,
        }),
      )
      .then((result) => {
        if (
          !(
            [
              "attributed",
              "expired",
              "invalid",
              "unavailable",
            ] as const
          ).includes(result)
        ) {
          return;
        }
        this.options.database
          .prepare(
            `UPDATE invite_attributions
             SET attribution_result = ?
             WHERE id = ?`,
          )
          .run(result, attributionId);
      })
      .catch(() => {
        // Sync/async attribution and update failures remain unavailable.
      });
  }
}

export function createAuthenticationRuntime(
  options: AuthenticationRuntimeOptions,
): Readonly<{
  authService: AuthService;
  retentionService: AuthRetentionService;
  enrollmentService?: ClosedBetaEnrollmentService;
}> {
  if (
    options.environment === "production" &&
    options.codeMode === "closed_beta" &&
    options.configuredTestCodes === undefined
  ) {
    throw new Error(
      "Production closed-beta configured test codes are unavailable",
    );
  }
  const enrollmentConfigured =
    options.enrollmentVerificationKeys !== undefined ||
    options.configuredTestCodes !== undefined;
  if (options.codeMode === "closed_beta" && !enrollmentConfigured) {
    throw new Error(
      "Closed-beta enrollment verification is unavailable",
    );
  }
  const audit = new AuthAuditService(options.database, options.internalId);
  const sessions = new SessionService(
    options.database,
    new TokenService(
      options.keys.jwtSigning,
      options.keys.refreshRecovery,
    ),
    options.now,
    options.revocationSink,
    audit,
    options.codeMode === "mock",
    options.internalId,
  );
  const verifiedPhoneInstaller = new VerifiedPhoneSessionInstaller({
    database: options.database,
    phoneLookupKeys: options.keys.phoneLookup,
    phoneEncryptionKeys: options.keys.phoneEncryption,
    sessionService: sessions,
    ...(options.internalId === undefined
      ? {}
      : { internalId: options.internalId }),
  });
  const enrollmentService =
    !enrollmentConfigured
      ? undefined
      : new ClosedBetaEnrollmentService({
          database: options.database,
          phoneLookupKeys: options.keys.phoneLookup,
          ipLookupKeys: options.keys.ipLookup,
          ...(options.enrollmentVerificationKeys === undefined
            ? {}
            : {
                enrollmentVerificationKeys:
                  options.enrollmentVerificationKeys,
              }),
          ...(options.configuredTestCodes === undefined
            ? {}
            : { configuredTestCodes: options.configuredTestCodes }),
          now: options.now,
          installer: verifiedPhoneInstaller,
          sessions,
          codeRequestAudit: audit,
        });
  return Object.freeze({
    authService: new AuthService(
      options,
      sessions,
      verifiedPhoneInstaller,
    ),
    retentionService: new AuthRetentionService(options.database),
    ...(enrollmentService === undefined ? {} : { enrollmentService }),
  });
}
