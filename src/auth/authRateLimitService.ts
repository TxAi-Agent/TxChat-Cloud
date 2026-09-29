import type { CoreDatabase } from "../db/database.js";
import {
  allocateInternalId,
  generateInternalId,
  type InternalIdGenerator,
} from "../ids/internalId.js";
import { authenticationPolicy } from "./authenticationPolicy.js";

type SubjectKind = "phone" | "ip";
type EventType =
  | "send"
  | "provider_cooldown"
  | "lock"
  | "challenge_exhausted"
  | "verification_succeeded";

export type RateLimitReason =
  | "verification_locked"
  | "send_cooldown"
  | "send_quota";

export type RateLimitDecision =
  | Readonly<{ allowed: true }>
  | Readonly<{
      allowed: false;
      retryAfterSeconds: number;
      reason: RateLimitReason;
      phoneLocked?: boolean;
    }>;

function retrySeconds(expiresAtMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((expiresAtMs - nowMs) / 1_000));
}

export class AuthRateLimitService {
  constructor(
    private readonly database: CoreDatabase,
    private readonly internalId: InternalIdGenerator = generateInternalId,
  ) {}

  private placeholders(values: readonly string[]): string {
    return values.map(() => "?").join(", ");
  }

  private activeLock(
    kind: SubjectKind,
    lookups: readonly string[],
    now: Date,
  ): number | undefined {
    if (lookups.length === 0) {
      return undefined;
    }
    const row = this.database
      .prepare(
        `SELECT expires_at
         FROM auth_rate_limit_events
         WHERE subject_kind = ?
           AND subject_lookup IN (${this.placeholders(lookups)})
           AND event_type = 'lock'
           AND expires_at > ?
         ORDER BY expires_at DESC
         LIMIT 1`,
      )
      .get(kind, ...lookups, now.toISOString()) as
      | { expires_at: string }
      | undefined;
    return row === undefined ? undefined : Date.parse(row.expires_at);
  }

  private newestEvent(
    kind: SubjectKind,
    lookups: readonly string[],
    eventType: EventType,
  ): number | undefined {
    if (lookups.length === 0) {
      return undefined;
    }
    const row = this.database
      .prepare(
        `SELECT occurred_at
         FROM auth_rate_limit_events
         WHERE subject_kind = ?
           AND subject_lookup IN (${this.placeholders(lookups)})
           AND event_type = ?
         ORDER BY occurred_at DESC
         LIMIT 1`,
      )
      .get(kind, ...lookups, eventType) as
      | { occurred_at: string }
      | undefined;
    return row === undefined ? undefined : Date.parse(row.occurred_at);
  }

  private quotaRetry(
    kind: SubjectKind,
    lookups: readonly string[],
    eventType: EventType,
    windowMs: number,
    limit: number,
    now: Date,
  ): number | undefined {
    if (lookups.length === 0) {
      return undefined;
    }
    const cutoff = new Date(now.getTime() - windowMs).toISOString();
    const rows = this.database
      .prepare(
        `SELECT occurred_at
         FROM auth_rate_limit_events
         WHERE subject_kind = ?
           AND subject_lookup IN (${this.placeholders(lookups)})
           AND event_type = ?
           AND occurred_at > ?
         ORDER BY occurred_at ASC`,
      )
      .all(kind, ...lookups, eventType, cutoff) as Array<{
      occurred_at: string;
    }>;
    if (rows.length < limit) {
      return undefined;
    }
    return retrySeconds(
      Date.parse(rows[0]!.occurred_at) + windowMs,
      now.getTime(),
    );
  }

  private decision(
    retries: readonly (number | undefined)[],
    reason: RateLimitReason,
  ): RateLimitDecision {
    const present = retries.filter(
      (retry): retry is number => retry !== undefined,
    );
    return present.length === 0
      ? { allowed: true }
      : {
          allowed: false,
          retryAfterSeconds: Math.max(...present),
          reason,
        };
  }

