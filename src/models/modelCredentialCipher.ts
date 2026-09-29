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
import type {
  EncryptedModelCredential,
  ModelCapability,
  RuntimeProviderKind,
} from "./modelTypes.js";

const NONCE_BYTES = 12;
const AUTHENTICATION_TAG_BYTES = 16;
const KEY_BYTES = 32;
const CREDENTIAL_UNAVAILABLE = "CREDENTIAL_UNAVAILABLE" as const;
const KEY_RING_FIELDS = new Set([
  "activeVersion",
  "priorVersions",
  "keys",
]);

export type ModelCredentialIdentity = Readonly<{
  configurationId: string;
  capability: ModelCapability;
  providerKind: RuntimeProviderKind;
  revision: number;
}>;

export class ModelCredentialError extends Error {
  readonly code = CREDENTIAL_UNAVAILABLE;

  constructor(code: typeof CREDENTIAL_UNAVAILABLE) {
    super(code);
    this.name = "ModelCredentialError";
  }
}

function unavailable(): never {
  throw new ModelCredentialError(CREDENTIAL_UNAVAILABLE);
}

function hasStrictVersionedJsonShape(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.hasOwn(value, "activeVersion") &&
    Object.hasOwn(value, "priorVersions") &&
    Object.hasOwn(value, "keys") &&
    Object.keys(value).every((field) => KEY_RING_FIELDS.has(field))
  );
}

function hasSameVersionSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const rightVersions = new Set(right);
  return (
    left.length === right.length &&
    rightVersions.size === right.length &&
    left.every((version) => rightVersions.has(version))
  );
}

export function loadModelCredentialKeyRing(
  source: string | Buffer,
): VersionedKeyRing {
  try {
    const text = Buffer.isBuffer(source)
      ? new TextDecoder("utf-8", { fatal: true }).decode(source)
      : source;
    const parsed: unknown = JSON.parse(text);
    if (!hasStrictVersionedJsonShape(parsed)) {
      unavailable();
    }
    const ring = loadVersionedKeyRing(text);
    const declared = parsed as {
      activeVersion: string;
      priorVersions: string[];
      keys: Record<string, string>;
    };
    const declaredSelection = [
      declared.activeVersion,
      ...declared.priorVersions,
    ];
    const declaredKeys = Object.keys(declared.keys);
    const loadedVersions = [...ring.versions.keys()];
    if (
      !hasSameVersionSet(declaredKeys, declaredSelection) ||
      !hasSameVersionSet(declaredKeys, loadedVersions)
    ) {
      unavailable();
    }
    return ring;
  } catch {
    unavailable();
  }
}

function copyKeyRing(keys: VersionedKeyRing): VersionedKeyRing {
  const entries = [...keys.versions.entries()];
  const priorVersions = entries
    .map(([version]) => version)
    .filter((version) => version !== keys.activeVersion);
  return createVersionedKeyRing(
    {
      activeVersion: keys.activeVersion,
      keys: Object.fromEntries(entries),
    },
    priorVersions,
  );
}

function validateIdentity(input: ModelCredentialIdentity): void {
  if (
    typeof input.configurationId !== "string" ||
    input.configurationId.length === 0 ||
    !input.configurationId.isWellFormed() ||
    input.capability !== "realtime-asr" ||
    (input.providerKind !== "bailian-qwen-realtime" &&
      input.providerKind !== "bailian-streaming-asr") ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 1
  ) {
    unavailable();
  }
}

function additionalAuthenticatedData(
  input: ModelCredentialIdentity,
): Buffer {
  return Buffer.from(
    JSON.stringify({
      capability: input.capability,
      configurationId: input.configurationId,
      providerKind: input.providerKind,
      revision: input.revision,
    }),
    "utf8",
  );
}

function validateEncryptedCredential(
  encrypted: EncryptedModelCredential,
): void {
  if (
    encrypted === null ||
    typeof encrypted !== "object" ||
    typeof encrypted.keyVersion !== "string" ||
    encrypted.keyVersion.length === 0 ||
    !Buffer.isBuffer(encrypted.nonce) ||
    encrypted.nonce.length !== NONCE_BYTES ||
    !Buffer.isBuffer(encrypted.ciphertext) ||
    encrypted.ciphertext.length === 0 ||
    !Buffer.isBuffer(encrypted.tag) ||
    encrypted.tag.length !== AUTHENTICATION_TAG_BYTES
  ) {
    unavailable();
  }
}

export class ModelCredentialCipher {
  readonly #keys: VersionedKeyRing;
  #disposed = false;

  constructor(keys: VersionedKeyRing) {
    try {
      this.#keys = copyKeyRing(keys);
    } catch {
      throw new ModelCredentialError(CREDENTIAL_UNAVAILABLE);
    }
  }

