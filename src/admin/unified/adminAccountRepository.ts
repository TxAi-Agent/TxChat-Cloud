import { timingSafeEqual } from "node:crypto";

import {
  type CoreDatabase,
  withImmediateTransaction,
} from "../../db/database.js";
import {
  generateInternalId,
  InternalIdAllocationError,
  type InternalIdGenerator,
  isInternalId,
} from "../../ids/internalId.js";
import { insertWithInternalId } from "../../ids/sqliteInternalId.js";
import { normalizeAdminUsername } from "./adminPassword.js";
import {
  ADMIN_MENU_CODES,
  type AdminAccountKind,
  type AdminAccountStatus,
  type AdminAuthenticationRecord,
  type AdminMenuCode,
  type AdminPasswordHash,
  type AdminSetupTokenPurpose,
  GRANTABLE_ADMIN_MENU_CODES,
  type IssuedAdminSetupToken,
  type SafeAdminAccount,
} from "./adminTypes.js";

export type AdminAccountErrorCode =
  | "ADMIN_INVALID_REQUEST"
  | "ADMIN_SETUP_REJECTED"
  | "ADMIN_USERNAME_UNAVAILABLE"
  | "ADMIN_ACCOUNT_NOT_FOUND"
  | "ADMIN_REVISION_CONFLICT"
  | "ADMIN_ACCESS_DENIED"
  | "ADMIN_SERVICE_UNAVAILABLE";

export class AdminAccountError extends Error {
  constructor(readonly code: AdminAccountErrorCode) {
    super(code);
    this.name = "AdminAccountError";
  }
}

type AccountRow = Readonly<{
  id: string;
  username: string;
  normalized_username: string;
  account_kind: AdminAccountKind;
  status: AdminAccountStatus;
  password_algorithm: "scrypt-v1";
  password_salt: Buffer;
  password_digest: Buffer;
  password_n: 32768;
  password_r: 8;
  password_p: 1;
  revision: number;
  password_revision: number;
  permission_revision: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}>;

type SetupTokenRow = Readonly<{
  id: string;
  purpose: AdminSetupTokenPurpose;
  admin_account_id: string | null;
  token_digest: Buffer;
  issued_by_admin_id: string | null;
  expires_at: string;
  consumed_at: string | null;
}>;

const SETUP_TTL_MS = 10 * 60_000;
const GRANTABLE = new Set<AdminMenuCode>(GRANTABLE_ADMIN_MENU_CODES);

function fail(code: AdminAccountErrorCode): never {
  throw new AdminAccountError(code);
}

function canonicalTimestamp(value: string): Readonly<{ iso: string; epochMs: number }> {
  if (typeof value !== "string" || !value.isWellFormed()) {
    fail("ADMIN_INVALID_REQUEST");
  }
  const parsed = new Date(value);
  const epochMs = parsed.getTime();
  if (!Number.isFinite(epochMs) || parsed.toISOString() !== value) {
    fail("ADMIN_INVALID_REQUEST");
  }
  return Object.freeze({ iso: value, epochMs });
}

function validateDigest(value: Buffer, setup = false): void {
  if (!Buffer.isBuffer(value) || value.length !== 32) {
    fail(setup ? "ADMIN_SETUP_REJECTED" : "ADMIN_INVALID_REQUEST");
  }
}

function validatePassword(value: AdminPasswordHash): void {
  if (
    value === null ||
    typeof value !== "object" ||
    value.algorithm !== "scrypt-v1" ||
    value.N !== 32_768 ||
    value.r !== 8 ||
    value.p !== 1 ||
    !Buffer.isBuffer(value.salt) ||
    value.salt.length !== 16 ||
    !Buffer.isBuffer(value.digest) ||
    value.digest.length !== 32
  ) {
    fail("ADMIN_INVALID_REQUEST");
  }
}

function validateRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("ADMIN_INVALID_REQUEST");
  }
}

