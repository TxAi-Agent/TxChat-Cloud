import type { CoreDatabase } from "../db/database.js";
import { withImmediateTransaction } from "../db/database.js";
import {
  allocateInternalId,
  generateInternalId,
  type InternalIdGenerator,
} from "../ids/internalId.js";
import { insertWithInternalId } from "../ids/sqliteInternalId.js";
import { authenticationPolicy } from "./authenticationPolicy.js";
import type { AuthAuditService } from "./authAuditService.js";
import { AccessTokenError, TokenService } from "./tokenService.js";

export type SessionRevocationReason =
  | "replaced"
  | "logout"
  | "replay"
  | "disabled"
  | "admin";

export interface SessionRevocationSink {
  revokeSession(
    sessionId: string,
    reason: SessionRevocationReason,
  ): Promise<void>;
}

export class SessionOperationRevoked extends Error {
  constructor(readonly reason: SessionRevocationReason) {
    super("Session operation revoked");
    this.name = "SessionOperationRevoked";
  }
}

export type RegisteredSessionOperation = Readonly<{
  signal: AbortSignal;
  complete(): void;
}>;

type SessionOperationEntry = Readonly<{
  controller: AbortController;
  completed: Promise<void>;
  complete(): void;
}>;

export class SessionOperationRegistry implements SessionRevocationSink {
  readonly #operations = new Map<string, Set<SessionOperationEntry>>();

  register(sessionId: string): RegisteredSessionOperation {
    const controller = new AbortController();
    let resolveCompleted!: () => void;
    const completed = new Promise<void>((resolve) => {
      resolveCompleted = resolve;
    });
    let finished = false;
    const entry: SessionOperationEntry = {
      controller,
      completed,
      complete: () => {
        if (finished) {
          return;
        }
        finished = true;
        const sessionOperations = this.#operations.get(sessionId);
        sessionOperations?.delete(entry);
        if (sessionOperations?.size === 0) {
          this.#operations.delete(sessionId);
        }
        resolveCompleted();
      },
    };
    const operations =
      this.#operations.get(sessionId) ?? new Set<SessionOperationEntry>();
    operations.add(entry);
    this.#operations.set(sessionId, operations);
    return Object.freeze({
      signal: controller.signal,
      complete: entry.complete,
    });
  }

