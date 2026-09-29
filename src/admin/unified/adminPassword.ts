import {
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";

import type { AdminPasswordHash } from "./adminTypes.js";

export const ADMIN_USERNAME_PATTERN = /^[A-Za-z0-9._]{4,64}$/u;
export const ADMIN_PASSWORD_MIN = 8;
export const ADMIN_PASSWORD_MAX = 128;
export const ADMIN_SCRYPT = Object.freeze({
  N: 32_768 as const,
  r: 8 as const,
  p: 1 as const,
  keylen: 32 as const,
  maxmem: 64 * 1024 * 1024,
});

export class AdminCredentialError extends Error {
  readonly code = "ADMIN_INVALID_REQUEST" as const;

  constructor() {
    super("ADMIN_INVALID_REQUEST");
    this.name = "AdminCredentialError";
  }
}

export type AdminPasswordDeriver = (
  password: Buffer,
  salt: Buffer,
) => Promise<Buffer>;

function invalid(): never {
  throw new AdminCredentialError();
}

export function normalizeAdminUsername(value: string): string {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    !ADMIN_USERNAME_PATTERN.test(value)
  ) {
    invalid();
  }
  return value.toLowerCase();
}

export function parseAdminPassword(value: string): string {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    invalid();
  }
  const length = [...value].length;
  if (length < ADMIN_PASSWORD_MIN || length > ADMIN_PASSWORD_MAX) {
    invalid();
  }
  return value;
}

const defaultDerive: AdminPasswordDeriver = (password, salt) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      salt,
      ADMIN_SCRYPT.keylen,
      {
        N: ADMIN_SCRYPT.N,
        r: ADMIN_SCRYPT.r,
        p: ADMIN_SCRYPT.p,
        maxmem: ADMIN_SCRYPT.maxmem,
      },
      (error, derived) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(Buffer.from(derived));
      },
    );
  });

function validatePasswordHash(value: AdminPasswordHash): void {
  if (
    value === null ||
    typeof value !== "object" ||
    value.algorithm !== "scrypt-v1" ||
    value.N !== ADMIN_SCRYPT.N ||
    value.r !== ADMIN_SCRYPT.r ||
    value.p !== ADMIN_SCRYPT.p ||
    !Buffer.isBuffer(value.salt) ||
    value.salt.length !== 16 ||
    !Buffer.isBuffer(value.digest) ||
    value.digest.length !== ADMIN_SCRYPT.keylen
  ) {
    invalid();
  }
}

export async function hashAdminPassword(
  candidate: string,
  options: Readonly<{
    random?: (length: number) => Buffer;
    derive?: AdminPasswordDeriver;
  }> = {},
): Promise<AdminPasswordHash> {
  const password = Buffer.from(parseAdminPassword(candidate), "utf8");
  const randomSalt = (options.random ?? randomBytes)(16);
  let salt: Buffer | undefined;
  let derived: Buffer | undefined;
  try {
    if (!Buffer.isBuffer(randomSalt) || randomSalt.length !== 16) invalid();
    salt = Buffer.from(randomSalt);
    derived = await (options.derive ?? defaultDerive)(password, salt);
    if (!Buffer.isBuffer(derived) || derived.length !== ADMIN_SCRYPT.keylen) {
      invalid();
    }
    return Object.freeze({
      algorithm: "scrypt-v1" as const,
      salt: Buffer.from(salt),
      digest: Buffer.from(derived),
      N: ADMIN_SCRYPT.N,
      r: ADMIN_SCRYPT.r,
      p: ADMIN_SCRYPT.p,
    });
  } catch (error) {
    if (error instanceof AdminCredentialError) throw error;
    return invalid();
  } finally {
    password.fill(0);
    randomSalt.fill(0);
    salt?.fill(0);
    derived?.fill(0);
  }
}

export async function verifyAdminPassword(
  candidate: string,
  encoded: AdminPasswordHash,
  options: Readonly<{ derive?: AdminPasswordDeriver }> = {},
): Promise<boolean> {
  validatePasswordHash(encoded);
  const password = Buffer.from(parseAdminPassword(candidate), "utf8");
  const salt = Buffer.from(encoded.salt);
  const expected = Buffer.from(encoded.digest);
  let derived: Buffer | undefined;
  try {
    derived = await (options.derive ?? defaultDerive)(password, salt);
    if (!Buffer.isBuffer(derived) || derived.length !== expected.length) {
      invalid();
    }
    return timingSafeEqual(derived, expected);
  } catch (error) {
    if (error instanceof AdminCredentialError) throw error;
    return invalid();
  } finally {
    password.fill(0);
    salt.fill(0);
    expected.fill(0);
    derived?.fill(0);
  }
}

export function createAdminSetupSecret(
  random: (length: number) => Buffer = randomBytes,
): Readonly<{ material: string; digest: Buffer }> {
  const source = random(32);
  try {
    if (!Buffer.isBuffer(source) || source.length !== 32) invalid();
    return Object.freeze({
      material: source.toString("base64url"),
      digest: createHash("sha256").update(source).digest(),
    });
  } finally {
    source.fill(0);
  }
}