function snapshotPermissions(values: readonly AdminMenuCode[]): AdminMenuCode[] {
  if (!Array.isArray(values)) fail("ADMIN_INVALID_REQUEST");
  const unique = new Set<AdminMenuCode>();
  for (const value of values) {
    if (!GRANTABLE.has(value)) {
      if (value === "accounts.list") fail("ADMIN_ACCESS_DENIED");
      fail("ADMIN_INVALID_REQUEST");
    }
    unique.add(value);
  }
  return [...unique].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

export class AdminAccountRepository {
  constructor(
    private readonly database: CoreDatabase,
    private readonly internalId: InternalIdGenerator = generateInternalId,
  ) {}

  issueSetupToken(input: Readonly<{
    purpose: AdminSetupTokenPurpose;
    digest: Buffer;
    now: string;
    expiresAt: string;
    adminAccountId?: string;
    issuedByAdminId?: string;
  }>): IssuedAdminSetupToken {
    return this.transaction(() => {
      const now = canonicalTimestamp(input.now);
      const expiresAt = canonicalTimestamp(input.expiresAt);
      validateDigest(input.digest, true);
      if (expiresAt.epochMs - now.epochMs !== SETUP_TTL_MS) {
        fail("ADMIN_SETUP_REJECTED");
      }
      const target = input.adminAccountId === undefined
        ? undefined
        : this.accountRow(input.adminAccountId);
      const issuer = input.issuedByAdminId === undefined
        ? undefined
        : this.requireSuperadmin(input.issuedByAdminId);
      if (input.purpose === "initial_superadmin") {
        if (target !== undefined || issuer !== undefined || this.superadmin() !== undefined) {
          fail("ADMIN_SETUP_REJECTED");
        }
      } else if (input.purpose === "reset_superadmin") {
        if (target?.account_kind !== "super_admin" || issuer !== undefined) {
          fail("ADMIN_SETUP_REJECTED");
        }
      } else if (input.purpose === "create_administrator") {
        if (target !== undefined || issuer === undefined) {
          fail("ADMIN_SETUP_REJECTED");
        }
      } else if (input.purpose === "reset_administrator") {
        if (
          target?.account_kind !== "administrator" ||
          target.status !== "active" ||
          issuer === undefined
        ) {
          fail("ADMIN_SETUP_REJECTED");
        }
      } else {
        fail("ADMIN_SETUP_REJECTED");
      }

      this.database.prepare(
        `UPDATE admin_account_setup_tokens
         SET consumed_at = ?
         WHERE purpose = ?
           AND COALESCE(admin_account_id, '') = COALESCE(?, '')
           AND consumed_at IS NULL`,
      ).run(now.iso, input.purpose, target?.id ?? null);
      let id: string;
      try {
        const statement = this.database.prepare(
          `INSERT INTO admin_account_setup_tokens (
            id, purpose, admin_account_id, token_digest, issued_by_admin_id,
            created_at, expires_at, consumed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT(id) DO NOTHING`,
        );
        id = insertWithInternalId({
          generate: this.internalId,
          insert: (candidate) => statement.run(
            candidate,
            input.purpose,
            target?.id ?? null,
            input.digest,
            issuer?.id ?? null,
            now.iso,
            expiresAt.iso,
          ).changes === 1,
        });
      } catch (error) {
        if (error instanceof InternalIdAllocationError) {
          fail("ADMIN_SERVICE_UNAVAILABLE");
        }
        fail("ADMIN_SETUP_REJECTED");
      }
      this.audit({
        now: now.iso,
        ...(issuer === undefined ? {} : { actor: issuer }),
        ...(target === undefined ? {} : { target }),
        action: input.purpose.startsWith("reset_")
          ? "password_reset_issued"
          : "setup_issued",
        ...(target === undefined ? {} : { targetRevision: target.revision }),
      });
      return Object.freeze({ id, purpose: input.purpose, expiresAt: expiresAt.iso });
    });
  }

  consumeInitialSuperadmin(input: Readonly<{
    tokenId: string;
    digest: Buffer;
    username: string;
    password: AdminPasswordHash;
    now: string;
  }>): SafeAdminAccount {
    return this.transaction(() => {
      const now = canonicalTimestamp(input.now);
      validatePassword(input.password);
      const token = this.consumeToken(
        input.tokenId,
        "initial_superadmin",
        input.digest,
        now,
      );
      if (
        token.admin_account_id !== null ||
        token.issued_by_admin_id !== null ||
        this.superadmin() !== undefined
      ) {
        fail("ADMIN_SETUP_REJECTED");
      }
      const username = this.username(input.username);
      const account = this.insertAccount({
        username: input.username,
        normalizedUsername: username,
        kind: "super_admin",
        password: input.password,
        now: now.iso,
      });
      this.database.prepare(
        `UPDATE admin_account_setup_tokens SET consumed_at = ?
         WHERE purpose = 'initial_superadmin' AND consumed_at IS NULL`,
      ).run(now.iso);
      this.audit({
        now: now.iso,
        target: account,
        action: "setup_consumed",
        targetRevision: account.revision,
      });
      return this.safe(account);
    });
  }

  consumeCreateAdministrator(input: Readonly<{
    tokenId: string;
    digest: Buffer;
    username: string;
    password: AdminPasswordHash;
    permissions: readonly AdminMenuCode[];
    now: string;
  }>): SafeAdminAccount {
    return this.transaction(() => {
      const now = canonicalTimestamp(input.now);
      validatePassword(input.password);
      const token = this.consumeToken(
        input.tokenId,
        "create_administrator",
        input.digest,
        now,
      );
      if (token.admin_account_id !== null || token.issued_by_admin_id === null) {
        fail("ADMIN_SETUP_REJECTED");
      }
      const actor = this.requireSuperadmin(token.issued_by_admin_id);
      const permissions = snapshotPermissions(input.permissions);
      const normalizedUsername = this.username(input.username);
      const account = this.insertAccount({
        username: input.username,
        normalizedUsername,
        kind: "administrator",
        password: input.password,
        now: now.iso,
      });
      this.insertPermissions(account.id, permissions, now.iso);
      this.audit({
        now: now.iso,
        actor,
        target: account,
        action: "account_created",
        targetRevision: account.revision,
      });
      return this.safe(this.accountRow(account.id)!);
    });
  }

  consumePasswordReset(input: Readonly<{
    tokenId: string;
    digest: Buffer;
    password: AdminPasswordHash;
    now: string;
  }>): SafeAdminAccount {
    return this.transaction(() => {
      const now = canonicalTimestamp(input.now);
      validatePassword(input.password);
      const token = this.token(input.tokenId);
      if (
        token === undefined ||
        (token.purpose !== "reset_superadmin" &&
          token.purpose !== "reset_administrator")
      ) {
        fail("ADMIN_SETUP_REJECTED");
      }
      this.assertConsumable(token, input.digest, now);
      if (token.admin_account_id === null) fail("ADMIN_SETUP_REJECTED");
      const target = this.accountRow(token.admin_account_id);
      if (
        target === undefined ||
        target.status !== "active" ||
        (token.purpose === "reset_superadmin"
          ? target.account_kind !== "super_admin" || token.issued_by_admin_id !== null
          : target.account_kind !== "administrator" || token.issued_by_admin_id === null)
      ) {
        fail("ADMIN_SETUP_REJECTED");
      }
      const actor = token.issued_by_admin_id === null
        ? undefined
        : this.requireSuperadmin(token.issued_by_admin_id);
      const updated = this.database.prepare(
        `UPDATE admin_accounts SET
          password_algorithm = ?, password_salt = ?, password_digest = ?,
          password_n = ?, password_r = ?, password_p = ?,
          revision = revision + 1,
          password_revision = password_revision + 1,
          updated_at = ?
         WHERE id = ? AND status = 'active' AND revision = ?`,
      ).run(
        input.password.algorithm,
        input.password.salt,
        input.password.digest,
        input.password.N,
        input.password.r,
        input.password.p,
        now.iso,
        target.id,
        target.revision,
      );
      if (updated.changes !== 1) fail("ADMIN_SETUP_REJECTED");
      this.markTokenConsumed(token.id, now.iso);
      this.database.prepare(
        `UPDATE admin_account_setup_tokens SET consumed_at = ?
         WHERE purpose = ? AND admin_account_id = ? AND consumed_at IS NULL`,
      ).run(now.iso, token.purpose, target.id);
      const result = this.accountRow(target.id)!;
      this.audit({
        now: now.iso,
        ...(actor === undefined ? {} : { actor }),
        target: result,
        action: "password_reset_consumed",
        targetRevision: result.revision,
      });
      return this.safe(result);
    });
  }

  replacePermissions(input: Readonly<{
    accountId: string;
    expectedRevision: number;
    permissions: readonly AdminMenuCode[];
    actorId: string;
    now: string;
  }>): SafeAdminAccount {
    return this.transaction(() => {
      const now = canonicalTimestamp(input.now);
      validateRevision(input.expectedRevision);
      const permissions = snapshotPermissions(input.permissions);
      const actor = this.requireSuperadmin(input.actorId);
      const target = this.accountRow(input.accountId);
      if (target === undefined || target.status !== "active") {
        fail("ADMIN_ACCOUNT_NOT_FOUND");
      }
      if (target.account_kind !== "administrator") fail("ADMIN_ACCESS_DENIED");
      if (target.revision !== input.expectedRevision) {
        fail("ADMIN_REVISION_CONFLICT");
      }
      this.database.prepare(
        "DELETE FROM admin_menu_permissions WHERE admin_account_id = ?",
      ).run(target.id);
      this.insertPermissions(target.id, permissions, now.iso);
      const updated = this.database.prepare(
        `UPDATE admin_accounts SET
           revision = revision + 1,
           permission_revision = permission_revision + 1,
           updated_at = ?
         WHERE id = ? AND revision = ? AND status = 'active'`,
      ).run(now.iso, target.id, input.expectedRevision);
      if (updated.changes !== 1) fail("ADMIN_REVISION_CONFLICT");
      const result = this.accountRow(target.id)!;
      this.audit({
        now: now.iso,
        actor,
        target: result,
        action: "permissions_changed",
        targetRevision: result.revision,
      });
      return this.safe(result);
    });
  }

  deleteOrdinary(input: Readonly<{
    accountId: string;
    expectedRevision: number;
    actorId: string;
    now: string;
  }>): void {
    this.transaction(() => {
      const now = canonicalTimestamp(input.now);
      validateRevision(input.expectedRevision);
      const actor = this.requireSuperadmin(input.actorId);
      const target = this.accountRow(input.accountId);
      if (target === undefined || target.status !== "active") {
        fail("ADMIN_ACCOUNT_NOT_FOUND");
      }
      if (target.account_kind !== "administrator") fail("ADMIN_ACCESS_DENIED");
      if (target.revision !== input.expectedRevision) {
        fail("ADMIN_REVISION_CONFLICT");
      }
      const updated = this.database.prepare(
        `UPDATE admin_accounts SET
           status = 'deleted', revision = revision + 1,
           updated_at = ?, deleted_at = ?
         WHERE id = ? AND revision = ? AND status = 'active'`,
      ).run(now.iso, now.iso, target.id, input.expectedRevision);
      if (updated.changes !== 1) fail("ADMIN_REVISION_CONFLICT");
      const result = this.accountRow(target.id)!;
      this.audit({
        now: now.iso,
        actor,
        target: result,
        action: "account_deleted",
        targetRevision: result.revision,
      });
    });
  }

  listActive(): readonly SafeAdminAccount[] {
    return Object.freeze((this.database.prepare(
      `SELECT * FROM admin_accounts
       WHERE status = 'active'
       ORDER BY normalized_username, id`,
    ).all() as AccountRow[]).map((row) => this.safe(row)));
  }

  activeById(id: string): SafeAdminAccount | null {
    const row = this.accountRow(id);
    return row === undefined || row.status !== "active" ? null : this.safe(row);
  }

  authenticationByUsername(username: string): AdminAuthenticationRecord | null {
    const normalized = normalizeAdminUsername(username);
    const row = this.database.prepare(
      `SELECT * FROM admin_accounts
       WHERE normalized_username = ? AND status = 'active'`,
    ).get(normalized) as AccountRow | undefined;
    if (row === undefined) return null;
    return Object.freeze({
      account: this.safe(row),
      password: Object.freeze({
        algorithm: row.password_algorithm,
        salt: Buffer.from(row.password_salt),
        digest: Buffer.from(row.password_digest),
        N: row.password_n,
        r: row.password_r,
        p: row.password_p,
      }),
    });
  }

  private transaction<T>(work: () => T): T {
    try {
      return withImmediateTransaction(this.database, work);
    } catch (error) {
      if (error instanceof AdminAccountError) throw error;
      return fail("ADMIN_SERVICE_UNAVAILABLE");
    }
  }

  private username(value: string): string {
    let normalized: string;
    try {
      normalized = normalizeAdminUsername(value);
    } catch {
      return fail("ADMIN_INVALID_REQUEST");
    }
    if (this.database.prepare(
      "SELECT 1 FROM admin_accounts WHERE normalized_username = ?",
    ).get(normalized) !== undefined) {
      fail("ADMIN_USERNAME_UNAVAILABLE");
    }
    return normalized;
  }

  private insertAccount(input: Readonly<{
    username: string;
    normalizedUsername: string;
    kind: AdminAccountKind;
    password: AdminPasswordHash;
    now: string;
  }>): AccountRow {
    let id: string;
    try {
      const statement = this.database.prepare(
        `INSERT INTO admin_accounts (
          id, username, normalized_username, account_kind, status,
          password_algorithm, password_salt, password_digest,
          password_n, password_r, password_p,
          revision, password_revision, permission_revision,
          created_at, updated_at, deleted_at
        ) VALUES (
          ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?, NULL
        )
        ON CONFLICT(id) DO NOTHING`,
      );
      id = insertWithInternalId({
        generate: this.internalId,
        insert: (candidate) => statement.run(
          candidate,
          input.username,
          input.normalizedUsername,
          input.kind,
          input.password.algorithm,
          input.password.salt,
          input.password.digest,
          input.password.N,
          input.password.r,
          input.password.p,
          input.now,
          input.now,
        ).changes === 1,
      });
    } catch (error) {
      if (this.database.prepare(
        "SELECT 1 FROM admin_accounts WHERE normalized_username = ?",
      ).get(input.normalizedUsername) !== undefined) {
        fail("ADMIN_USERNAME_UNAVAILABLE");
      }
      throw error;
    }
    return this.accountRow(id)!;
  }

  private insertPermissions(
    accountId: string,
    permissions: readonly AdminMenuCode[],
    now: string,
  ): void {
    const insert = this.database.prepare(
      `INSERT INTO admin_menu_permissions (
        id, admin_account_id, menu_code, created_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING`,
    );
    for (const permission of permissions) {
      insertWithInternalId({
        generate: this.internalId,
        insert: (candidate) =>
          insert.run(candidate, accountId, permission, now).changes === 1,
      });
    }
  }

  private permissions(account: AccountRow): readonly AdminMenuCode[] {
    if (account.account_kind === "super_admin") return ADMIN_MENU_CODES;
    return Object.freeze((this.database.prepare(
      `SELECT menu_code FROM admin_menu_permissions
       WHERE admin_account_id = ? ORDER BY menu_code`,
    ).pluck().all(account.id) as AdminMenuCode[]));
  }

  private safe(row: AccountRow): SafeAdminAccount {
    return Object.freeze({
      id: row.id,
      username: row.username,
      normalizedUsername: row.normalized_username,
      kind: row.account_kind,
      status: row.status,
      permissions: this.permissions(row),
      revision: row.revision,
      passwordRevision: row.password_revision,
      permissionRevision: row.permission_revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
    });
  }

  private accountRow(id: string): AccountRow | undefined {
    if (!isInternalId(id)) fail("ADMIN_INVALID_REQUEST");
    return this.database.prepare(
      "SELECT * FROM admin_accounts WHERE id = ?",
    ).get(id) as AccountRow | undefined;
  }

  private superadmin(): AccountRow | undefined {
    return this.database.prepare(
      "SELECT * FROM admin_accounts WHERE account_kind = 'super_admin'",
    ).get() as AccountRow | undefined;
  }

  private requireSuperadmin(id: string): AccountRow {
    const row = this.accountRow(id);
    if (
      row === undefined ||
      row.account_kind !== "super_admin" ||
      row.status !== "active"
    ) {
      fail("ADMIN_ACCESS_DENIED");
    }
    return row;
  }

  private token(id: string): SetupTokenRow | undefined {
    if (!isInternalId(id)) fail("ADMIN_SETUP_REJECTED");
    return this.database.prepare(
      "SELECT * FROM admin_account_setup_tokens WHERE id = ?",
    ).get(id) as SetupTokenRow | undefined;
  }

  private consumeToken(
    id: string,
    purpose: AdminSetupTokenPurpose,
    digest: Buffer,
    now: Readonly<{ iso: string; epochMs: number }>,
  ): SetupTokenRow {
    const token = this.token(id);
    if (token === undefined || token.purpose !== purpose) {
      fail("ADMIN_SETUP_REJECTED");
    }
    this.assertConsumable(token, digest, now);
    this.markTokenConsumed(id, now.iso);
    return token;
  }

  private assertConsumable(
    token: SetupTokenRow,
    digest: Buffer,
    now: Readonly<{ epochMs: number }>,
  ): void {
    validateDigest(digest, true);
    const stored = Buffer.from(token.token_digest);
    let matches = false;
    try {
      matches = timingSafeEqual(stored, digest);
    } finally {
      stored.fill(0);
    }
    if (
      !matches ||
      token.consumed_at !== null ||
      canonicalTimestamp(token.expires_at).epochMs <= now.epochMs
    ) {
      fail("ADMIN_SETUP_REJECTED");
    }
  }

  private markTokenConsumed(id: string, now: string): void {
    const result = this.database.prepare(
      `UPDATE admin_account_setup_tokens SET consumed_at = ?
       WHERE id = ? AND consumed_at IS NULL`,
    ).run(now, id);
    if (result.changes !== 1) fail("ADMIN_SETUP_REJECTED");
  }

  private audit(input: Readonly<{
    now: string;
    actor?: AccountRow;
    target?: AccountRow;
    action:
      | "setup_issued"
      | "setup_consumed"
      | "account_created"
      | "account_deleted"
      | "password_reset_issued"
      | "password_reset_consumed"
      | "permissions_changed";
    targetRevision?: number;
  }>): void {
    const statement = this.database.prepare(
      `INSERT INTO admin_audit_events (
        id, occurred_at, actor_admin_id, actor_username_snapshot,
        target_id, target_username_snapshot, request_ref,
        action_code, result_category, target_revision, request_correlation
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'accepted', ?, NULL)
      ON CONFLICT(id) DO NOTHING`,
    );
    insertWithInternalId({
      generate: this.internalId,
      insert: (candidate) => statement.run(
        candidate,
        input.now,
        input.actor?.id ?? null,
        input.actor?.username ?? null,
        input.target?.id ?? null,
        input.target?.username ?? null,
        input.action,
        input.targetRevision ?? null,
      ).changes === 1,
    });
  }
}