  checkSend(
    phoneLookups: readonly string[],
    ipLookups: readonly string[],
    now: Date,
  ): RateLimitDecision {
    const phoneLock = this.activeLock("phone", phoneLookups, now);
    if (phoneLock !== undefined) {
      return {
        allowed: false,
        retryAfterSeconds: retrySeconds(phoneLock, now.getTime()),
        reason: "verification_locked",
      };
    }
    const phoneQuota = this.decision([
      this.quotaRetry(
        "phone",
        phoneLookups,
        "send",
        authenticationPolicy.sendHourWindowMs,
        authenticationPolicy.phoneSendPerHour,
        now,
      ),
      this.quotaRetry(
        "phone",
        phoneLookups,
        "send",
        authenticationPolicy.sendDayWindowMs,
        authenticationPolicy.phoneSendPer24Hours,
        now,
      ),
    ], "send_quota");
    if (!phoneQuota.allowed) {
      return phoneQuota;
    }
    const ipQuota = this.decision([
      this.quotaRetry(
        "ip",
        ipLookups,
        "send",
        authenticationPolicy.sendHourWindowMs,
        authenticationPolicy.ipSendPerHour,
        now,
      ),
      this.quotaRetry(
        "ip",
        ipLookups,
        "send",
        authenticationPolicy.sendDayWindowMs,
        authenticationPolicy.ipSendPer24Hours,
        now,
      ),
    ], "send_quota");
    if (!ipQuota.allowed) {
      return ipQuota;
    }
    const lastPhoneSend = this.newestEvent("phone", phoneLookups, "send");
    const providerCooldown = this.newestEvent(
      "phone",
      phoneLookups,
      "provider_cooldown",
    );
    const resendRetries = [lastPhoneSend, providerCooldown]
      .filter((value): value is number => value !== undefined)
      .map((value) => value + authenticationPolicy.resendCooldownMs)
      .filter((value) => value > now.getTime())
      .map((value) => retrySeconds(value, now.getTime()));

    return this.decision(resendRetries, "send_cooldown");
  }

  checkVerify(
    phoneLookups: readonly string[],
    now: Date,
  ): RateLimitDecision {
    const phoneLock = this.activeLock("phone", phoneLookups, now);
    const decision = this.decision([
      phoneLock === undefined
        ? undefined
        : retrySeconds(phoneLock, now.getTime()),
    ], "verification_locked");
    return decision.allowed
      ? decision
      : {
          ...decision,
          phoneLocked: phoneLock !== undefined,
        };
  }

  recordSend(
    kind: SubjectKind,
    subjectLookup: string,
    now: Date,
  ): void {
    this.recordEvent(kind, subjectLookup, "send", now);
  }

  recordProviderCooldown(phoneLookup: string, now: Date): string {
    return this.recordEvent(
      "phone",
      phoneLookup,
      "provider_cooldown",
      now,
    );
  }

  recordChallengeExhausted(phoneLookup: string, now: Date): void {
    this.recordEvent("phone", phoneLookup, "challenge_exhausted", now);
  }

  recordVerificationSucceeded(phoneLookup: string, now: Date): void {
    this.recordEvent("phone", phoneLookup, "verification_succeeded", now);
  }

  countRecentExhaustions(
    phoneLookups: readonly string[],
    now: Date,
  ): number {
    if (phoneLookups.length === 0) {
      return 0;
    }
    const rollingCutoff = now.getTime() -
      authenticationPolicy.exhaustedChallengeWindowMs;
    const newestSuccess = this.newestEvent(
      "phone",
      phoneLookups,
      "verification_succeeded",
    );
    const boundary = new Date(
      Math.max(rollingCutoff, newestSuccess ?? rollingCutoff),
    ).toISOString();
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM auth_rate_limit_events
         WHERE subject_kind = 'phone'
           AND subject_lookup IN (${this.placeholders(phoneLookups)})
           AND event_type = 'challenge_exhausted'
           AND occurred_at > ?`,
      )
      .get(...phoneLookups, boundary) as { count: number };
    return row.count;
  }

  private recordEvent(
    kind: SubjectKind,
    subjectLookup: string,
    eventType: EventType,
    now: Date,
    expiresAt?: Date,
  ): string {
    const id = allocateInternalId(this.internalId);
    this.database
      .prepare(
        `INSERT INTO auth_rate_limit_events (
          id, subject_kind, subject_lookup, hmac_key_version, event_type,
          occurred_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        kind,
        subjectLookup,
        subjectLookup.slice(0, subjectLookup.indexOf(":")),
        eventType,
        now.toISOString(),
        expiresAt?.toISOString() ?? null,
      );
    return id;
  }

  clearEvent(id: string): void {
    this.database
      .prepare(`DELETE FROM auth_rate_limit_events WHERE id = ?`)
      .run(id);
  }

  lockPhone(phoneLookup: string, now: Date): number {
    const activeLock = this.activeLock("phone", [phoneLookup], now);
    if (activeLock !== undefined) {
      return retrySeconds(activeLock, now.getTime());
    }
    const lockExpiresAt = new Date(
      now.getTime() + authenticationPolicy.lockDurationMs,
    );
    this.recordEvent(
      "phone",
      phoneLookup,
      "lock",
      now,
      lockExpiresAt,
    );
    return retrySeconds(lockExpiresAt.getTime(), now.getTime());
  }
}
