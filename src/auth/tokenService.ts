import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { authenticationPolicy } from "./authenticationPolicy.js";
import type { VersionedKeyRing } from "./phoneIdentity.js";

export type AccessClaims = Readonly<{
  accountId: string;
  sessionId: string;
  deviceId: string;
  keyVersion: string;
  expiresAtMs: number;
}>;

export class AccessTokenError extends Error {
  constructor(readonly reason: "invalid" | "expired") {
    super(`Access token ${reason}`);
  }
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeJson(value: string): Record<string, unknown> {
  const parsed = JSON.parse(
    Buffer.from(value, "base64url").toString("utf8"),
  ) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Token segment is not an object");
  }
  return parsed as Record<string, unknown>;
}

function keyForVersion(keys: VersionedKeyRing, version: string): Buffer {
  const key = keys.versions.get(version);
  if (key === undefined) {
    throw new AccessTokenError("invalid");
  }
  return key;
}

function equalBase64Url(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "base64url");
  const rightBytes = Buffer.from(right, "base64url");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

export class TokenService {
  constructor(
    private readonly signingKeys: VersionedKeyRing,
    private readonly recoveryKeys: VersionedKeyRing,
  ) {}

  get activeRecoveryKeyVersion(): string {
    return this.recoveryKeys.activeVersion;
  }

  createAccessToken(
    accountId: string,
    sessionId: string,
    deviceId: string,
    now: Date,
  ): string {
    const issuedAt = Math.floor(now.getTime() / 1_000);
    const expiresAt = Math.floor(
      (now.getTime() + authenticationPolicy.accessTtlMs) / 1_000,
    );
    const header = encode({
      alg: "HS256",
      typ: "JWT",
      kid: this.signingKeys.activeVersion,
    });
    const payload = encode({
      sub: accountId,
      sid: sessionId,
      did: deviceId,
      iat: issuedAt,
      exp: expiresAt,
    });
    const signature = createHmac(
      "sha256",
      keyForVersion(this.signingKeys, this.signingKeys.activeVersion),
    )
      .update(`${header}.${payload}`)
      .digest("base64url");
    return `${header}.${payload}.${signature}`;
  }

  verifyAccessToken(token: string, now: Date): AccessClaims {
    try {
      const [headerSource, payloadSource, signature, extra] = token.split(".");
      if (
        headerSource === undefined ||
        payloadSource === undefined ||
        signature === undefined ||
        extra !== undefined
      ) {
        throw new AccessTokenError("invalid");
      }
      const header = decodeJson(headerSource);
      const payload = decodeJson(payloadSource);
      if (
        header.alg !== "HS256" ||
        header.typ !== "JWT" ||
        typeof header.kid !== "string" ||
        typeof payload.sub !== "string" ||
        typeof payload.sid !== "string" ||
        typeof payload.did !== "string" ||
        typeof payload.exp !== "number"
      ) {
        throw new AccessTokenError("invalid");
      }
      const expected = createHmac(
        "sha256",
        keyForVersion(this.signingKeys, header.kid),
      )
        .update(`${headerSource}.${payloadSource}`)
        .digest("base64url");
      if (!equalBase64Url(expected, signature)) {
        throw new AccessTokenError("invalid");
      }
      const expiresAtMs = payload.exp * 1_000;
      if (now.getTime() >= expiresAtMs) {
        throw new AccessTokenError("expired");
      }
      return {
        accountId: payload.sub,
        sessionId: payload.sid,
        deviceId: payload.did,
        keyVersion: header.kid,
        expiresAtMs,
      };
    } catch (error) {
      if (error instanceof AccessTokenError) {
        throw error;
      }
      throw new AccessTokenError("invalid");
    }
  }

  createRefreshToken(): string {
    return randomBytes(32).toString("base64url");
  }

  hashRefreshToken(token: string): string {
    return createHmac(
      "sha256",
      keyForVersion(this.recoveryKeys, this.recoveryKeys.activeVersion),
    )
      .update("refresh-token:")
      .update(token)
      .digest("hex");
  }

  hashRefreshTokenCandidates(token: string): readonly string[] {
    return [...this.recoveryKeys.versions.entries()].map(([, key]) =>
      createHmac("sha256", key)
        .update("refresh-token:")
        .update(token)
        .digest("hex"),
    );
  }

  encryptRecoveryResult(result: unknown): string {
    const initializationVector = randomBytes(12);
    const key = keyForVersion(
      this.recoveryKeys,
      this.recoveryKeys.activeVersion,
    );
    const cipher = createCipheriv(
      "aes-256-gcm",
      key,
      initializationVector,
    );
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(result), "utf8"),
      cipher.final(),
    ]);
    return [
      this.recoveryKeys.activeVersion,
      initializationVector.toString("base64url"),
      ciphertext.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
    ].join(":");
  }

  decryptRecoveryResult<T>(envelope: string): T {
    const [version, initializationVector, ciphertext, tag, extra] =
      envelope.split(":");
    if (
      version === undefined ||
      initializationVector === undefined ||
      ciphertext === undefined ||
      tag === undefined ||
      extra !== undefined
    ) {
      throw new Error("Invalid refresh recovery");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      keyForVersion(this.recoveryKeys, version),
      Buffer.from(initializationVector, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext) as T;
  }
}
