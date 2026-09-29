import { createHmac } from "node:crypto";
import { isIP } from "node:net";

import { normalizeAdminUsername } from "./adminPassword.js";

export const ADMIN_LOGIN_WINDOW_MS = 15 * 60_000;
export const ADMIN_LOGIN_FAILURE_LIMIT = 5;
export const ADMIN_LOGIN_SCOPE_CAPACITY = 4_096;

const LOOKUP_DOMAIN = "TxChat unified administrator rate limit v1\0";

type LoginScope = "account" | "ip" | "account_ip";

type Limit = Readonly<{
  scope: LoginScope;
  lookup: string;
}>;

type Attempt = {
  time: number;
  pending: boolean;
};

export class AdminRateLimiter {
  readonly #key: Buffer;
  readonly #attempts = new Map<string, Attempt[]>();
  #latestTime = Number.NEGATIVE_INFINITY;
  #disposed = false;

  constructor(options: Readonly<{ key: Buffer }>) {
    if (
      options === null ||
      typeof options !== "object" ||
      !Buffer.isBuffer(options.key) ||
      options.key.length !== 32
    ) {
      throw new TypeError("Invalid unified administrator rate limiter options");
    }
    this.#key = Buffer.from(options.key);
  }

  reserve(username: string, ip: string, now: number): boolean {
    this.#assertAvailable();
    const time = this.#time(now);
    const limits = this.#limits(username, ip);
    this.#cleanup(time);
    const allowed = limits.every(
      ({ lookup }) => (this.#attempts.get(lookup)?.length ?? 0) <
        ADMIN_LOGIN_FAILURE_LIMIT,
    );
    if (!allowed) return false;
    const newLookups = limits.reduce(
      (count, { lookup }) => count + (this.#attempts.has(lookup) ? 0 : 1),
      0,
    );
    if (this.#attempts.size + newLookups > ADMIN_LOGIN_SCOPE_CAPACITY) {
      return false;
    }
    for (const { lookup } of limits) {
      const attempts = this.#attempts.get(lookup) ?? [];
      attempts.push({ time, pending: true });
      this.#attempts.set(lookup, attempts);
    }
    return true;
  }

  recordFailure(username: string, ip: string, now: number): void {
    this.#assertAvailable();
    const time = this.#time(now);
    const limits = this.#limits(username, ip);
    this.#cleanup(time);
    for (const { lookup } of limits) {
      const attempts = this.#attempts.get(lookup) ?? [];
      const pending = attempts.find(({ pending: value }) => value);
      if (pending === undefined) {
        attempts.push({ time, pending: false });
      } else {
        pending.pending = false;
      }
      this.#attempts.set(lookup, attempts);
    }
  }

  recordSuccess(username: string, ip: string, now: number): void {
    this.#assertAvailable();
    const time = this.#time(now);
    const limits = this.#limits(username, ip);
    this.#cleanup(time);
    const pending = limits.map(({ lookup }) => {
      const attempts = this.#attempts.get(lookup);
      const index = attempts?.findIndex(({ pending: value }) => value) ?? -1;
      if (attempts === undefined || index < 0) {
        throw new TypeError("Invalid unified administrator login reservation");
      }
      return { lookup, attempts, index };
    });
    for (const { lookup, attempts, index } of pending) {
      attempts.splice(index, 1);
      if (attempts.length === 0) this.#attempts.delete(lookup);
    }
  }

  retryAfterSeconds(username: string, ip: string, now: number): number {
    this.#assertAvailable();
    const time = this.#time(now);
    const limits = this.#limits(username, ip);
    this.#cleanup(time);
    let retryAt = time;
    for (const { lookup } of limits) {
      const attempts = this.#attempts.get(lookup);
      if (attempts !== undefined && attempts.length >= ADMIN_LOGIN_FAILURE_LIMIT) {
        retryAt = Math.max(retryAt, attempts[0]!.time + ADMIN_LOGIN_WINDOW_MS);
      }
    }
    return Math.max(0, Math.ceil((retryAt - time) / 1_000));
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#key.fill(0);
    for (const attempts of this.#attempts.values()) {
      for (const attempt of attempts) attempt.time = 0;
      attempts.length = 0;
    }
    this.#attempts.clear();
  }

  #limits(username: string, ip: string): readonly Limit[] {
    let normalized: string;
    try {
      normalized = normalizeAdminUsername(username);
    } catch {
      throw new TypeError("Invalid unified administrator rate-limit subject");
    }
    if (typeof ip !== "string") {
      throw new TypeError("Invalid unified administrator rate-limit subject");
    }
    const ipVersion = isIP(ip);
    if (ipVersion === 0) {
      throw new TypeError("Invalid unified administrator rate-limit subject");
    }
    const normalizedIp = ipVersion === 6
      ? new URL(`http://[${ip}]/`).hostname.slice(1, -1)
      : ip;
    return Object.freeze([
      Object.freeze({
        scope: "account" as const,
        lookup: this.#lookup("account", normalized),
      }),
      Object.freeze({
        scope: "ip" as const,
        lookup: this.#lookup("ip", normalizedIp),
      }),
      Object.freeze({
        scope: "account_ip" as const,
        lookup: this.#lookup("account-ip", `${normalized}\0${normalizedIp}`),
      }),
    ]);
  }

  #lookup(scope: string, value: string): string {
    return createHmac("sha256", this.#key)
      .update(LOOKUP_DOMAIN, "utf8")
      .update(scope, "utf8")
      .update("\0", "utf8")
      .update(value, "utf8")
      .digest("hex");
  }

  #cleanup(now: number): void {
    const cutoff = now - ADMIN_LOGIN_WINDOW_MS;
    for (const [lookup, attempts] of this.#attempts) {
      let firstLive = 0;
      while (firstLive < attempts.length && attempts[firstLive]!.time <= cutoff) {
        firstLive += 1;
      }
      if (firstLive === attempts.length) {
        for (const attempt of attempts) attempt.time = 0;
        this.#attempts.delete(lookup);
      } else if (firstLive > 0) {
        attempts.splice(0, firstLive);
      }
    }
  }

  #time(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0 || value < this.#latestTime) {
      throw new TypeError("Unified administrator rate limiter is unavailable");
    }
    this.#latestTime = value;
    return value;
  }

  #assertAvailable(): void {
    if (this.#disposed) {
      throw new TypeError("Unified administrator rate limiter is unavailable");
    }
  }
}
