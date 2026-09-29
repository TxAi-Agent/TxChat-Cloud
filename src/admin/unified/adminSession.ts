import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { isInternalId } from "../../ids/internalId.js";
import {
  authorizedMenus,
  type AdminIdentity,
} from "./adminAuthorization.js";
import { normalizeAdminUsername } from "./adminPassword.js";
import type { SafeAdminAccount } from "./adminTypes.js";

export const ADMIN_SESSION_IDLE_MS = 30 * 60_000;
export const ADMIN_SESSION_ABSOLUTE_MS = 8 * 60 * 60_000;
export const ADMIN_SESSION_LIMIT = 64;
export const ADMIN_SESSION_COOKIE = "txchat_admin_session";
export const ADMIN_CSRF_HEADER = "x-txchat-admin-csrf";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const MAX_COOKIE_HEADER_BYTES = 8_192;
const mutationBrand = Symbol("AdminMutationProof");

export type AdminSessionFailureCode =
  | "ADMIN_AUTH_REQUIRED"
  | "ADMIN_CSRF_REJECTED"
  | "ADMIN_SERVICE_UNAVAILABLE";

const FAILURE_STATUS = Object.freeze({
  ADMIN_AUTH_REQUIRED: 401,
  ADMIN_CSRF_REJECTED: 403,
  ADMIN_SERVICE_UNAVAILABLE: 503,
} as const);

export class AdminSessionFailure extends Error {
  readonly statusCode: 401 | 403 | 503;

  constructor(readonly code: AdminSessionFailureCode) {
    super(code);
    this.name = "AdminSessionFailure";
    this.statusCode = FAILURE_STATUS[code];
  }
}

export type AdminSessionLogin = Readonly<{
  cookie: string;
  csrfToken: string;
  identity: AdminIdentity;
}>;

export type AdminMutationBoundary = Readonly<{
  cookie: string;
  csrfToken: string;
  host: string;
  origin: string;
}>;

export type AdminMutationProof = Readonly<{
  [mutationBrand]: true;
  sessionKey: string;
  csrfVersion: number;
  identity: AdminIdentity;
}>;

export type AdminSameOriginBoundary = Readonly<{
  cookie: string;
  host: string;
  origin: string;
}>;

type SessionRecord = {
  sessionDigest: Buffer;
  csrfDigest: Buffer;
  csrfVersion: number;
  mutationInFlight: boolean;
  identity: AdminIdentity;
  createdAt: number;
  lastSeenAt: number;
};

type Secret = Readonly<{
  material: string;
  digest: Buffer;
}>;

function fail(code: AdminSessionFailureCode): never {
  throw new AdminSessionFailure(code);
}

