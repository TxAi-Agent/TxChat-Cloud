import {
  createPhoneLookupCandidates,
  keyVersion,
  decryptPhone,
  normalizeMainlandChinaPhone,
  type VersionedKeyRing,
} from "../../auth/phoneIdentity.js";
import type {
  SessionRevocationSink,
} from "../../auth/sessionService.js";
import {
  type CoreDatabase,
  withImmediateTransaction,
} from "../../db/database.js";
import { BillingEntitlementRepository } from "../../billing/billingEntitlementRepository.js";
import { generateInternalId, isInternalId, type InternalIdGenerator } from "../../ids/internalId.js";
import type { AdminIdentity } from "./adminAuthorization.js";
import type { AdminAuditRepository } from "./adminAuditRepository.js";

const ID_PREFIX = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{1,32}$/u;
const MAX_RESULTS = 100;

export type UserAdminErrorCode =
  | "ADMIN_INVALID_REQUEST"
  | "ADMIN_USER_NOT_FOUND"
  | "ADMIN_REVISION_CONFLICT"
  | "ADMIN_SERVICE_UNAVAILABLE";

export class UserAdminError extends Error {
  constructor(readonly code: UserAdminErrorCode) {
    super(code);
    this.name = "UserAdminError";
  }
}

export type UserMembershipView = Readonly<{
  id: string;
  kind: "trial" | "monthly_membership";
  status: "active" | "exhausted";
  startsAt: string;
  endsAt: string | null;
  totalDurationMs: number;
  usedDurationMs: number;
  remainingDurationMs: number;
}>;

export type SafeAdminUser = Readonly<{
  id: string;
  phone: string;
  registeredAt: string;
  status: "enabled" | "disabled";
  revision: number;
  membership: UserMembershipView | null;
  orderCount: number;
}>;

type UserRow = Readonly<{
  id: string;
  phone_ciphertext: string;
  phone_key_version: string;
  status: "enabled" | "disabled";
  revision: number;
  created_at: string;
  order_count: number;
  entitlement_id: string | null;
  entitlement_kind: "trial" | "monthly_membership" | null;
  entitlement_status: "active" | "exhausted" | null;
  entitlement_starts_at: string | null;
  entitlement_ends_at: string | null;
  granted_duration_ms: number | null;
  remaining_duration_ms: number | null;
}>;

export type UserAdminSearch = Readonly<{
  phone?: string;
  idPrefix?: string;
  limit?: number;
  page?: number;
  status?: "enabled" | "disabled";
}>;

export type UserAdminMutation = Readonly<{
  id: string;
  expectedRevision: number;
  actor: AdminIdentity;
  requestId: string;
}>;

export type UserAdminServiceOptions = Readonly<{
  database: CoreDatabase;
  phoneLookupKeys: VersionedKeyRing;
  phoneEncryptionKeys: VersionedKeyRing;
  audit: AdminAuditRepository;
  revocationSink: SessionRevocationSink;
  internalId?: InternalIdGenerator;
  now?: () => Date;
}>;

function fail(code: UserAdminErrorCode): never {
  throw new UserAdminError(code);
}

function safeNow(source: () => Date): Readonly<{ date: Date; iso: string }> {
  let value: Date;
  try {
    value = source();
  } catch {
    return fail("ADMIN_SERVICE_UNAVAILABLE");
  }
  if (!(value instanceof Date)) fail("ADMIN_SERVICE_UNAVAILABLE");
  const epoch = Date.prototype.getTime.call(value);
  if (!Number.isFinite(epoch)) fail("ADMIN_SERVICE_UNAVAILABLE");
  const date = new Date(epoch);
  return Object.freeze({ date, iso: date.toISOString() });
}

function canonicalTimestamp(value: string): string {
  if (typeof value !== "string" || !value.isWellFormed()) {
    return fail("ADMIN_SERVICE_UNAVAILABLE");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    return fail("ADMIN_SERVICE_UNAVAILABLE");
  }
  return value;
}

function validateRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("ADMIN_INVALID_REQUEST");
  }
}

function validateMutation(input: UserAdminMutation): void {
  if (
    input === null ||
    typeof input !== "object" ||
    !isInternalId(input.id) ||
    typeof input.requestId !== "string" ||
    input.requestId.length < 1 ||
    input.requestId.length > 128
  ) {
    fail("ADMIN_INVALID_REQUEST");
  }
  validateRevision(input.expectedRevision);
}

