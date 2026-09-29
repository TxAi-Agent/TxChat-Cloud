import { timingSafeEqual } from "node:crypto";

import {
  type CoreDatabase,
  withImmediateTransaction,
} from "../db/database.js";
import {
  generateInternalId,
  type InternalIdGenerator,
} from "../ids/internalId.js";
import { insertWithInternalId } from "../ids/sqliteInternalId.js";
import type {
  EncryptedSmsCredentials,
  SafeSmsConfiguration,
  SmsAdminAccount,
  SmsAdminAuditEvent,
  SmsAdminRateLimitEvent,
  SmsAdminRateLimitResult,
  SmsAdminRateLimitScope,
  SmsAdminTokenPurpose,
  SmsConfigurationCiphertext,
  SmsConfigurationLifecycle,
  SmsDraftTestOutcome,
} from "./smsAdminTypes.js";

export type SmsAdministrationErrorCode =
  | "ALREADY_INITIALIZED"
  | "NOT_INITIALIZED"
  | "REVISION_CONFLICT"
  | "INVALID_STATE"
  | "INVALID_REQUEST"
  | "PERSISTENCE_FAILED";

export class SmsAdministrationError extends Error {
  constructor(readonly code: SmsAdministrationErrorCode) {
    super(code);
    this.name = "SmsAdministrationError";
  }
}

type AccountRow = Readonly<{
  username: string;
  password_algorithm: "scrypt-v1";
  password_salt: Buffer;
  password_digest: Buffer;
  password_n: 32768;
  password_r: 8;
  password_p: 1;
  revision: number;
  created_at: string;
  updated_at: string;
}>;

type ConfigurationRow = Readonly<{
  id: string;
  supersedes_id?: string | null;
  revision: number;
  template_code: string;
  credential_key_version: string;
  credential_nonce: Buffer;
  credential_ciphertext: Buffer;
  credential_tag: Buffer;
  lifecycle: SmsConfigurationLifecycle;
  test_claim_id: string | null;
  test_claimed_at: string | null;
  last_test_outcome: SmsDraftTestOutcome | null;
  created_at: string;
  updated_at: string;
}>;

type TokenRow = Readonly<{
  token_digest: Buffer;
  expires_at: string;
}>;

export type CreateSmsAdminAccount = Readonly<{
  username: string;
  passwordAlgorithm: "scrypt-v1";
  passwordSalt: Buffer;
  passwordDigest: Buffer;
  passwordN: 32768;
  passwordR: 8;
  passwordP: 1;
  now: string;
}>;

export type ReplaceSmsAdminPassword = Readonly<{
  expectedRevision: number;
  passwordAlgorithm: "scrypt-v1";
  passwordSalt: Buffer;
  passwordDigest: Buffer;
  passwordN: 32768;
  passwordR: 8;
  passwordP: 1;
  now: string;
}>;

export type IssueSmsAdminToken = Readonly<{
  purpose: SmsAdminTokenPurpose;
  digest: Buffer;
  expiresAt: string;
  now: string;
}>;

export type ConsumeSmsAdminToken = Readonly<{
  id: string;
  purpose: SmsAdminTokenPurpose;
  digest: Buffer;
  now: string;
}>;

export type ReplaceSmsConfigurationDraft = Readonly<{
  id: string;
  expectedRevision: number | null;
  desiredRevision?: number;
  templateCode: string;
  encrypted: EncryptedSmsCredentials;
  now: string;
}>;

export type ClaimSmsDraftTest = Readonly<{
  expectedRevision: number;
  claimId: string;
  now: string;
}>;

export type ReleaseSmsDraftTest = Readonly<{
  expectedRevision: number;
  claimId: string;
  outcome: SmsDraftTestOutcome;
  now: string;
}>;

export type ActivateSmsDraft = Readonly<{
  expectedRevision: number;
  claimId: string;
  now: string;
}>;