function same(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function parseSecret(value: string, code: AdminSessionFailureCode): Buffer {
  if (
    typeof value !== "string" ||
    !TOKEN_PATTERN.test(value)
  ) {
    fail(code);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== value) {
    decoded.fill(0);
    fail(code);
  }
  return decoded;
}

function cookieToken(header: string): string {
  if (
    typeof header !== "string" ||
    Buffer.byteLength(header, "utf8") > MAX_COOKIE_HEADER_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(header)
  ) {
    fail("ADMIN_AUTH_REQUIRED");
  }
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${ADMIN_SESSION_COOKIE}=`))
    .map((part) => part.slice(ADMIN_SESSION_COOKIE.length + 1));
  if (values.length !== 1 || !TOKEN_PATTERN.test(values[0]!)) {
    fail("ADMIN_AUTH_REQUIRED");
  }
  return values[0]!;
}

function identityFromAccount(account: SafeAdminAccount): AdminIdentity {
  if (
    account === null ||
    typeof account !== "object" ||
    !isInternalId(account.id) ||
    account.status !== "active" ||
    !Number.isSafeInteger(account.revision) ||
    account.revision < 1 ||
    !Number.isSafeInteger(account.passwordRevision) ||
    account.passwordRevision < 1 ||
    !Number.isSafeInteger(account.permissionRevision) ||
    account.permissionRevision < 1
  ) {
    fail("ADMIN_SERVICE_UNAVAILABLE");
  }
  let normalized: string;
  try {
    normalized = normalizeAdminUsername(account.username);
  } catch {
    return fail("ADMIN_SERVICE_UNAVAILABLE");
  }
  if (normalized !== account.normalizedUsername) {
    fail("ADMIN_SERVICE_UNAVAILABLE");
  }
  const candidate: AdminIdentity = Object.freeze({
    accountId: account.id,
    username: account.username,
    kind: account.kind,
    menus: Object.freeze([...account.permissions]),
    accountRevision: account.revision,
    passwordRevision: account.passwordRevision,
    permissionRevision: account.permissionRevision,
  });
  let menus: readonly AdminIdentity["menus"][number][];
  try {
    menus = authorizedMenus(candidate);
  } catch {
    return fail("ADMIN_SERVICE_UNAVAILABLE");
  }
  return Object.freeze({ ...candidate, menus });
}

export class AdminSessionStore {
  readonly #origin: string;
  readonly #host: string;
  readonly #now: () => number;
  readonly #randomBytes: (length: number) => Buffer;
  readonly #accountById: (id: string) => SafeAdminAccount | null;
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #proofs = new WeakSet<object>();
  #latestTime = Number.NEGATIVE_INFINITY;
  #disposed = false;

  constructor(options: Readonly<{
    origin: string;
    accountById: (id: string) => SafeAdminAccount | null;
    now?: () => number;
    randomBytes?: (length: number) => Buffer;
  }>) {
    if (
      options === null ||
      typeof options !== "object" ||
      typeof options.origin !== "string" ||
      typeof options.accountById !== "function" ||
      (options.now !== undefined && typeof options.now !== "function") ||
      (options.randomBytes !== undefined && typeof options.randomBytes !== "function")
    ) {
      throw new TypeError("Invalid unified administrator session options");
    }
    let origin: URL;
    try {
      origin = new URL(options.origin);
    } catch {
      throw new TypeError("Invalid unified administrator session options");
    }
    if (
      origin.origin !== options.origin ||
      (origin.protocol !== "https:" &&
        !(origin.protocol === "http:" && origin.hostname === "localhost"))
    ) {
      throw new TypeError("Invalid unified administrator session options");
    }
    this.#origin = origin.origin;
    this.#host = origin.host;
    this.#now = options.now ?? Date.now;
    this.#randomBytes = options.randomBytes ?? randomBytes;
    this.#accountById = options.accountById;
    this.#readTime(false);
  }

  get activeCount(): number {
    return this.#sessions.size;
  }

  login(account: SafeAdminAccount): AdminSessionLogin {
    this.#assertAvailable();
    const time = this.#readTime(false);
    this.#prune(time);
    if (this.#sessions.size >= ADMIN_SESSION_LIMIT) {
      fail("ADMIN_SERVICE_UNAVAILABLE");
    }
    const identity = identityFromAccount(account);
    const session = this.#uniqueSessionSecret();
    let csrf: Secret | undefined;
    try {
      csrf = this.#secret();
      const key = session.digest.toString("hex");
      this.#sessions.set(key, {
        sessionDigest: Buffer.from(session.digest),
        csrfDigest: Buffer.from(csrf.digest),
        csrfVersion: 1,
        mutationInFlight: false,
        identity,
        createdAt: time,
        lastSeenAt: time,
      });
      return Object.freeze({
        cookie: `${ADMIN_SESSION_COOKIE}=${session.material}; Path=/console; Secure; HttpOnly; SameSite=Strict`,
        csrfToken: csrf.material,
        identity,
      });
    } finally {
      session.digest.fill(0);
      csrf?.digest.fill(0);
    }
  }

  authenticate(cookie: string): AdminIdentity {
    this.#assertAvailable();
    const time = this.#readTime(true);
    const { record } = this.#session(cookie, time);
    record.lastSeenAt = time;
    return record.identity;
  }

  issueCsrf(input: AdminSameOriginBoundary): Readonly<{ csrfToken: string }> {
    this.#assertAvailable();
    if (
      input === null ||
      typeof input !== "object" ||
      input.origin !== this.#origin ||
      input.host !== this.#host
    ) {
      fail("ADMIN_CSRF_REJECTED");
    }
    const time = this.#readTime(true);
    const { key, record } = this.#session(input.cookie, time);
    if (record.mutationInFlight) {
      fail("ADMIN_CSRF_REJECTED");
    }
    let next: Secret;
    try {
      next = this.#secret();
    } catch (error) {
      this.#deleteSession(key, record);
      throw error;
    }
    record.csrfDigest.fill(0);
    record.csrfDigest = Buffer.from(next.digest);
    record.csrfVersion += 1;
    record.lastSeenAt = time;
    const csrfToken = next.material;
    next.digest.fill(0);
    return Object.freeze({ csrfToken });
  }

  revokeIssuedSession(cookie: string): void {
    this.#assertAvailable();
    const token = cookieToken(cookie);
    const source = parseSecret(token, "ADMIN_AUTH_REQUIRED");
    let digest: Buffer | undefined;
    try {
      digest = createHash("sha256").update(source).digest();
      const key = digest.toString("hex");
      const record = this.#sessions.get(key);
      if (record !== undefined && same(record.sessionDigest, digest)) {
        this.#deleteSession(key, record);
      }
    } finally {
      source.fill(0);
      digest?.fill(0);
    }
  }

  revokeStaleAccountSessions(account: SafeAdminAccount): void {
    this.#assertAvailable();
    const identity = identityFromAccount(account);
    for (const [key, record] of this.#sessions) {
      if (
        record.identity.accountId === identity.accountId &&
        (record.identity.accountRevision !== identity.accountRevision ||
          record.identity.passwordRevision !== identity.passwordRevision)
      ) {
        this.#deleteSession(key, record);
      }
    }
  }

  authorizeMutation(input: AdminMutationBoundary): AdminMutationProof {
    this.#assertAvailable();
    if (
      input === null ||
      typeof input !== "object" ||
      input.origin !== this.#origin ||
      input.host !== this.#host
    ) {
      fail("ADMIN_CSRF_REJECTED");
    }
    const time = this.#readTime(true);
    const { key, record } = this.#session(input.cookie, time);
    if (record.mutationInFlight) {
      fail("ADMIN_CSRF_REJECTED");
    }
    const supplied = parseSecret(input.csrfToken, "ADMIN_CSRF_REJECTED");
    let digest: Buffer | undefined;
    try {
      digest = createHash("sha256").update(supplied).digest();
      if (!same(record.csrfDigest, digest)) {
        fail("ADMIN_CSRF_REJECTED");
      }
    } finally {
      supplied.fill(0);
      digest?.fill(0);
    }
    record.lastSeenAt = time;
    record.mutationInFlight = true;
    const proof = Object.freeze({
      [mutationBrand]: true as const,
      sessionKey: key,
      csrfVersion: record.csrfVersion,
      identity: record.identity,
    });
    this.#proofs.add(proof);
    return proof;
  }

  commitMutation(proof: AdminMutationProof): Readonly<{ csrfToken: string }> {
    this.#assertProof(proof);
    const time = this.#readTime(true);
    const record = this.#sessions.get(proof.sessionKey);
    if (record === undefined) {
      this.#consumeProof(proof);
      fail("ADMIN_AUTH_REQUIRED");
    }
    this.#assertLiveAccount(proof.sessionKey, record, time);
    if (
      record.csrfVersion !== proof.csrfVersion ||
      !record.mutationInFlight
    ) {
      this.#consumeProof(proof);
      fail("ADMIN_CSRF_REJECTED");
    }
    let next: Secret;
    try {
      next = this.#secret();
    } catch (error) {
      this.#deleteSession(proof.sessionKey, record);
      this.#consumeProof(proof);
      throw error;
    }
    record.csrfDigest.fill(0);
    record.csrfDigest = Buffer.from(next.digest);
    record.csrfVersion += 1;
    record.mutationInFlight = false;
    record.lastSeenAt = time;
    const csrfToken = next.material;
    next.digest.fill(0);
    this.#consumeProof(proof);
    return Object.freeze({ csrfToken });
  }

  abortMutation(proof: AdminMutationProof): void {
    this.#assertProof(proof);
    const record = this.#sessions.get(proof.sessionKey);
    if (
      record !== undefined &&
      record.csrfVersion === proof.csrfVersion
    ) {
      record.mutationInFlight = false;
    }
    this.#consumeProof(proof);
  }

  logout(proof: AdminMutationProof): string {
    this.#assertProof(proof);
    const time = this.#readTime(true);
    const record = this.#sessions.get(proof.sessionKey);
    if (record === undefined) {
      this.#consumeProof(proof);
      fail("ADMIN_AUTH_REQUIRED");
    }
    this.#assertLiveAccount(proof.sessionKey, record, time);
    if (
      record.csrfVersion !== proof.csrfVersion ||
      !record.mutationInFlight
    ) {
      this.#consumeProof(proof);
      fail("ADMIN_CSRF_REJECTED");
    }
    this.#deleteSession(proof.sessionKey, record);
    this.#consumeProof(proof);
    return `${ADMIN_SESSION_COOKIE}=; Path=/console; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clearSessions();
  }

  #session(
    cookie: string,
    time: number,
  ): Readonly<{ key: string; record: SessionRecord }> {
    const token = cookieToken(cookie);
    const source = parseSecret(token, "ADMIN_AUTH_REQUIRED");
    let digest: Buffer | undefined;
    try {
      digest = createHash("sha256").update(source).digest();
      const key = digest.toString("hex");
      const record = this.#sessions.get(key);
      if (record === undefined || !same(record.sessionDigest, digest)) {
        fail("ADMIN_AUTH_REQUIRED");
      }
      this.#assertLiveAccount(key, record, time);
      return Object.freeze({ key, record });
    } finally {
      source.fill(0);
      digest?.fill(0);
    }
  }

  #assertLiveAccount(key: string, record: SessionRecord, time: number): void {
    if (
      time - record.lastSeenAt >= ADMIN_SESSION_IDLE_MS ||
      time - record.createdAt >= ADMIN_SESSION_ABSOLUTE_MS
    ) {
      this.#deleteSession(key, record);
      fail("ADMIN_AUTH_REQUIRED");
    }
    let current: SafeAdminAccount | null;
    try {
      current = this.#accountById(record.identity.accountId);
    } catch {
      return fail("ADMIN_SERVICE_UNAVAILABLE");
    }
    if (
      current === null ||
      current.status !== "active" ||
      current.username !== record.identity.username ||
      current.kind !== record.identity.kind ||
      current.revision !== record.identity.accountRevision ||
      current.passwordRevision !== record.identity.passwordRevision ||
      current.permissionRevision !== record.identity.permissionRevision
    ) {
      this.#deleteSession(key, record);
      fail("ADMIN_AUTH_REQUIRED");
    }
  }

  #secret(): Secret {
    let source: Buffer | undefined;
    try {
      source = this.#randomBytes(32);
      if (!Buffer.isBuffer(source) || source.length !== 32) {
        fail("ADMIN_SERVICE_UNAVAILABLE");
      }
      return Object.freeze({
        material: source.toString("base64url"),
        digest: createHash("sha256").update(source).digest(),
      });
    } catch (error) {
      if (error instanceof AdminSessionFailure) throw error;
      return fail("ADMIN_SERVICE_UNAVAILABLE");
    } finally {
      source?.fill(0);
    }
  }

  #uniqueSessionSecret(): Secret {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const secret = this.#secret();
      if (!this.#sessions.has(secret.digest.toString("hex"))) return secret;
      secret.digest.fill(0);
    }
    return fail("ADMIN_SERVICE_UNAVAILABLE");
  }

  #readTime(rejectRollback: boolean): number {
    this.#assertAvailable();
    let value: number;
    try {
      value = this.#now();
    } catch {
      return fail("ADMIN_SERVICE_UNAVAILABLE");
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      fail("ADMIN_SERVICE_UNAVAILABLE");
    }
    if (value < this.#latestTime) {
      this.#clearSessions();
      this.#latestTime = value;
      if (rejectRollback) fail("ADMIN_AUTH_REQUIRED");
      return value;
    }
    this.#latestTime = value;
    return value;
  }

  #prune(time: number): void {
    for (const [key, record] of this.#sessions) {
      if (
        time - record.lastSeenAt >= ADMIN_SESSION_IDLE_MS ||
        time - record.createdAt >= ADMIN_SESSION_ABSOLUTE_MS
      ) {
        this.#deleteSession(key, record);
      }
    }
  }

  #deleteSession(key: string, record: SessionRecord): void {
    this.#sessions.delete(key);
    record.sessionDigest.fill(0);
    record.csrfDigest.fill(0);
  }

  #clearSessions(): void {
    for (const [key, record] of this.#sessions) {
      this.#deleteSession(key, record);
    }
  }

  #assertProof(proof: AdminMutationProof): void {
    this.#assertAvailable();
    if (
      proof === null ||
      typeof proof !== "object" ||
      proof[mutationBrand] !== true ||
      !this.#proofs.has(proof)
    ) {
      throw new TypeError("Invalid unified administrator mutation proof");
    }
  }

  #consumeProof(proof: AdminMutationProof): void {
    this.#proofs.delete(proof);
  }

  #assertAvailable(): void {
    if (this.#disposed) fail("ADMIN_SERVICE_UNAVAILABLE");
  }
}