  async revokeSession(
    sessionId: string,
    reason: SessionRevocationReason,
  ): Promise<void> {
    const operations = [...(this.#operations.get(sessionId) ?? [])];
    for (const operation of operations) {
      operation.controller.abort(new SessionOperationRevoked(reason));
    }
    await Promise.all(operations.map((operation) => operation.completed));
  }
}

export type SessionFailureCode =
  | "INVALID_REQUEST"
  | "AUTH_REQUIRED"
  | "SESSION_REPLACED"
  | "SESSION_EXPIRED"
  | "ACCOUNT_DISABLED"
  | "SESSION_REPLAYED";

export class SessionFailure extends Error {
  constructor(
    readonly code: SessionFailureCode,
    readonly statusCode: number,
  ) {
    super(code);
  }
}

export type SessionBundle = Readonly<{
  access: Readonly<{
    accessToken: string;
    accessExpiresInSeconds: number;
    deviceId: string;
    sessionId: string;
  }>;
  refresh: Readonly<{
    refreshToken: string;
    refreshSlidingExpiresInSeconds: number;
  }>;
}>;

export type SessionIdentity = Readonly<{
  accountId: string;
  sessionId: string;
  deviceId: string;
  phoneCiphertext: string;
}>;

export type SessionAuditIp = Readonly<{
  ipLookup: string;
  ipKeyVersion: string;
}>;

type UserRow = {
  id: string;
  phone_ciphertext: string;
  status: "enabled" | "disabled";
  current_session_id: string | null;
};

type RefreshRow = {
  id: string;
  session_id: string;
  family_id: string;
  user_id: string;
  device_id: string;
  token_hash: string;
  status: "current" | "used" | "revoked";
  expires_at: string;
  revoked_reason:
    | "replaced"
    | "logout"
    | "replay"
    | "disabled"
    | "admin"
    | "expired"
    | null;
};

type SessionAnchorRow = {
  id: string;
  user_id: string;
  device_id: string;
  family_id: string;
  status: "current" | "revoked";
  revoked_reason: RefreshRow["revoked_reason"];
};

type CreatedSession = Readonly<{
  bundle: SessionBundle;
  revokedSessionIds: readonly string[];
}>;

type RefreshOutcome =
  | Readonly<{ kind: "success"; bundle: SessionBundle }>
  | Readonly<{
      kind: "replay";
      sessionId: string;
    }>
  | Readonly<{
      kind: "failure";
      code: SessionFailureCode;
      statusCode: number;
      revokedSessionId?: string;
    }>;

const silentRevocationSink: SessionRevocationSink = Object.freeze({
  revokeSession: async () => {},
});

function seconds(milliseconds: number): number {
  return milliseconds / 1_000;
}

function withSessionInsertSavepoint(
  database: CoreDatabase,
  insert: () => boolean,
): boolean {
  database.exec("SAVEPOINT session_internal_id_attempt");
  try {
    const inserted = insert();
    if (!inserted) {
      database.exec("ROLLBACK TO session_internal_id_attempt");
    }
    database.exec("RELEASE session_internal_id_attempt");
    return inserted;
  } catch (error) {
    database.exec("ROLLBACK TO session_internal_id_attempt");
    database.exec("RELEASE session_internal_id_attempt");
    throw error;
  }
}

export class SessionService {
  private readonly refreshRecoveryRequestColumn: "request_id" | "request_ref";

  constructor(
    private readonly database: CoreDatabase,
    private readonly tokens: TokenService,
    private readonly now: () => Date,
    private readonly revocationSink: SessionRevocationSink =
      silentRevocationSink,
    private readonly audit?: AuthAuditService,
    private readonly mockMode = false,
    private readonly internalId: InternalIdGenerator = generateInternalId,
  ) {
    const columns = this.database
      .prepare("PRAGMA table_info(refresh_recoveries)")
      .all() as Array<{ name: string }>;
    this.refreshRecoveryRequestColumn = columns.some(
      ({ name }) => name === "request_ref",
    )
      ? "request_ref"
      : "request_id";
  }

  private createBundle(
    userId: string,
    sessionId: string,
    deviceId: string,
    refreshToken: string,
    now: Date,
  ): SessionBundle {
    return {
      access: {
        accessToken: this.tokens.createAccessToken(
          userId,
          sessionId,
          deviceId,
          now,
        ),
        accessExpiresInSeconds: seconds(authenticationPolicy.accessTtlMs),
        deviceId,
        sessionId,
      },
      refresh: {
        refreshToken,
        refreshSlidingExpiresInSeconds: seconds(
          authenticationPolicy.refreshSlidingTtlMs,
        ),
      },
    };
  }

  createWithinTransaction(userId: string, now: Date): CreatedSession {
    if (!this.database.inTransaction) {
      throw new Error("Session creation requires a caller transaction");
    }

    const priorRows = this.database
      .prepare(
        `SELECT id AS session_id
         FROM auth_sessions
         WHERE user_id = ? AND status = 'current'`,
      )
      .all(userId) as Array<{ session_id: string }>;
    this.database
      .prepare(
        `UPDATE refresh_sessions
         SET status = 'revoked', revoked_at = ?, revoked_reason = 'replaced'
         WHERE user_id = ? AND status = 'current'`,
      )
      .run(now.toISOString(), userId);
    this.database
      .prepare(
        `UPDATE auth_sessions
         SET status = 'revoked', updated_at = ?, revoked_at = ?,
             revoked_reason = 'replaced'
         WHERE user_id = ? AND status = 'current'`,
      )
      .run(now.toISOString(), now.toISOString(), userId);

    const sessionInsert = this.database.prepare(
      `INSERT INTO auth_sessions (
        id, user_id, device_id, family_id, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'current', ?, ?)
      ON CONFLICT(id) DO NOTHING`,
    );
    const refreshInsert = this.database.prepare(
      `INSERT INTO refresh_sessions (
        id, session_id, family_id, user_id, device_id, token_hash,
        status, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'current', ?, ?)
      ON CONFLICT(id) DO NOTHING`,
    );
    let created: Readonly<{
      deviceId: string;
      refreshToken: string;
    }> | undefined;
    const sessionId = insertWithInternalId({
      generate: this.internalId,
      insert: (candidate) => withSessionInsertSavepoint(this.database, () => {
        const deviceId = allocateInternalId(this.internalId);
        const familyId = allocateInternalId(this.internalId);
        const refreshId = allocateInternalId(this.internalId);
        const refreshToken = this.tokens.createRefreshToken();
        if (sessionInsert.run(
          candidate,
          userId,
          deviceId,
          familyId,
          now.toISOString(),
          now.toISOString(),
        ).changes !== 1) return false;
        if (refreshInsert.run(
          refreshId,
          candidate,
          familyId,
          userId,
          deviceId,
          this.tokens.hashRefreshToken(refreshToken),
          now.toISOString(),
          new Date(
            now.getTime() + authenticationPolicy.refreshSlidingTtlMs,
          ).toISOString(),
        ).changes !== 1) return false;
        this.database.prepare(
          `UPDATE users
           SET current_session_id = ?, updated_at = ?
           WHERE id = ?`,
        ).run(candidate, now.toISOString(), userId);
        created = Object.freeze({ deviceId, refreshToken });
        return true;
      }),
    });
    if (created === undefined) {
      throw new Error("Internal ID allocation failed");
    }

    return {
      bundle: this.createBundle(
        userId,
        sessionId,
        created.deviceId,
        created.refreshToken,
        now,
      ),
      revokedSessionIds: priorRows.map((row) => row.session_id),
    };
  }

  async notifyRevoked(
    sessionIds: readonly string[],
    reason: SessionRevocationReason,
  ): Promise<void> {
    for (const sessionId of new Set(sessionIds)) {
      await this.revocationSink.revokeSession(sessionId, reason);
    }
  }

  authenticate(accessToken: string): SessionIdentity {
    const now = this.now();
    let claims;
    try {
      claims = this.tokens.verifyAccessToken(accessToken, now);
    } catch (error) {
      if (error instanceof AccessTokenError && error.reason === "expired") {
        throw new SessionFailure("SESSION_EXPIRED", 401);
      }
      throw new SessionFailure("AUTH_REQUIRED", 401);
    }

    const user = this.database
      .prepare(
        `SELECT id, phone_ciphertext, status, current_session_id
         FROM users WHERE id = ?`,
      )
      .get(claims.accountId) as UserRow | undefined;
    if (user === undefined) {
      throw new SessionFailure("AUTH_REQUIRED", 401);
    }
    if (user.status === "disabled") {
      throw new SessionFailure("ACCOUNT_DISABLED", 403);
    }
    if (user.current_session_id !== claims.sessionId) {
      const prior = this.database
        .prepare(
          `SELECT revoked_reason
           FROM auth_sessions
           WHERE id = ? AND status = 'revoked'`,
        )
        .get(claims.sessionId) as
        | { revoked_reason: RefreshRow["revoked_reason"] }
        | undefined;
      throw new SessionFailure(
        prior?.revoked_reason === "replaced"
          ? "SESSION_REPLACED"
          : "AUTH_REQUIRED",
        401,
      );
    }
    const current = this.database
      .prepare(
        `SELECT refresh.expires_at
         FROM auth_sessions AS session
         JOIN refresh_sessions AS refresh
           ON refresh.session_id = session.id
          AND refresh.family_id = session.family_id
          AND refresh.user_id = session.user_id
          AND refresh.device_id = session.device_id
         WHERE session.user_id = ?
           AND session.id = ?
           AND session.device_id = ?
           AND session.status = 'current'
           AND refresh.status = 'current'`,
      )
      .get(user.id, claims.sessionId, claims.deviceId) as
      | { expires_at: string }
      | undefined;
    if (current === undefined) {
      throw new SessionFailure("AUTH_REQUIRED", 401);
    }
    if (Date.parse(current.expires_at) <= now.getTime()) {
      throw new SessionFailure("SESSION_EXPIRED", 401);
    }
    return {
      accountId: user.id,
      sessionId: claims.sessionId,
      deviceId: claims.deviceId,
      phoneCiphertext: user.phone_ciphertext,
    };
  }

  async refresh(
    refreshToken: string,
    refreshRequestId: string,
    requestId: string,
    auditIp: SessionAuditIp,
  ): Promise<SessionBundle> {
    const now = this.now();
    const tokenHashes = this.tokens.hashRefreshTokenCandidates(refreshToken);
    const placeholders = tokenHashes.map(() => "?").join(", ");
    const outcome = withImmediateTransaction(
      this.database,
      (): RefreshOutcome => {
        const row = this.database
          .prepare(
            `SELECT id, session_id, family_id, user_id, device_id,
                    token_hash, status, expires_at, revoked_reason
             FROM refresh_sessions
             WHERE token_hash IN (${placeholders})
             LIMIT 1`,
          )
          .get(...tokenHashes) as RefreshRow | undefined;
        if (row === undefined) {
          return {
            kind: "failure",
            code: "AUTH_REQUIRED",
            statusCode: 401,
          };
        }

        const user = this.database
          .prepare(
            `SELECT id, phone_ciphertext, status, current_session_id
             FROM users WHERE id = ?`,
          )
          .get(row.user_id) as UserRow | undefined;
        const anchor = this.database
          .prepare(
            `SELECT id, user_id, device_id, family_id, status,
                    revoked_reason
             FROM auth_sessions
             WHERE id = ?`,
          )
          .get(row.session_id) as SessionAnchorRow | undefined;
        if (user?.status === "disabled") {
          return {
            kind: "failure",
            code: "ACCOUNT_DISABLED",
            statusCode: 403,
          };
        }
        const requestOwner = this.database
          .prepare(
            `SELECT source_token_hash
             FROM refresh_recoveries
             WHERE family_id = ? AND ${this.refreshRecoveryRequestColumn} = ?`,
          )
          .get(row.family_id, refreshRequestId) as
          | { source_token_hash: string }
          | undefined;
        if (
          requestOwner !== undefined &&
          requestOwner.source_token_hash !== row.token_hash
        ) {
          return {
            kind: "failure",
            code: "INVALID_REQUEST",
            statusCode: 400,
          };
        }
        const recovery = this.database
          .prepare(
            `SELECT encrypted_result
             FROM refresh_recoveries
             WHERE family_id = ?
               AND ${this.refreshRecoveryRequestColumn} = ?
               AND source_token_hash = ?
               AND expires_at > ?`,
          )
          .get(
            row.family_id,
            refreshRequestId,
            row.token_hash,
            now.toISOString(),
          ) as { encrypted_result: string } | undefined;
        if (recovery !== undefined) {
          if (user === undefined) {
            return {
              kind: "failure",
              code: "AUTH_REQUIRED",
              statusCode: 401,
            };
          }
          if (
            user.current_session_id !== row.session_id ||
            anchor?.status !== "current"
          ) {
            return {
              kind: "failure",
              code:
                anchor?.revoked_reason === "replaced"
                  ? "SESSION_REPLACED"
                  : "AUTH_REQUIRED",
              statusCode: 401,
            };
          }
          const currentFamily = this.database
            .prepare(
              `SELECT expires_at
               FROM refresh_sessions
               WHERE family_id = ? AND status = 'current'
               LIMIT 1`,
            )
            .get(row.family_id) as { expires_at: string } | undefined;
          if (currentFamily === undefined) {
            return {
              kind: "failure",
              code: "AUTH_REQUIRED",
              statusCode: 401,
            };
          }
          if (Date.parse(currentFamily.expires_at) <= now.getTime()) {
            return {
              kind: "failure",
              code: "SESSION_EXPIRED",
              statusCode: 401,
            };
          }
          return {
            kind: "success",
            bundle:
              this.tokens.decryptRecoveryResult<SessionBundle>(
                recovery.encrypted_result,
              ),
          };
        }

        if (row.status === "used") {
          this.database
            .prepare(
              `UPDATE refresh_sessions
               SET status = 'revoked', revoked_at = ?,
                   revoked_reason = 'replay'
               WHERE family_id = ? AND status != 'revoked'`,
            )
            .run(now.toISOString(), row.family_id);
          this.database
            .prepare(
              `UPDATE auth_sessions
               SET status = 'revoked', updated_at = ?, revoked_at = ?,
                   revoked_reason = 'replay'
               WHERE id = ? AND status = 'current'`,
            )
            .run(
              now.toISOString(),
              now.toISOString(),
              row.session_id,
            );
          this.database
            .prepare(
              `UPDATE users
               SET current_session_id = NULL, updated_at = ?
               WHERE id = ? AND current_session_id = ?`,
            )
            .run(now.toISOString(), row.user_id, row.session_id);
          return { kind: "replay", sessionId: row.session_id };
        }
        if (row.status === "revoked") {
          return {
            kind: "failure",
            code:
              anchor?.revoked_reason === "replaced"
                ? "SESSION_REPLACED"
                : anchor?.revoked_reason === "expired"
                  ? "SESSION_EXPIRED"
                  : "AUTH_REQUIRED",
            statusCode: 401,
          };
        }
        if (
          user === undefined ||
          user.current_session_id !== row.session_id ||
          anchor?.status !== "current"
        ) {
          return {
            kind: "failure",
            code:
              anchor?.revoked_reason === "replaced"
                ? "SESSION_REPLACED"
                : "AUTH_REQUIRED",
            statusCode: 401,
          };
        }
        if (Date.parse(row.expires_at) <= now.getTime()) {
          this.database
            .prepare(
              `UPDATE refresh_sessions
               SET status = 'revoked', revoked_at = ?,
                   revoked_reason = 'expired'
               WHERE id = ?`,
            )
            .run(now.toISOString(), row.id);
          this.database
            .prepare(
              `UPDATE auth_sessions
               SET status = 'revoked', updated_at = ?, revoked_at = ?,
                   revoked_reason = 'expired'
               WHERE id = ? AND status = 'current'`,
            )
            .run(
              now.toISOString(),
              now.toISOString(),
              row.session_id,
            );
          this.database
            .prepare(
              `UPDATE users
               SET current_session_id = NULL, updated_at = ?
               WHERE id = ? AND current_session_id = ?`,
            )
            .run(now.toISOString(), row.user_id, row.session_id);
          return {
            kind: "failure",
            code: "SESSION_EXPIRED",
            statusCode: 401,
            revokedSessionId: row.session_id,
          };
        }

        const nextRefreshToken = this.tokens.createRefreshToken();
        const nextRefreshHash = this.tokens.hashRefreshToken(
          nextRefreshToken,
        );
        this.database
          .prepare(
            `UPDATE refresh_sessions
             SET status = 'used', used_at = ?
             WHERE id = ?`,
          )
          .run(now.toISOString(), row.id);
        const refreshInsert = this.database.prepare(
          `INSERT INTO refresh_sessions (
            id, session_id, family_id, user_id, device_id, token_hash,
            status, created_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'current', ?, ?)
          ON CONFLICT(id) DO NOTHING`,
        );
        insertWithInternalId({
          generate: this.internalId,
          insert: (candidate) => refreshInsert.run(
            candidate,
            row.session_id,
            row.family_id,
            row.user_id,
            row.device_id,
            nextRefreshHash,
            now.toISOString(),
            new Date(
              now.getTime() + authenticationPolicy.refreshSlidingTtlMs,
            ).toISOString(),
          ).changes === 1,
        });
        this.database
          .prepare(
            `UPDATE auth_sessions
             SET updated_at = ?
             WHERE id = ? AND status = 'current'`,
          )
          .run(now.toISOString(), row.session_id);
        const bundle = this.createBundle(
          row.user_id,
          row.session_id,
          row.device_id,
          nextRefreshToken,
          now,
        );
        this.database
          .prepare(
            `INSERT INTO refresh_recoveries (
              family_id, ${this.refreshRecoveryRequestColumn}, source_refresh_session_id,
              source_token_hash, encrypted_result,
              recovery_key_version, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            row.family_id,
            refreshRequestId,
            row.id,
            row.token_hash,
            this.tokens.encryptRecoveryResult(bundle),
            this.tokens.activeRecoveryKeyVersion,
            now.toISOString(),
            new Date(
              now.getTime() + authenticationPolicy.refreshRecoveryTtlMs,
            ).toISOString(),
          );
        return { kind: "success", bundle };
      },
    );

    if (outcome.kind === "replay") {
      this.safeAudit({
        type: "session_replayed",
        requestId,
        sessionId: outcome.sessionId,
        ...auditIp,
        outcome: "replayed",
        mockMode: this.mockMode,
        occurredAt: now,
      });
      await this.notifyRevoked([outcome.sessionId], "replay");
      throw new SessionFailure("SESSION_REPLAYED", 409);
    }
    if (outcome.kind === "failure") {
      throw new SessionFailure(outcome.code, outcome.statusCode);
    }
    this.safeAudit({
      type: "session_rotated",
      requestId,
      sessionId: outcome.bundle.access.sessionId,
      ...auditIp,
      outcome: "rotated",
      mockMode: this.mockMode,
      occurredAt: now,
    });
    return outcome.bundle;
  }

  async logout(
    accessToken: string,
    requestId: string,
    auditIp: SessionAuditIp,
  ): Promise<void> {
    const identity = this.authenticate(accessToken);
    const now = this.now();
    withImmediateTransaction(this.database, () => {
      this.database
        .prepare(
          `UPDATE refresh_sessions
           SET status = 'revoked', revoked_at = ?, revoked_reason = 'logout'
           WHERE session_id = ? AND status = 'current'`,
        )
        .run(now.toISOString(), identity.sessionId);
      this.database
        .prepare(
          `UPDATE auth_sessions
           SET status = 'revoked', updated_at = ?, revoked_at = ?,
               revoked_reason = 'logout'
           WHERE id = ? AND status = 'current'`,
        )
        .run(
          now.toISOString(),
          now.toISOString(),
          identity.sessionId,
        );
      this.database
        .prepare(
          `UPDATE users
           SET current_session_id = NULL, updated_at = ?
           WHERE id = ? AND current_session_id = ?`,
        )
        .run(now.toISOString(), identity.accountId, identity.sessionId);
    });
    this.safeAudit({
      type: "session_revoked",
      requestId,
      accountId: identity.accountId,
      sessionId: identity.sessionId,
      ...auditIp,
      outcome: "revoked",
      mockMode: this.mockMode,
      occurredAt: now,
    });
    await this.notifyRevoked([identity.sessionId], "logout");
  }

  async disableAccount(accountId: string, requestId: string): Promise<void> {
    const now = this.now();
    const sessions = withImmediateTransaction(this.database, () => {
      const rows = this.database
        .prepare(
          `SELECT id AS session_id
           FROM auth_sessions
           WHERE user_id = ? AND status = 'current'`,
        )
        .all(accountId) as Array<{ session_id: string }>;
      this.database
        .prepare(
          `UPDATE refresh_sessions
           SET status = 'revoked', revoked_at = ?,
               revoked_reason = 'disabled'
           WHERE user_id = ? AND status = 'current'`,
        )
        .run(now.toISOString(), accountId);
      this.database
        .prepare(
          `UPDATE auth_sessions
           SET status = 'revoked', updated_at = ?, revoked_at = ?,
               revoked_reason = 'disabled'
           WHERE user_id = ? AND status = 'current'`,
        )
        .run(now.toISOString(), now.toISOString(), accountId);
      this.database
        .prepare(
          `UPDATE users
           SET status = 'disabled', current_session_id = NULL,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(now.toISOString(), accountId);
      return rows.map((row) => row.session_id);
    });
    for (const sessionId of sessions) {
      this.safeAudit({
        type: "session_revoked",
        requestId,
        accountId,
        sessionId,
        outcome: "revoked",
        mockMode: this.mockMode,
        occurredAt: now,
      });
    }
    await this.notifyRevoked(sessions, "disabled");
  }

  async adminRevoke(sessionId: string, requestId: string): Promise<void> {
    const now = this.now();
    const row = withImmediateTransaction(this.database, () => {
      const session = this.database
        .prepare(
          `SELECT user_id FROM auth_sessions
           WHERE id = ? AND status = 'current'`,
        )
        .get(sessionId) as { user_id: string } | undefined;
      if (session === undefined) {
        return undefined;
      }
      this.database
        .prepare(
          `UPDATE refresh_sessions
           SET status = 'revoked', revoked_at = ?,
               revoked_reason = 'admin'
           WHERE session_id = ? AND status = 'current'`,
        )
        .run(now.toISOString(), sessionId);
      this.database
        .prepare(
          `UPDATE auth_sessions
           SET status = 'revoked', updated_at = ?, revoked_at = ?,
               revoked_reason = 'admin'
           WHERE id = ? AND status = 'current'`,
        )
        .run(now.toISOString(), now.toISOString(), sessionId);
      this.database
        .prepare(
          `UPDATE users
           SET current_session_id = NULL, updated_at = ?
           WHERE id = ? AND current_session_id = ?`,
        )
        .run(now.toISOString(), session.user_id, sessionId);
      return session;
    });
    if (row === undefined) {
      return;
    }
    this.safeAudit({
      type: "session_revoked",
      requestId,
      accountId: row.user_id,
      sessionId,
      outcome: "revoked",
      mockMode: this.mockMode,
      occurredAt: now,
    });
    await this.notifyRevoked([sessionId], "admin");
  }

  private safeAudit(
    event: Parameters<AuthAuditService["record"]>[0],
  ): void {
    try {
      this.audit?.record(event);
    } catch {
      // Authentication state changes never depend on audit availability.
    }
  }
}
