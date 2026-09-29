import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { readFileSync } from "node:fs";

import {
  loadVersionedKeyRing,
  type VersionedKeyRing,
} from "../auth/phoneIdentity.js";
import {
  type ContentDatabase,
  withImmediateTransaction,
} from "../db/database.js";
import type { InternalIdGenerator } from "../ids/internalId.js";
import { allocateRuntimeEntityId } from "../ids/runtimeEntityId.js";

const NONCE_BYTES = 12;
const AUTHENTICATION_TAG_BYTES = 16;
const MAXIMUM_RETENTION_DAYS = 180;
const MILLISECONDS_PER_DAY = 86_400_000;
const MAXIMUM_REQUEST_ID_BYTES = 256;

type ContentFieldName = "rawTranscript" | "finalText";

export type ContentEncryptionKeyRing = VersionedKeyRing;

export type EncryptedContentField = Readonly<{
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}>;

export type EncryptedContentPair = Readonly<{
  requestId: string;
  keyVersion: string;
  rawTranscript: EncryptedContentField;
  finalText: EncryptedContentField;
}>;

export type DecryptedContentPair = Readonly<{
  rawTranscript: string;
  finalText: string;
}>;

export type StoreEncryptedContentPairInput = Readonly<{
  database: ContentDatabase;
  cipher: Pick<ContentCipher, "encryptPair">;
  requestId: string;
  rawTranscript: string;
  finalText: string;
  completedAt: Date;
  retentionDays: number;
  internalId?: InternalIdGenerator;
}>;

export type StoredContentMetadata = Readonly<{
  requestId: string;
  keyVersion: string;
  completedAt: Date;
  expiresAt: Date;
}>;

function copyKeyRing(keys: ContentEncryptionKeyRing): ContentEncryptionKeyRing {
  const versions = new Map<string, Buffer>();
  for (const [version, material] of keys.versions) {
    versions.set(version, Buffer.from(material));
  }
  if (!versions.has(keys.activeVersion)) {
    throw new Error("Active content key is unavailable");
  }
  return Object.freeze({
    activeVersion: keys.activeVersion,
    versions,
  });
}

function validateRequestId(requestId: string): void {
  const length = Buffer.byteLength(requestId, "utf8");
  if (length === 0 || length > MAXIMUM_REQUEST_ID_BYTES) {
    throw new Error("Invalid content request identifier");
  }
}

function additionalAuthenticatedData(
  requestId: string,
  field: ContentFieldName,
  keyVersion: string,
): Buffer {
  return Buffer.from(`${requestId}:${field}:${keyVersion}`, "utf8");
}

function encryptField(
  plaintext: Buffer,
  key: Buffer,
  nonce: Buffer,
  aad: Buffer,
): EncryptedContentField {
  const cipher = createCipheriv("aes-256-gcm", key, nonce, {
    authTagLength: AUTHENTICATION_TAG_BYTES,
  });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
  ]);
  return Object.freeze({
    nonce: Buffer.from(nonce),
    ciphertext,
    tag: cipher.getAuthTag(),
  });
}

function decryptField(
  encrypted: EncryptedContentField,
  key: Buffer,
  aad: Buffer,
): Buffer {
  if (
    encrypted.nonce.length !== NONCE_BYTES ||
    encrypted.tag.length !== AUTHENTICATION_TAG_BYTES ||
    encrypted.ciphertext.length === 0
  ) {
    throw new Error("Invalid encrypted content");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    encrypted.nonce,
    { authTagLength: AUTHENTICATION_TAG_BYTES },
  );
  decipher.setAAD(aad);
  decipher.setAuthTag(encrypted.tag);
  return Buffer.concat([
    decipher.update(encrypted.ciphertext),
    decipher.final(),
  ]);
}

function clearEncryptedPair(pair: EncryptedContentPair): void {
  pair.rawTranscript.nonce.fill(0);
  pair.rawTranscript.ciphertext.fill(0);
  pair.rawTranscript.tag.fill(0);
  pair.finalText.nonce.fill(0);
  pair.finalText.ciphertext.fill(0);
  pair.finalText.tag.fill(0);
}

export function loadContentEncryptionKeyRing(
  source: string | Buffer,
): ContentEncryptionKeyRing {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.isBuffer(source)
        ? new TextDecoder("utf-8", { fatal: true }).decode(source)
        : source,
    );
  } catch {
    throw new Error("Content key file must be versioned JSON");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !Object.hasOwn(parsed, "activeVersion") ||
    !Object.hasOwn(parsed, "priorVersions") ||
    !Object.hasOwn(parsed, "keys")
  ) {
    throw new Error("Content key file must declare key versions");
  }
  return loadVersionedKeyRing(source);
}

export function loadContentEncryptionKeyRingFile(
  path: string,
): ContentEncryptionKeyRing {
  const source = readFileSync(path);
  try {
    return loadContentEncryptionKeyRing(source);
  } finally {
    source.fill(0);
  }
}

export class ContentCipher {
  readonly #keys: ContentEncryptionKeyRing;

  constructor(keys: ContentEncryptionKeyRing) {
    this.#keys = copyKeyRing(keys);
  }