export type SmsAdminRateLimitInput = Readonly<{
  scopeKind: SmsAdminRateLimitScope;
  subjectLookup: string;
  eventType: SmsAdminRateLimitEvent;
  windowStartedAt: string;
  now: string;
  limit: number;
  expiresAt?: string;
  record?: boolean;
}>;

export type SmsAdminAuditInput = Readonly<{
  eventType: SmsAdminAuditEvent;
  resultCategory: string;
  actorRef?: string;
  sessionRef?: string;
  configurationRevision?: number;
  now: string;
}>;

function fail(code: SmsAdministrationErrorCode): never {
  throw new SmsAdministrationError(code);
}

function external<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof SmsAdministrationError) throw error;
    return fail("PERSISTENCE_FAILED");
  }
}

function assertTimestamp(value: string): void {
  const match = typeof value === "string"
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value)
    : null;
  if (
    match === null ||
    !value.isWellFormed() ||
    Number.isNaN(Date.parse(value))
  ) {
    fail("INVALID_REQUEST");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  const leapYear =
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31, leapYear ? 29 : 28, 31, 30, 31, 30,
    31, 31, 30, 31, 30, 31,
  ];
  if (
    month < 1 || month > 12 || day < 1 ||
    day > daysInMonth[month - 1]! || hour > 23 || minute > 59 ||
    second > 59 || offsetHour > 23 || offsetMinute > 59
  ) {
    fail("INVALID_REQUEST");
  }
}

function assertReference(value: string): void {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    value.length < 1 ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail("INVALID_REQUEST");
  }
}

function assertRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) fail("INVALID_REQUEST");
}

function assertDigest(value: Buffer, length: number): void {
  if (!Buffer.isBuffer(value) || value.length !== length) {
    fail("INVALID_REQUEST");
  }
}

function assertEncrypted(value: EncryptedSmsCredentials): void {
  assertReference(value.keyVersion);
  assertDigest(value.nonce, 12);
  if (!Buffer.isBuffer(value.ciphertext) || value.ciphertext.length === 0) {
    fail("INVALID_REQUEST");
  }
  assertDigest(value.tag, 16);
}

