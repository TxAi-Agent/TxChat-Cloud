import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

import {
  createVersionedKeyRing,
  loadVersionedKeyRing,
  type VersionedKeyRing,
} from "../auth/phoneIdentity.js";
import type { EncryptedSmsCredentials } from "./smsAdminTypes.js";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const ERROR_CODE = "SMS_CONFIGURATION_UNAVAILABLE" as const;
const KEY_RING_FIELDS = new Set(["activeVersion", "priorVersions", "keys"]);

export type SmsCredentialIdentity = Readonly<{
  configurationId: string;
  revision: number;
  provider: "alibaba-cloud";
  signName: string;
  templateCode: string;
}>;

export class SmsConfigurationCipherError extends Error {
  readonly code = ERROR_CODE;

  constructor(code: typeof ERROR_CODE) {
    super(code);
    this.name = "SmsConfigurationCipherError";
  }
}

function unavailable(): never {
  throw new SmsConfigurationCipherError(ERROR_CODE);
}

function strictKeyRingShape(value: unknown): value is Readonly<{
  activeVersion: string;
  priorVersions: string[];
  keys: Record<string, string>;
}> {
  return value !== null && typeof value === "object" &&
    Object.hasOwn(value, "activeVersion") &&
    Object.hasOwn(value, "priorVersions") &&
    Object.hasOwn(value, "keys") &&
    Object.keys(value).every((field) => KEY_RING_FIELDS.has(field));
}

function sameVersionSet(left: readonly string[], right: readonly string[]): boolean {
  const uniqueRight = new Set(right);
  return left.length === right.length && uniqueRight.size === right.length &&
    left.every((version) => uniqueRight.has(version));
}

export function loadSmsConfigurationKeyRing(
  source: string | Buffer,
): VersionedKeyRing {
  try {
    const text = Buffer.isBuffer(source)
      ? new TextDecoder("utf-8", { fatal: true }).decode(source)
      : source;
    const parsed: unknown = JSON.parse(text);
    if (!strictKeyRingShape(parsed)) unavailable();
    const ring = loadVersionedKeyRing(text);
    const selected = [parsed.activeVersion, ...parsed.priorVersions];
    const declared = Object.keys(parsed.keys);
    const loaded = [...ring.versions.keys()];
    if (
      !sameVersionSet(declared, selected) ||
      !sameVersionSet(declared, loaded)
    ) {
      unavailable();
    }
    return ring;
  } catch {
    unavailable();
  }
}

function copyKeyRing(source: VersionedKeyRing): VersionedKeyRing {
  const entries = [...source.versions.entries()];
  const priorVersions = entries
    .map(([version]) => version)
    .filter((version) => version !== source.activeVersion);
  return createVersionedKeyRing({
    activeVersion: source.activeVersion,
    keys: Object.fromEntries(entries),
  }, priorVersions);
}

function validateIdentity(input: SmsCredentialIdentity): void {
  if (
    typeof input.configurationId !== "string" ||
    input.configurationId.length < 1 ||
    input.configurationId.length > 128 ||
    !input.configurationId.isWellFormed() ||
    /[\u0000-\u001f\u007f]/u.test(input.configurationId) ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 1 ||
    input.provider !== "alibaba-cloud" ||
    typeof input.signName !== "string" || input.signName.trim().length < 1 ||
    input.signName.length > 128 || /[\u0000-\u001f\u007f]/u.test(input.signName) ||
    !/^SMS_[0-9]{6,32}$/.test(input.templateCode)
  ) {
    unavailable();
  }
}

function validateCredential(value: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    value.trim() !== value ||
    !value.isWellFormed() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    unavailable();
  }
}

function validateEncrypted(value: EncryptedSmsCredentials): void {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.keyVersion !== "string" ||
    value.keyVersion.length < 1 ||
    !Buffer.isBuffer(value.nonce) ||
    value.nonce.length !== NONCE_BYTES ||
    !Buffer.isBuffer(value.ciphertext) ||
    value.ciphertext.length < 1 ||
    !Buffer.isBuffer(value.tag) ||
    value.tag.length !== TAG_BYTES
  ) {
    unavailable();
  }
}

function additionalAuthenticatedData(input: SmsCredentialIdentity): Buffer {
  return Buffer.from(JSON.stringify({
    configurationId: input.configurationId,
    provider: input.provider,
    revision: input.revision,
    signName: input.signName,
    templateCode: input.templateCode,
  }), "utf8");
}

function parsePlaintext(source: Buffer): Readonly<{
  accessKeyId: string;
  accessKeySecret: string;
}> {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(source);
  const value: unknown = JSON.parse(text);
  if (
    value === null ||
    typeof value !== "object" ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "accessKeyId") ||
    !Object.hasOwn(value, "accessKeySecret")
  ) {
    unavailable();
  }
  const credential = value as {
    accessKeyId: unknown;
    accessKeySecret: unknown;
  };
  validateCredential(credential.accessKeyId as string);
  validateCredential(credential.accessKeySecret as string);
  return Object.freeze({
    accessKeyId: credential.accessKeyId as string,
    accessKeySecret: credential.accessKeySecret as string,
  });
}