function prefixUpperBound(prefix: string): string {
  const last = prefix.charCodeAt(prefix.length - 1);
  return `${prefix.slice(0, -1)}${String.fromCharCode(last + 1)}`;
}

function validateSearch(input: UserAdminSearch): Readonly<{
  phone?: string;
  idPrefix?: string;
  limit: number;
  page: number;
  status?: "enabled" | "disabled";
}> {
  if (
    input === null ||
    typeof input !== "object" ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null) ||
    Object.keys(input).some((key) => !["phone", "idPrefix", "limit", "page", "status"].includes(key))
  ) {
    fail("ADMIN_INVALID_REQUEST");
  }
  let phone: string | undefined;
  if (input.phone !== undefined) {
    try {
      phone = normalizeMainlandChinaPhone(
        typeof input.phone === "string" && /^1[3-9][0-9]{9}$/u.test(input.phone)
          ? `+86${input.phone}` : input.phone,
      );
    } catch {
      return fail("ADMIN_INVALID_REQUEST");
    }
  }
  let idPrefix: string | undefined;
  if (input.idPrefix !== undefined) {
    if (typeof input.idPrefix !== "string" || !ID_PREFIX.test(input.idPrefix)) fail("ADMIN_INVALID_REQUEST");
    idPrefix = input.idPrefix;
  }
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RESULTS) {
    fail("ADMIN_INVALID_REQUEST");
  }
  const page = input.page ?? 1;
  if (!Number.isSafeInteger(page) || page < 1 ||
      (input.status !== undefined && input.status !== "enabled" && input.status !== "disabled")) {
    fail("ADMIN_INVALID_REQUEST");
  }
  return Object.freeze({
    page,
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(phone === undefined ? {} : { phone }),
    ...(idPrefix === undefined ? {} : { idPrefix }),
    limit,
  });
}

export class UserAdminService {
  readonly #database: CoreDatabase;
  readonly #phoneLookupKeys: VersionedKeyRing;
  readonly #phoneEncryptionKeys: VersionedKeyRing;
  readonly #audit: AdminAuditRepository;
  readonly #revocationSink: SessionRevocationSink;
  readonly #internalId: InternalIdGenerator;
  readonly #now: () => Date;

  constructor(options: UserAdminServiceOptions) {
    if (
      options === null ||
      typeof options !== "object" ||
      typeof options.revocationSink?.revokeSession !== "function" ||
      (options.now !== undefined && typeof options.now !== "function")
    ) {
      throw new TypeError("Invalid unified user administration options");
    }
    this.#database = options.database;
    this.#phoneLookupKeys = options.phoneLookupKeys;
    this.#phoneEncryptionKeys = options.phoneEncryptionKeys;
    this.#audit = options.audit;
    this.#revocationSink = options.revocationSink;
    this.#internalId = options.internalId ?? generateInternalId;
    this.#now = options.now ?? (() => new Date());
  }

  search(input: UserAdminSearch = {}): readonly SafeAdminUser[] {
    const criteria = validateSearch(input);
    const current = safeNow(this.#now);
    const filter = this.searchFilter(criteria);
    const values: unknown[] = [current.iso, ...filter.values];
    values.push(criteria.limit);
    const rows = this.read(() => this.#database.prepare(
      `SELECT
         u.id, u.phone_ciphertext, u.phone_key_version, u.status,
         u.revision, u.created_at,
         (SELECT COUNT(*) FROM billing_orders AS orders
          WHERE orders.user_id = u.id) AS order_count,
         entitlement.id AS entitlement_id,
         entitlement.kind AS entitlement_kind,
         entitlement.status AS entitlement_status,
         entitlement.starts_at AS entitlement_starts_at,
         entitlement.ends_at AS entitlement_ends_at,
         entitlement.granted_duration_ms,
         entitlement.remaining_duration_ms
       FROM users AS u
       LEFT JOIN billing_entitlements AS entitlement
         ON entitlement.id = (
           SELECT candidate.id
           FROM billing_entitlements AS candidate
           WHERE candidate.user_id = u.id
             AND (
               (candidate.kind = 'monthly_membership'
                 AND candidate.status IN ('active', 'exhausted')
                 AND candidate.ends_at > ?)
               OR
               (candidate.kind = 'trial'
                 AND candidate.status IN ('active', 'exhausted'))
             )
           ORDER BY
             CASE candidate.kind WHEN 'monthly_membership' THEN 0 ELSE 1 END,
             candidate.created_at DESC,
             candidate.id DESC
           LIMIT 1
         )
       ${filter.clause}
       ORDER BY u.created_at DESC, u.id DESC
       LIMIT ?`,
    ).all(...values) as UserRow[]);
    return Object.freeze(rows.map((row) => this.safe(row)));
  }