  encrypt(input: {
    configurationId: string;
    capability: ModelCapability;
    providerKind: RuntimeProviderKind;
    revision: number;
    credential: string;
  }): EncryptedModelCredential {
    let plaintext: Buffer | undefined;
    let aad: Buffer | undefined;
    let key: Buffer | undefined;
    let nonce: Buffer | undefined;
    let ciphertextStart: Buffer | undefined;
    let ciphertextEnd: Buffer | undefined;
    let ciphertext: Buffer | undefined;
    let tag: Buffer | undefined;
    try {
      if (this.#disposed) {
        unavailable();
      }
      validateIdentity(input);
      if (
        typeof input.credential !== "string" ||
        input.credential.length === 0 ||
        !input.credential.isWellFormed()
      ) {
        unavailable();
      }
      plaintext = Buffer.from(input.credential, "utf8");
      if (plaintext.length === 0) {
        unavailable();
      }

      const keyVersion = this.#keys.activeVersion;
      const storedKey = this.#keys.versions.get(keyVersion);
      if (storedKey === undefined || storedKey.length !== KEY_BYTES) {
        unavailable();
      }
      key = Buffer.from(storedKey);
      nonce = randomBytes(NONCE_BYTES);
      aad = additionalAuthenticatedData(input);

      const cipher = createCipheriv("aes-256-gcm", key, nonce, {
        authTagLength: AUTHENTICATION_TAG_BYTES,
      });
      cipher.setAAD(aad);
      ciphertextStart = cipher.update(plaintext);
      ciphertextEnd = cipher.final();
      ciphertext = Buffer.concat([ciphertextStart, ciphertextEnd]);
      tag = cipher.getAuthTag();

      return Object.freeze({
        keyVersion,
        nonce: Buffer.from(nonce),
        ciphertext: Buffer.from(ciphertext),
        tag: Buffer.from(tag),
      });
    } catch {
      throw new ModelCredentialError(CREDENTIAL_UNAVAILABLE);
    } finally {
      plaintext?.fill(0);
      aad?.fill(0);
      key?.fill(0);
      nonce?.fill(0);
      ciphertextStart?.fill(0);
      ciphertextEnd?.fill(0);
      ciphertext?.fill(0);
      tag?.fill(0);
    }
  }

  decrypt(input: {
    configurationId: string;
    capability: ModelCapability;
    providerKind: RuntimeProviderKind;
    revision: number;
    encrypted: EncryptedModelCredential;
  }): string {
    let key: Buffer | undefined;
    let nonce: Buffer | undefined;
    let ciphertext: Buffer | undefined;
    let tag: Buffer | undefined;
    let aad: Buffer | undefined;
    let plaintextStart: Buffer | undefined;
    let plaintextEnd: Buffer | undefined;
    let plaintext: Buffer | undefined;
    try {
      if (this.#disposed) {
        unavailable();
      }
      validateIdentity(input);
      validateEncryptedCredential(input.encrypted);

      const storedKey = this.#keys.versions.get(
        input.encrypted.keyVersion,
      );
      if (storedKey === undefined || storedKey.length !== KEY_BYTES) {
        unavailable();
      }
      key = Buffer.from(storedKey);
      nonce = Buffer.from(input.encrypted.nonce);
      ciphertext = Buffer.from(input.encrypted.ciphertext);
      tag = Buffer.from(input.encrypted.tag);
      aad = additionalAuthenticatedData(input);

      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        nonce,
        { authTagLength: AUTHENTICATION_TAG_BYTES },
      );
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      plaintextStart = decipher.update(ciphertext);
      plaintextEnd = decipher.final();
      plaintext = Buffer.concat([plaintextStart, plaintextEnd]);
      return plaintext.toString("utf8");
    } catch {
      throw new ModelCredentialError(CREDENTIAL_UNAVAILABLE);
    } finally {
      key?.fill(0);
      nonce?.fill(0);
      ciphertext?.fill(0);
      tag?.fill(0);
      aad?.fill(0);
      plaintextStart?.fill(0);
      plaintextEnd?.fill(0);
      plaintext?.fill(0);
    }
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    for (const material of this.#keys.versions.values()) {
      material.fill(0);
    }
  }
}

export function rebindModelCredential(input: Readonly<{
  cipher: ModelCredentialCipher;
  encrypted: EncryptedModelCredential;
  oldIdentity: ModelCredentialIdentity;
  newIdentity: ModelCredentialIdentity;
}>): EncryptedModelCredential {
  let credential: string | undefined;
  try {
    credential = input.cipher.decrypt({
      ...input.oldIdentity,
      encrypted: input.encrypted,
    });
    return input.cipher.encrypt({
      ...input.newIdentity,
      credential,
    });
  } finally {
    credential = undefined;
  }
}