function accountFrom(row: AccountRow): SmsAdminAccount {
  return Object.freeze({
    username: row.username,
    passwordAlgorithm: row.password_algorithm,
    passwordSalt: Buffer.from(row.password_salt),
    passwordDigest: Buffer.from(row.password_digest),
    passwordN: row.password_n,
    passwordR: row.password_r,
    passwordP: row.password_p,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function safeConfiguration(row: ConfigurationRow): SafeSmsConfiguration {
  return Object.freeze({
    id: row.id,
    revision: row.revision,
    templateCode: row.template_code,
    lifecycle: row.lifecycle,
    lastTestOutcome: row.last_test_outcome,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    credentialsConfigured: true as const,
  });
}

function ciphertext(row: ConfigurationRow): SmsConfigurationCiphertext {
  return Object.freeze({
    ...safeConfiguration(row),
    encrypted: Object.freeze({
      keyVersion: row.credential_key_version,
      nonce: Buffer.from(row.credential_nonce),
      ciphertext: Buffer.from(row.credential_ciphertext),
      tag: Buffer.from(row.credential_tag),
    }),
    claimId: row.test_claim_id,
    claimedAt: row.test_claimed_at,
  });
}

function assertPasswordMaterial(input: Readonly<{
  passwordAlgorithm: "scrypt-v1";
  passwordSalt: Buffer;
  passwordDigest: Buffer;
  passwordN: 32768;
  passwordR: 8;
  passwordP: 1;
}>): void {
  if (
    input.passwordAlgorithm !== "scrypt-v1" ||
    input.passwordN !== 32_768 ||
    input.passwordR !== 8 ||
    input.passwordP !== 1
  ) {
    fail("INVALID_REQUEST");
  }
  assertDigest(input.passwordSalt, 16);
  assertDigest(input.passwordDigest, 32);
}

export class SmsAdministrationRepository {
  readonly #phaseOne: boolean;

  constructor(
    private readonly database: CoreDatabase,
    private readonly internalId: InternalIdGenerator = generateInternalId,
  ) {
    const columns = database.prepare(
      "PRAGMA table_info(sms_service_configurations)",
    ).all() as Array<{ name: string }>;
    this.#phaseOne = columns.some((column) => column.name === "supersedes_id");
  }

  account(): SmsAdminAccount | null {
    return external(() => {
      const row = this.database.prepare(
        "SELECT * FROM sms_admin_account WHERE singleton_id = 1",
      ).get() as AccountRow | undefined;
      return row === undefined ? null : accountFrom(row);
    });
  }

  createAccount(input: CreateSmsAdminAccount): SmsAdminAccount {
    return external(() => withImmediateTransaction(this.database, () => {
      assertTimestamp(input.now);
      if (!/^[A-Za-z0-9._]{4,64}$/.test(input.username)) {
        fail("INVALID_REQUEST");
      }
      assertPasswordMaterial(input);
      if (this.account() !== null) fail("ALREADY_INITIALIZED");
      const result = this.database.prepare(
        `INSERT INTO sms_admin_account (
          singleton_id, username, password_algorithm, password_salt,
          password_digest, password_n, password_r, password_p,
          revision, created_at, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(
        input.username,
        input.passwordAlgorithm,
        input.passwordSalt,
        input.passwordDigest,
        input.passwordN,
        input.passwordR,
        input.passwordP,
        input.now,
        input.now,
      );
      if (result.changes !== 1) fail("PERSISTENCE_FAILED");
      return this.account()!;
    }));
  }

  replacePassword(input: ReplaceSmsAdminPassword): SmsAdminAccount {
    return external(() => withImmediateTransaction(this.database, () => {
      assertTimestamp(input.now);
      assertRevision(input.expectedRevision);
      assertPasswordMaterial(input);
      const result = this.database.prepare(
        `UPDATE sms_admin_account SET
          password_algorithm = ?, password_salt = ?, password_digest = ?,
          password_n = ?, password_r = ?, password_p = ?,
          revision = revision + 1, updated_at = ?
        WHERE singleton_id = 1 AND revision = ?`,
      ).run(
        input.passwordAlgorithm,
        input.passwordSalt,
        input.passwordDigest,
        input.passwordN,
        input.passwordR,
        input.passwordP,
        input.now,
        input.expectedRevision,
      );
      if (result.changes !== 1) {
        if (this.account() === null) fail("NOT_INITIALIZED");
        fail("REVISION_CONFLICT");
      }
      return this.account()!;
    }));
  }

  issueBootstrapToken(input: IssueSmsAdminToken): Readonly<{
    id: string;
    purpose: SmsAdminTokenPurpose;
    expiresAt: string;
  }> {
    return external(() => withImmediateTransaction(this.database, () => {
      assertTimestamp(input.now);
      assertTimestamp(input.expiresAt);
      assertDigest(input.digest, 32);
      if (
        (input.purpose !== "setup" && input.purpose !== "password_reset") ||
        Date.parse(input.expiresAt) <= Date.parse(input.now)
      ) {
        fail("INVALID_REQUEST");
      }
      this.database.prepare(
        `UPDATE sms_admin_bootstrap_tokens
         SET consumed_at = ? WHERE consumed_at IS NULL`,
      ).run(input.now);
      const statement = this.database.prepare(
        `INSERT INTO sms_admin_bootstrap_tokens (
          id, purpose, token_digest, expires_at, consumed_at, created_at
        ) VALUES (?, ?, ?, ?, NULL, ?)
        ON CONFLICT(id) DO NOTHING`,
      );
      const id = insertWithInternalId({
        generate: this.internalId,
        insert: (candidate) => statement.run(
          candidate,
          input.purpose,
          input.digest,
          input.expiresAt,
          input.now,
        ).changes === 1,
      });
      return Object.freeze({ id, purpose: input.purpose, expiresAt: input.expiresAt });
    }));
  }

  consumeBootstrapToken(input: ConsumeSmsAdminToken): boolean {
    return external(() => withImmediateTransaction(this.database, () => {
      assertTimestamp(input.now);
      assertReference(input.id);
      assertDigest(input.digest, 32);
      if (input.purpose !== "setup" && input.purpose !== "password_reset") {
        fail("INVALID_REQUEST");
      }
      const row = this.database.prepare(
        `SELECT token_digest, expires_at FROM sms_admin_bootstrap_tokens
         WHERE id = ? AND purpose = ? AND consumed_at IS NULL`,
      ).get(input.id, input.purpose) as TokenRow | undefined;
      if (row === undefined) return false;
      const stored = Buffer.from(row.token_digest);
      let matches = false;
      try {
        matches = timingSafeEqual(stored, input.digest);
      } finally {
        stored.fill(0);
      }
      if (!matches || Date.parse(row.expires_at) <= Date.parse(input.now)) {
        if (Date.parse(row.expires_at) <= Date.parse(input.now)) {
          this.database.prepare(
            `UPDATE sms_admin_bootstrap_tokens SET consumed_at = ?
             WHERE id = ? AND consumed_at IS NULL`,
          ).run(input.now, input.id);
        }
        return false;
      }
      const result = this.database.prepare(
        `UPDATE sms_admin_bootstrap_tokens SET consumed_at = ?
         WHERE id = ? AND purpose = ? AND consumed_at IS NULL`,
      ).run(input.now, input.id, input.purpose);
      return result.changes === 1;
    }));
  }

  safeDraft(): SafeSmsConfiguration | null {
    return external(() => {
      const row = this.configurationByLifecycle("draft");
      return row === undefined ? null : safeConfiguration(row);
    });
  }

  listSafe(): readonly SafeSmsConfiguration[] {
    return external(() => (this.database.prepare(
      `SELECT * FROM sms_service_configurations
       WHERE lifecycle <> 'transition' ORDER BY revision DESC`,
    ).all() as ConfigurationRow[]).map(safeConfiguration));
  }

  replaceDraft(input: ReplaceSmsConfigurationDraft): SafeSmsConfiguration {
    return external(() => withImmediateTransaction(this.database, () => {
      assertTimestamp(input.now);
      assertReference(input.id);
      if (!/^SMS_[0-9]{6,32}$/.test(input.templateCode)) {
        fail("INVALID_REQUEST");
      }
      assertEncrypted(input.encrypted);
      const current = this.configurationByLifecycle("draft");
      if (input.expectedRevision === null) {
        if (current !== undefined) fail("REVISION_CONFLICT");
      } else {
        assertRevision(input.expectedRevision);
        if (current === undefined || current.revision !== input.expectedRevision) {
          fail("REVISION_CONFLICT");
        }
      }
      const maximum = this.database.prepare(
        "SELECT COALESCE(MAX(revision), 0) AS revision FROM sms_service_configurations",
      ).get() as { revision: number };
      const computedRevision = maximum.revision + 1;
      if (
        input.desiredRevision !== undefined &&
        input.desiredRevision !== computedRevision
      ) {
        fail("REVISION_CONFLICT");
      }
      const revision = input.desiredRevision ?? computedRevision;
      if (!Number.isSafeInteger(revision)) fail("PERSISTENCE_FAILED");
      if (current !== undefined) {
        this.database.prepare(
          "DELETE FROM sms_service_configurations WHERE id = ? AND lifecycle = 'draft'",
        ).run(current.id);
      }
      if (this.#phaseOne) {
        const published = this.database.prepare(
          `SELECT id FROM sms_service_configurations
           WHERE lifecycle IN ('active', 'standby', 'retired')
           ORDER BY revision DESC LIMIT 1`,
        ).get() as { id: string } | undefined;
        this.database.prepare(
          `INSERT INTO sms_service_configurations (
            id, supersedes_id, revision, template_code, credential_key_version,
            credential_nonce, credential_ciphertext, credential_tag,
            lifecycle, test_claim_id, test_claimed_at, last_test_outcome,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', NULL, NULL, NULL, ?, ?)`,
        ).run(
          input.id, published?.id ?? null, revision, input.templateCode,
          input.encrypted.keyVersion, input.encrypted.nonce,
          input.encrypted.ciphertext, input.encrypted.tag, input.now, input.now,
        );
      } else this.database.prepare(
        `INSERT INTO sms_service_configurations (
          id, revision, template_code, credential_key_version,
          credential_nonce, credential_ciphertext, credential_tag,
          lifecycle, test_claim_id, test_claimed_at, last_test_outcome,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', NULL, NULL, NULL, ?, ?)`,
      ).run(
        input.id,
        revision,
        input.templateCode,
        input.encrypted.keyVersion,
        input.encrypted.nonce,
        input.encrypted.ciphertext,
        input.encrypted.tag,
        input.now,
        input.now,
      );
      return safeConfiguration(this.configurationByLifecycle("draft")!);
    }));
  }

  claimDraftTest(input: ClaimSmsDraftTest): SmsConfigurationCiphertext {
    return external(() => withImmediateTransaction(this.database, () => {
      assertTimestamp(input.now);
      assertRevision(input.expectedRevision);
      assertReference(input.claimId);
      const result = this.database.prepare(
        `UPDATE sms_service_configurations
         SET test_claim_id = ?, test_claimed_at = ?, updated_at = ?
         WHERE lifecycle = 'draft' AND revision = ?
           AND test_claim_id IS NULL`,
      ).run(input.claimId, input.now, input.now, input.expectedRevision);
      if (result.changes !== 1) this.failDraftMutation(input.expectedRevision);
      return ciphertext(this.configurationByClaim(input.claimId)!);
    }));
  }

  releaseDraftTest(input: ReleaseSmsDraftTest): void {
    external(() => withImmediateTransaction(this.database, () => {
      assertTimestamp(input.now);
      assertRevision(input.expectedRevision);
      assertReference(input.claimId);
      if (!["accepted", "rejected", "uncertain"].includes(input.outcome)) {
        fail("INVALID_REQUEST");
      }
      const result = this.database.prepare(
        `UPDATE sms_service_configurations SET
          test_claim_id = NULL, test_claimed_at = NULL,
          last_test_outcome = ?, updated_at = ?
         WHERE lifecycle = 'draft' AND revision = ? AND test_claim_id = ?`,
      ).run(input.outcome, input.now, input.expectedRevision, input.claimId);
      if (result.changes !== 1) this.failDraftMutation(input.expectedRevision);
    }));
  }

  activateClaimedDraft(input: ActivateSmsDraft): SafeSmsConfiguration {
    return external(() => withImmediateTransaction(this.database, () => {
      assertTimestamp(input.now);
      assertRevision(input.expectedRevision);
      assertReference(input.claimId);
      const target = this.configurationByClaim(input.claimId);
      if (target === undefined) fail("INVALID_STATE");
      if (target.revision !== input.expectedRevision) fail("REVISION_CONFLICT");
      if (this.#phaseOne) {
        this.releaseDraftTest({
          expectedRevision: input.expectedRevision,
          claimId: input.claimId,
          outcome: "accepted",
          now: input.now,
        });
        return this.activateTestedDraft({
          id: target.id,
          expectedRevision: input.expectedRevision,
          now: input.now,
        });
      }
      this.database.prepare(
        "DELETE FROM sms_service_configurations WHERE lifecycle = 'active'",
      ).run();
      const result = this.database.prepare(
        `UPDATE sms_service_configurations SET
          lifecycle = 'active', test_claim_id = NULL,
          test_claimed_at = NULL, last_test_outcome = 'accepted',
          updated_at = ?
         WHERE id = ? AND lifecycle = 'draft' AND revision = ?`,
      ).run(input.now, target.id, input.expectedRevision);
      if (result.changes !== 1) fail("INVALID_STATE");
      return safeConfiguration(this.configurationByLifecycle("active")!);
    }));
  }

  activateTestedDraft(input: Readonly<{
    id: string;
    expectedRevision: number;
    now: string;
  }>): SafeSmsConfiguration {
    return external(() => withImmediateTransaction(this.database, () => {
      assertTimestamp(input.now);
      assertReference(input.id);
      assertRevision(input.expectedRevision);
      const target = this.database.prepare(
        `SELECT * FROM sms_service_configurations WHERE id = ?`,
      ).get(input.id) as ConfigurationRow | undefined;
      if (target === undefined) fail("NOT_INITIALIZED");
      if (target.revision !== input.expectedRevision) fail("REVISION_CONFLICT");
      if (
        target.lifecycle !== "draft" || target.last_test_outcome !== "accepted" ||
        target.test_claim_id !== null
      ) fail("INVALID_STATE");
      if (!this.#phaseOne) {
        this.database.prepare(
          "DELETE FROM sms_service_configurations WHERE lifecycle = 'active'",
        ).run();
        const legacyResult = this.database.prepare(
          `UPDATE sms_service_configurations SET lifecycle = 'active', updated_at = ?
           WHERE id = ? AND lifecycle = 'draft' AND revision = ?`,
        ).run(input.now, input.id, input.expectedRevision);
        if (legacyResult.changes !== 1) fail("INVALID_STATE");
        return safeConfiguration(this.configurationByLifecycle("active")!);
      }
      this.database.prepare(
        "UPDATE sms_service_configurations SET lifecycle = 'retired', updated_at = ? WHERE lifecycle = 'standby'",
      ).run(input.now);
      this.database.prepare(
        "UPDATE sms_service_configurations SET lifecycle = 'standby', updated_at = ? WHERE lifecycle = 'active'",
      ).run(input.now);
      const result = this.database.prepare(
        `UPDATE sms_service_configurations SET lifecycle = 'active', updated_at = ?
         WHERE id = ? AND lifecycle = 'draft' AND revision = ?`,
      ).run(input.now, input.id, input.expectedRevision);
      if (result.changes !== 1) fail("INVALID_STATE");
      return safeConfiguration(this.configurationByLifecycle("active")!);
    }));
  }

  rollbackToStandby(now: string): SafeSmsConfiguration {
    return external(() => withImmediateTransaction(this.database, () => {
      if (!this.#phaseOne) fail("INVALID_STATE");
      assertTimestamp(now);
      const active = this.configurationByLifecycle("active");
      const standby = this.configurationByLifecycle("standby");
      if (active === undefined || standby === undefined) fail("INVALID_STATE");
      this.database.prepare(
        "UPDATE sms_service_configurations SET lifecycle = 'transition', updated_at = ? WHERE id = ?",
      ).run(now, active.id);
      this.database.prepare(
        "UPDATE sms_service_configurations SET lifecycle = 'active', updated_at = ? WHERE id = ?",
      ).run(now, standby.id);
      this.database.prepare(
        "UPDATE sms_service_configurations SET lifecycle = 'standby', updated_at = ? WHERE id = ?",
      ).run(now, active.id);
      return safeConfiguration(this.configurationByLifecycle("active")!);
    }));
  }

  activeCiphertext(): SmsConfigurationCiphertext | null {
    return external(() => {
      const row = this.configurationByLifecycle("active");
      return row === undefined ? null : ciphertext(row);
    });
  }

  draftCiphertext(): SmsConfigurationCiphertext | null {
    return external(() => {
      const row = this.configurationByLifecycle("draft");
      return row === undefined ? null : ciphertext(row);
    });
  }

  standbyCiphertext(): SmsConfigurationCiphertext | null {
    return external(() => {
      if (!this.#phaseOne) return null;
      const row = this.configurationByLifecycle("standby");
      return row === undefined ? null : ciphertext(row);
    });
  }

  rateLimit(input: SmsAdminRateLimitInput): SmsAdminRateLimitResult {
    return external(() => withImmediateTransaction(this.database, () => {
      assertTimestamp(input.windowStartedAt);
      assertTimestamp(input.now);
      if (input.expiresAt !== undefined) assertTimestamp(input.expiresAt);
      if (
        !["account", "ip", "account_ip", "test_phone", "administrator"].includes(input.scopeKind) ||
        !["login_failed", "login_succeeded", "test_attempt", "suspension"].includes(input.eventType) ||
        !/^[a-f0-9]{64}$/.test(input.subjectLookup) ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        (input.record !== undefined && typeof input.record !== "boolean") ||
        Date.parse(input.windowStartedAt) > Date.parse(input.now)
      ) {
        fail("INVALID_REQUEST");
      }
      const row = this.database.prepare(
        `SELECT COUNT(*) AS count FROM sms_admin_rate_limit_events
         WHERE scope_kind = ? AND subject_lookup = ? AND event_type = ?
           AND occurred_at >= ? AND occurred_at <= ?`,
      ).get(
        input.scopeKind,
        input.subjectLookup,
        input.eventType,
        input.windowStartedAt,
        input.now,
      ) as { count: number };
      if (row.count >= input.limit) {
        return Object.freeze({ allowed: false, count: row.count });
      }
      if (input.record === false) {
        return Object.freeze({ allowed: true, count: row.count });
      }
      const statement = this.database.prepare(
        `INSERT INTO sms_admin_rate_limit_events (
          id, scope_kind, subject_lookup, event_type, occurred_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING`,
      );
      insertWithInternalId({
        generate: this.internalId,
        insert: (candidate) => statement.run(
          candidate,
          input.scopeKind,
          input.subjectLookup,
          input.eventType,
          input.now,
          input.expiresAt ?? null,
        ).changes === 1,
      });
      return Object.freeze({ allowed: true, count: row.count + 1 });
    }));
  }

  audit(input: SmsAdminAuditInput): void {
    external(() => {
      assertTimestamp(input.now);
      if (
        !["initialized", "login", "logout", "password_changed", "password_reset", "draft_saved", "test_completed", "activated"].includes(input.eventType) ||
        !/^[A-Za-z0-9._-]{1,48}$/.test(input.resultCategory) ||
        (input.actorRef !== undefined && !/^[a-f0-9]{64}$/.test(input.actorRef)) ||
        (input.sessionRef !== undefined && !/^[a-f0-9]{64}$/.test(input.sessionRef)) ||
        (input.configurationRevision !== undefined &&
          (!Number.isSafeInteger(input.configurationRevision) || input.configurationRevision < 1))
      ) {
        fail("INVALID_REQUEST");
      }
      const statement = this.database.prepare(
        `INSERT INTO sms_admin_audit (
          id, event_type, result_category, actor_ref, session_ref,
          configuration_revision, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING`,
      );
      insertWithInternalId({
        generate: this.internalId,
        insert: (candidate) => statement.run(
          candidate,
          input.eventType,
          input.resultCategory,
          input.actorRef ?? null,
          input.sessionRef ?? null,
          input.configurationRevision ?? null,
          input.now,
        ).changes === 1,
      });
    });
  }

  private configurationByLifecycle(
    lifecycle: SmsConfigurationLifecycle,
  ): ConfigurationRow | undefined {
    return this.database.prepare(
      "SELECT * FROM sms_service_configurations WHERE lifecycle = ?",
    ).get(lifecycle) as ConfigurationRow | undefined;
  }

  private configurationByClaim(claimId: string): ConfigurationRow | undefined {
    return this.database.prepare(
      `SELECT * FROM sms_service_configurations
       WHERE lifecycle = 'draft' AND test_claim_id = ?`,
    ).get(claimId) as ConfigurationRow | undefined;
  }

  private failDraftMutation(expectedRevision: number): never {
    const current = this.configurationByLifecycle("draft");
    if (current === undefined || current.revision !== expectedRevision) {
      fail("REVISION_CONFLICT");
    }
    fail("INVALID_STATE");
  }
}