  /** A snapshot of count + rows; no billing joins for the user list. */
  searchPage(input: UserAdminSearch = {}): Readonly<{
    users: readonly Pick<SafeAdminUser, "id" | "phone" | "registeredAt" | "status" | "revision">[];
    pagination: Readonly<{ page: number; pageSize: number; total: number; totalPages: number }>;
  }> {
    const criteria = validateSearch(input);
    const filter = this.searchFilter(criteria);
    return this.read(() => this.#database.transaction(() => {
      const count = this.#database.prepare(`SELECT COUNT(*) AS total FROM users AS u ${filter.clause}`)
        .get(...filter.values) as { total: number };
      if (!Number.isSafeInteger(count.total) || count.total < 0) fail("ADMIN_SERVICE_UNAVAILABLE");
      const totalPages = Math.max(1, Math.ceil(count.total / criteria.limit));
      const page = Math.min(criteria.page, totalPages);
      const records = this.#database.prepare(`SELECT u.id, u.phone_ciphertext, u.phone_key_version,
        u.status, u.revision, u.created_at FROM users AS u ${filter.clause}
        ORDER BY u.created_at DESC, u.id DESC LIMIT ? OFFSET ?`)
        .all(...filter.values, criteria.limit, (page - 1) * criteria.limit) as UserRow[];
      return Object.freeze({
        users: Object.freeze(records.map((row) => this.safeIdentity(row))),
        pagination: Object.freeze({ page, pageSize: criteria.limit, total: count.total, totalPages }),
      });
    })());
  }

  private searchFilter(criteria: ReturnType<typeof validateSearch>): { clause: string; values: unknown[] } {
    const where: string[] = [];
    const values: unknown[] = [];
    if (criteria.phone !== undefined) {
      let candidates: readonly string[];
      try {
        candidates = createPhoneLookupCandidates(
          criteria.phone,
          this.#phoneLookupKeys,
        );
      } catch {
        return fail("ADMIN_SERVICE_UNAVAILABLE");
      }
      where.push(`u.phone_lookup IN (${candidates.map(() => "?").join(", ")})`);
      values.push(...candidates);
    }
    if (criteria.idPrefix !== undefined) {
      if (criteria.idPrefix.length === 32) {
        where.push("u.id = ?");
        values.push(criteria.idPrefix);
      } else {
        where.push("u.id >= ? AND u.id < ?");
        values.push(criteria.idPrefix, prefixUpperBound(criteria.idPrefix));
      }
    }
    if (criteria.status !== undefined) {
      where.push("u.status = ?");
      values.push(criteria.status);
    }
    return { clause: where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`, values };
  }

  detail(id: string): SafeAdminUser {
    if (!isInternalId(id)) fail("ADMIN_INVALID_REQUEST");
    const users = this.search({ idPrefix: id, limit: 1 });
    if (users.length !== 1) fail("ADMIN_USER_NOT_FOUND");
    return users[0]!;
  }