export class SmsConfigurationCipher {
  readonly #keys: VersionedKeyRing;
  #disposed = false;

  constructor(keys: VersionedKeyRing) {
    try {
      this.#keys = copyKeyRing(keys);
    } catch {
      throw new SmsConfigurationCipherError(ERROR_CODE);
    }
  }

  encrypt(input: SmsCredentialIdentity & Readonly<{
    accessKeyId: string;
    accessKeySecret: string;
  }>): EncryptedSmsCredentials {
    let plaintext: Buffer | undefined;
    let aad: Buffer | undefined;
    let key: Buffer | undefined;
    let nonce: Buffer | undefined;
    let first: Buffer | undefined;
    let last: Buffer | undefined;
    let encrypted: Buffer | undefined;
    let tag: Buffer | undefined;
    try {
      if (this.#disposed) unavailable();
      validateIdentity(input);
      validateCredential(input.accessKeyId);
      validateCredential(input.accessKeySecret);
      plaintext = Buffer.from(JSON.stringify({
        accessKeyId: input.accessKeyId,
        accessKeySecret: input.accessKeySecret,
      }), "utf8");
      const keyVersion = this.#keys.activeVersion;
      const stored = this.#keys.versions.get(keyVersion);
      if (stored === undefined || stored.length !== KEY_BYTES) unavailable();
      key = Buffer.from(stored);
      nonce = randomBytes(NONCE_BYTES);
      aad = additionalAuthenticatedData(input);
      const cipher = createCipheriv("aes-256-gcm", key, nonce, {
        authTagLength: TAG_BYTES,
      });
      cipher.setAAD(aad);
      first = cipher.update(plaintext);
      last = cipher.final();
      encrypted = Buffer.concat([first, last]);
      tag = cipher.getAuthTag();
      return Object.freeze({
        keyVersion,
        nonce: Buffer.from(nonce),
        ciphertext: Buffer.from(encrypted),
        tag: Buffer.from(tag),
      });
    } catch {
      throw new SmsConfigurationCipherError(ERROR_CODE);
    } finally {
      plaintext?.fill(0);
      aad?.fill(0);
      key?.fill(0);
      nonce?.fill(0);
      first?.fill(0);
      last?.fill(0);
      encrypted?.fill(0);
      tag?.fill(0);
    }
  }

  decrypt(input: SmsCredentialIdentity & Readonly<{
    encrypted: EncryptedSmsCredentials;
  }>): Readonly<{ accessKeyId: string; accessKeySecret: string }> {
    let key: Buffer | undefined;
    let nonce: Buffer | undefined;
    let encrypted: Buffer | undefined;
    let tag: Buffer | undefined;
    let aad: Buffer | undefined;
    let first: Buffer | undefined;
    let last: Buffer | undefined;
    let plaintext: Buffer | undefined;
    try {
      if (this.#disposed) unavailable();
      validateIdentity(input);
      validateEncrypted(input.encrypted);
      const stored = this.#keys.versions.get(input.encrypted.keyVersion);
      if (stored === undefined || stored.length !== KEY_BYTES) unavailable();
      key = Buffer.from(stored);
      nonce = Buffer.from(input.encrypted.nonce);
      encrypted = Buffer.from(input.encrypted.ciphertext);
      tag = Buffer.from(input.encrypted.tag);
      aad = additionalAuthenticatedData(input);
      const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      first = decipher.update(encrypted);
      last = decipher.final();
      plaintext = Buffer.concat([first, last]);
      return parsePlaintext(plaintext);
    } catch {
      throw new SmsConfigurationCipherError(ERROR_CODE);
    } finally {
      key?.fill(0);
      nonce?.fill(0);
      encrypted?.fill(0);
      tag?.fill(0);
      aad?.fill(0);
      first?.fill(0);
      last?.fill(0);
      plaintext?.fill(0);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const material of this.#keys.versions.values()) material.fill(0);
  }
}

export function rebindSmsConfigurationCredentials(input: Readonly<{
  cipher: SmsConfigurationCipher;
  encrypted: EncryptedSmsCredentials;
  oldIdentity: SmsCredentialIdentity;
  newIdentity: SmsCredentialIdentity;
}>): EncryptedSmsCredentials {
  let credential:
    | Readonly<{ accessKeyId: string; accessKeySecret: string }>
    | undefined;
  try {
    credential = input.cipher.decrypt({
      ...input.oldIdentity,
      encrypted: input.encrypted,
    });
    return input.cipher.encrypt({
      ...input.newIdentity,
      accessKeyId: credential.accessKeyId,
      accessKeySecret: credential.accessKeySecret,
    });
  } finally {
    credential = undefined;
  }
}