  encryptPair(input: {
    requestId: string;
    rawTranscript: string;
    finalText: string;
  }): EncryptedContentPair {
    validateRequestId(input.requestId);
    const rawPlaintext = Buffer.from(input.rawTranscript, "utf8");
    const finalPlaintext = Buffer.from(input.finalText, "utf8");
    if (rawPlaintext.length === 0 || finalPlaintext.length === 0) {
      rawPlaintext.fill(0);
      finalPlaintext.fill(0);
      throw new Error("Content fields must be non-empty");
    }

    const keyVersion = this.#keys.activeVersion;
    const key = this.#keys.versions.get(keyVersion);
    if (key === undefined || key.length !== 32) {
      rawPlaintext.fill(0);
      finalPlaintext.fill(0);
      throw new Error("Content encryption is unavailable");
    }
    const rawNonce = randomBytes(NONCE_BYTES);
    let finalNonce = randomBytes(NONCE_BYTES);
    while (finalNonce.equals(rawNonce)) {
      finalNonce.fill(0);
      finalNonce = randomBytes(NONCE_BYTES);
    }
    const rawAad = additionalAuthenticatedData(
      input.requestId,
      "rawTranscript",
      keyVersion,
    );
    const finalAad = additionalAuthenticatedData(
      input.requestId,
      "finalText",
      keyVersion,
    );

    try {
      return Object.freeze({
        requestId: input.requestId,
        keyVersion,
        rawTranscript: encryptField(
          rawPlaintext,
          key,
          rawNonce,
          rawAad,
        ),
        finalText: encryptField(
          finalPlaintext,
          key,
          finalNonce,
          finalAad,
        ),
      });
    } catch {
      throw new Error("Content encryption failed");
    } finally {
      rawPlaintext.fill(0);
      finalPlaintext.fill(0);
      rawNonce.fill(0);
      finalNonce.fill(0);
      rawAad.fill(0);
      finalAad.fill(0);
    }
  }

  decryptPair(pair: EncryptedContentPair): DecryptedContentPair {
    let rawPlaintext: Buffer | undefined;
    let finalPlaintext: Buffer | undefined;
    let rawAad: Buffer | undefined;
    let finalAad: Buffer | undefined;
    try {
      validateRequestId(pair.requestId);
      const key = this.#keys.versions.get(pair.keyVersion);
      if (key === undefined || key.length !== 32) {
        throw new Error("Unknown content key");
      }
      rawAad = additionalAuthenticatedData(
        pair.requestId,
        "rawTranscript",
        pair.keyVersion,
      );
      finalAad = additionalAuthenticatedData(
        pair.requestId,
        "finalText",
        pair.keyVersion,
      );
      rawPlaintext = decryptField(
        pair.rawTranscript,
        key,
        rawAad,
      );
      finalPlaintext = decryptField(pair.finalText, key, finalAad);
      return Object.freeze({
        rawTranscript: rawPlaintext.toString("utf8"),
        finalText: finalPlaintext.toString("utf8"),
      });
    } catch {
      throw new Error("Content decryption failed");
    } finally {
      rawPlaintext?.fill(0);
      finalPlaintext?.fill(0);
      rawAad?.fill(0);
      finalAad?.fill(0);
    }
  }
}

function retentionWindow(
  completedAt: Date,
  retentionDays: number,
): { completedAt: Date; expiresAt: Date } {
  const completedMilliseconds = completedAt.getTime();
  if (!Number.isFinite(completedMilliseconds)) {
    throw new Error("Invalid content completion time");
  }
  if (
    !Number.isInteger(retentionDays) ||
    retentionDays < 1 ||
    !Number.isFinite(retentionDays)
  ) {
    throw new Error("Invalid content retention days");
  }
  const configuredDays = Math.min(
    retentionDays,
    MAXIMUM_RETENTION_DAYS,
  );
  const expiresAt = new Date(
    completedMilliseconds + configuredDays * MILLISECONDS_PER_DAY,
  );
  if (!Number.isFinite(expiresAt.getTime())) {
    throw new Error("Invalid content expiry time");
  }
  return {
    completedAt: new Date(completedMilliseconds),
    expiresAt,
  };
}

export function storeEncryptedContentPair(
  input: StoreEncryptedContentPairInput,
): StoredContentMetadata {
  const window = retentionWindow(
    input.completedAt,
    input.retentionDays,
  );
  const pair = input.cipher.encryptPair({
    requestId: input.requestId,
    rawTranscript: input.rawTranscript,
    finalText: input.finalText,
  });
  try {
    const phaseOneSchema = (
      input.database.prepare("PRAGMA table_info(dictation_contents)").all() as Array<{
        name: string;
      }>
    ).some(({ name }) => name === "request_ref");
    const contentId = phaseOneSchema
      ? allocateRuntimeEntityId(true, input.internalId)
      : pair.requestId;
    withImmediateTransaction(input.database, () => {
      input.database
        .prepare(
          `INSERT INTO dictation_contents (
            ${phaseOneSchema ? "id, request_ref" : "request_id"}, key_version,
            raw_nonce, raw_ciphertext, raw_tag,
            final_nonce, final_ciphertext, final_tag,
            completed_at, expires_at, deleted_at
          ) VALUES (${phaseOneSchema ? "?," : ""} ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          ...(phaseOneSchema ? [contentId] : []),
          pair.requestId,
          pair.keyVersion,
          pair.rawTranscript.nonce,
          pair.rawTranscript.ciphertext,
          pair.rawTranscript.tag,
          pair.finalText.nonce,
          pair.finalText.ciphertext,
          pair.finalText.tag,
          window.completedAt.toISOString(),
          window.expiresAt.toISOString(),
        );
    });
  } finally {
    clearEncryptedPair(pair);
  }
  return Object.freeze({
    requestId: pair.requestId,
    keyVersion: pair.keyVersion,
    completedAt: window.completedAt,
    expiresAt: window.expiresAt,
  });
}