  async disable(input: UserAdminMutation): Promise<SafeAdminUser> {
    validateMutation(input);
    const now = safeNow(this.#now);
    let revokedSessionIds: readonly string[] = [];
    const result = this.mutate(() => withImmediateTransaction(this.#database, () => {
      const current = this.accountState(input.id);
      if (current.revision !== input.expectedRevision) {
        fail("ADMIN_REVISION_CONFLICT");
      }
      if (current.status !== "enabled") fail("ADMIN_REVISION_CONFLICT");
      revokedSessionIds = (this.#database.prepare(
        `SELECT id FROM auth_sessions
         WHERE user_id = ? AND status = 'current'
         ORDER BY id`,
      ).all(input.id) as Array<{ id: string }>).map(({ id }) => id);
      this.#database.prepare(
        `UPDATE refresh_sessions
         SET status = 'revoked', revoked_at = ?, revoked_reason = 'disabled'
         WHERE user_id = ? AND status = 'current'`,
      ).run(now.iso, input.id);
      this.#database.prepare(
        `UPDATE auth_sessions
         SET status = 'revoked', updated_at = ?, revoked_at = ?,
             revoked_reason = 'disabled'
         WHERE user_id = ? AND status = 'current'`,
      ).run(now.iso, now.iso, input.id);
      const updated = this.#database.prepare(
        `UPDATE users
         SET status = 'disabled', current_session_id = NULL,
             revision = revision + 1, updated_at = ?
         WHERE id = ? AND status = 'enabled' AND revision = ?`,
      ).run(now.iso, input.id, input.expectedRevision);
      if (updated.changes !== 1) fail("ADMIN_REVISION_CONFLICT");
      this.#audit.record({
        occurredAt: now.iso,
        actorAdminId: input.actor.accountId,
        actorUsernameSnapshot: input.actor.username,
        targetId: input.id,
        requestRef: input.requestId,
        action: "user_disabled",
        result: "accepted",
        targetRevision: input.expectedRevision + 1,
      });
      return this.detail(input.id);
    }));
    try {
      for (const sessionId of revokedSessionIds) {
        await this.#revocationSink.revokeSession(sessionId, "disabled");
      }
    } catch {
      return fail("ADMIN_SERVICE_UNAVAILABLE");
    }
    return result;
  }

  restore(input: UserAdminMutation): SafeAdminUser {
    validateMutation(input);
    const now = safeNow(this.#now);
    return this.mutate(() => withImmediateTransaction(this.#database, () => {
      const current = this.accountState(input.id);
      if (current.revision !== input.expectedRevision) {
        fail("ADMIN_REVISION_CONFLICT");
      }
      if (current.status !== "disabled") fail("ADMIN_REVISION_CONFLICT");
      const updated = this.#database.prepare(
        `UPDATE users
         SET status = 'enabled', revision = revision + 1, updated_at = ?
         WHERE id = ? AND status = 'disabled' AND revision = ?`,
      ).run(now.iso, input.id, input.expectedRevision);
      if (updated.changes !== 1) fail("ADMIN_REVISION_CONFLICT");
      this.#audit.record({
        occurredAt: now.iso,
        actorAdminId: input.actor.accountId,
        actorUsernameSnapshot: input.actor.username,
        targetId: input.id,
        requestRef: input.requestId,
        action: "user_restored",
        result: "accepted",
        targetRevision: input.expectedRevision + 1,
      });
      return this.detail(input.id);
    }));
  }

  regrantTrial(input: UserAdminMutation): SafeAdminUser {
    validateMutation(input);
    if (input.actor.kind !== "super_admin") fail("ADMIN_INVALID_REQUEST");
    const now = safeNow(this.#now);
    return this.mutate(() => withImmediateTransaction(this.#database, () => {
      const replay = this.#database.prepare(
        `SELECT user_id, actor_admin_id, entitlement_id
         FROM admin_trial_regrant_events WHERE request_ref = ?`,
      ).get(input.requestId) as Readonly<{
        user_id: string;
        actor_admin_id: string;
        entitlement_id: string;
      }> | undefined;
      if (replay !== undefined) {
        if (replay.user_id !== input.id || replay.actor_admin_id !== input.actor.accountId ||
            !isInternalId(replay.entitlement_id)) fail("ADMIN_INVALID_REQUEST");
        return this.detail(input.id);
      }

      const current = this.accountState(input.id);
      if (current.revision !== input.expectedRevision || current.status !== "enabled") {
        fail("ADMIN_REVISION_CONFLICT");
      }
      const membership = this.#database.prepare(
        `SELECT 1 FROM billing_entitlements
         WHERE user_id = ? AND kind = 'monthly_membership'
           AND status IN ('active', 'exhausted') LIMIT 1`,
      ).get(input.id);
      if (membership === undefined) fail("ADMIN_REVISION_CONFLICT");

      const entitlement = new BillingEntitlementRepository(
        this.#database,
        { now: () => new Date(now.date) },
        this.#internalId,
      ).regrantTrial(input.id, now.date);
      const updated = this.#database.prepare(
        `UPDATE users SET revision = revision + 1, updated_at = ?
         WHERE id = ? AND status = 'enabled' AND revision = ?`,
      ).run(now.iso, input.id, input.expectedRevision);
      if (updated.changes !== 1) fail("ADMIN_REVISION_CONFLICT");
      this.#database.prepare(
        `INSERT INTO admin_trial_regrant_events (
          request_ref, user_id, actor_admin_id, actor_username_snapshot,
          entitlement_id, target_revision, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.requestId,
        input.id,
        input.actor.accountId,
        input.actor.username,
        entitlement.entitlementId,
        input.expectedRevision + 1,
        now.iso,
      );
      return this.detail(input.id);
    }));
  }

  private accountState(id: string): Readonly<{
    status: "enabled" | "disabled";
    revision: number;
  }> {
    const row = this.#database.prepare(
      "SELECT status, revision FROM users WHERE id = ?",
    ).get(id) as { status: "enabled" | "disabled"; revision: number } | undefined;
    if (row === undefined) fail("ADMIN_USER_NOT_FOUND");
    if (
      (row.status !== "enabled" && row.status !== "disabled") ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1
    ) fail("ADMIN_SERVICE_UNAVAILABLE");
    return Object.freeze({ status: row.status, revision: row.revision });
  }

  private safeIdentity(row: UserRow): Pick<SafeAdminUser, "id" | "phone" | "registeredAt" | "status" | "revision"> {
    if (
      !isInternalId(row.id) ||
      (row.status !== "enabled" && row.status !== "disabled") ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1 ||
      keyVersion(row.phone_ciphertext) !== row.phone_key_version
    ) fail("ADMIN_SERVICE_UNAVAILABLE");
    let phone: string;
    try {
      phone = decryptPhone(row.phone_ciphertext, this.#phoneEncryptionKeys);
    } catch {
      return fail("ADMIN_SERVICE_UNAVAILABLE");
    }
    return Object.freeze({ id: row.id, phone, registeredAt: canonicalTimestamp(row.created_at),
      status: row.status, revision: row.revision });
  }

  private safe(row: UserRow): SafeAdminUser {
    const identity = this.safeIdentity(row);
    if (!Number.isSafeInteger(row.order_count) || row.order_count < 0) fail("ADMIN_SERVICE_UNAVAILABLE");
    let membership: UserMembershipView | null = null;
    if (row.entitlement_id !== null) {
      if (
        !isInternalId(row.entitlement_id) ||
        (row.entitlement_kind !== "trial" &&
          row.entitlement_kind !== "monthly_membership") ||
        (row.entitlement_status !== "active" && row.entitlement_status !== "exhausted") ||
        row.entitlement_starts_at === null ||
        row.granted_duration_ms === null ||
        row.remaining_duration_ms === null ||
        !Number.isSafeInteger(row.granted_duration_ms) ||
        !Number.isSafeInteger(row.remaining_duration_ms) ||
        row.granted_duration_ms <= 0 ||
        row.remaining_duration_ms < 0 ||
        row.remaining_duration_ms > row.granted_duration_ms
      ) fail("ADMIN_SERVICE_UNAVAILABLE");
      const startsAt = canonicalTimestamp(row.entitlement_starts_at);
      const endsAt = row.entitlement_ends_at === null
        ? null
        : canonicalTimestamp(row.entitlement_ends_at);
      membership = Object.freeze({
        id: row.entitlement_id,
        kind: row.entitlement_kind,
        status: row.entitlement_status,
        startsAt,
        endsAt,
        totalDurationMs: row.granted_duration_ms,
        usedDurationMs: row.granted_duration_ms - row.remaining_duration_ms,
        remainingDurationMs: row.remaining_duration_ms,
      });
    }
    return Object.freeze({
      ...identity,
      membership,
      orderCount: row.order_count,
    });
  }

  private read<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      if (error instanceof UserAdminError) throw error;
      return fail("ADMIN_SERVICE_UNAVAILABLE");
    }
  }

  private mutate<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      if (error instanceof UserAdminError) throw error;
      return fail("ADMIN_SERVICE_UNAVAILABLE");
    }
  }
}
