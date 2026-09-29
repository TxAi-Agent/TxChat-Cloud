import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import { readFileSync } from "node:fs";

const mainlandChinaMobile = /^\+861[3-9]\d{9}$/;
const keyVersionId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type VersionedKeyRing = Readonly<{
  activeVersion: string;
  versions: ReadonlyMap<string, Buffer>;
}>;

type KeyRingInput = Readonly<{
  activeVersion: string;
  keys: Readonly<Record<string, Buffer | string>>;
}>;

type LoadKeyRingOptions = Readonly<{
  activeVersion?: string;
  priorVersions?: readonly string[];
}>;

function validateVersionId(version: string): void {
  if (!keyVersionId.test(version)) {
    throw new Error(`Invalid key version: ${version}`);
  }
}

function decodeCanonicalBase64Key(value: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.length !== 32 ||
    decoded.toString("base64") !== value
  ) {
    throw new Error("Key material must be canonical base64 for 32 bytes");
  }
  return decoded;
}

function normalizeKey(value: Buffer | string): Buffer {
  if (Buffer.isBuffer(value)) {
    if (value.length !== 32) {
      throw new Error("Raw key material must be exactly 32 bytes");
    }
    return Buffer.from(value);
  }
  return decodeCanonicalBase64Key(value);
}

export function createVersionedKeyRing(
  input: KeyRingInput,
  priorVersions?: readonly string[],
): VersionedKeyRing {
  validateVersionId(input.activeVersion);
  const normalizedKeys = new Map<string, Buffer>();
  const effectiveVersions = new Map<string, string>();
  for (const [version, material] of Object.entries(input.keys)) {
    validateVersionId(version);
    const normalized = normalizeKey(material);
    const fingerprint = normalized.toString("hex");
    const duplicateVersion = effectiveVersions.get(fingerprint);
    if (duplicateVersion !== undefined) {
      throw new Error(
        `Duplicate effective key material: ${duplicateVersion}, ${version}`,
      );
    }
    effectiveVersions.set(fingerprint, version);
    normalizedKeys.set(version, normalized);
  }
  const active = normalizedKeys.get(input.activeVersion);
  if (active === undefined) {
    throw new Error("Active key version is unavailable");
  }
  const selected = new Map<string, Buffer>();
  selected.set(input.activeVersion, Buffer.from(active));
  const requestedPriorVersions =
    priorVersions ??
    Object.keys(input.keys).filter(
      (version) => version !== input.activeVersion,
    );
  if (
    requestedPriorVersions.includes(input.activeVersion) ||
    new Set(requestedPriorVersions).size !==
      requestedPriorVersions.length
  ) {
    throw new Error("Duplicate key version selection");
  }
  for (const version of requestedPriorVersions) {
    validateVersionId(version);
    const candidate = normalizedKeys.get(version);
    if (candidate === undefined) {
      throw new Error(`Prior key version is unavailable: ${version}`);
    }
    selected.set(version, Buffer.from(candidate));
  }
  const ordered = new Map<string, Buffer>([
    [input.activeVersion, selected.get(input.activeVersion)!],
    ...requestedPriorVersions.map(
      (version) => [version, selected.get(version)!] as const,
    ),
  ]);
  return Object.freeze({
    activeVersion: input.activeVersion,
    versions: ordered,
  });
}

export function loadVersionedKeyRing(
  source: string | Buffer,
  options: LoadKeyRingOptions = {},
): VersionedKeyRing {
  if (Buffer.isBuffer(source) && source.length === 32) {
    const activeVersion = options.activeVersion ?? "v1";
    return createVersionedKeyRing(
      {
        activeVersion,
        keys: { [activeVersion]: source },
      },
      [],
    );
  }
  let text: string;
  try {
    text = Buffer.isBuffer(source)
      ? new TextDecoder("utf-8", { fatal: true }).decode(source)
      : source;
  } catch {
    throw new Error("Key material is not valid UTF-8 text");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const activeVersion = options.activeVersion ?? "v1";
    return createVersionedKeyRing(
      {
        activeVersion,
        keys: { [activeVersion]: text },
      },
      [],
    );
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("activeVersion" in parsed) ||
    !("keys" in parsed) ||
    typeof parsed.activeVersion !== "string" ||
    ("priorVersions" in parsed &&
      (!Array.isArray(parsed.priorVersions) ||
        parsed.priorVersions.some(
          (version) => typeof version !== "string",
        ))) ||
    parsed.keys === null ||
    typeof parsed.keys !== "object" ||
    Array.isArray(parsed.keys) ||
    Object.values(parsed.keys).some(
      (material) => typeof material !== "string",
    ) ||
    Object.keys(parsed).some(
      (field) =>
        !["activeVersion", "priorVersions", "keys"].includes(field),
    )
  ) {
    throw new Error("Invalid versioned key material");
  }
  const activeVersion = options.activeVersion ?? parsed.activeVersion;
  const declaredPriorVersions =
    "priorVersions" in parsed
      ? (parsed.priorVersions as string[])
      : [];
  return createVersionedKeyRing(
    {
      activeVersion,
      keys: parsed.keys as Record<string, string>,
    },
    options.priorVersions ?? declaredPriorVersions,
  );
}

export function loadVersionedKeyRingFile(
  path: string,
  options: LoadKeyRingOptions = {},
): VersionedKeyRing {
  return loadVersionedKeyRing(readFileSync(path), options);
}

function keyForVersion(keys: VersionedKeyRing, version: string): Buffer {
  const key = keys.versions.get(version);
  if (key === undefined) {
    throw new Error(`Unknown key version: ${version}`);
  }
  return key;
}

function activeKey(keys: VersionedKeyRing): Buffer {
  return keyForVersion(keys, keys.activeVersion);
}

export function normalizeMainlandChinaPhone(phone: string): string {
  if (!mainlandChinaMobile.test(phone)) {
    throw new Error("Invalid mainland China phone");
  }
  return phone;
}

function hmacLookup(
  value: string,
  version: string,
  key: Buffer,
): string {
  return `${version}:${createHmac("sha256", key).update(value).digest("hex")}`;
}

export function createPhoneLookupCandidates(
  phone: string,
  keys: VersionedKeyRing,
): readonly string[] {
  const normalized = normalizeMainlandChinaPhone(phone);
  return [...keys.versions.entries()].map(([version, key]) =>
    hmacLookup(normalized, version, key),
  );
}

export function pseudonymizeIp(
  ip: string,
  keys: VersionedKeyRing,
): string {
  if (ip.length === 0) {
    throw new Error("IP address is unavailable");
  }
  return hmacLookup(ip, keys.activeVersion, activeKey(keys));
}

export function createIpLookupCandidates(
  ip: string,
  keys: VersionedKeyRing,
): readonly string[] {
  if (ip.length === 0) {
    throw new Error("IP address is unavailable");
  }
  return [...keys.versions.entries()].map(([version, key]) =>
    hmacLookup(ip, version, key),
  );
}

export function encryptPhone(
  phone: string,
  keys: VersionedKeyRing,
): string {
  const normalized = normalizeMainlandChinaPhone(phone);
  const initializationVector = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    activeKey(keys),
    initializationVector,
  );
  const ciphertext = Buffer.concat([
    cipher.update(normalized, "utf8"),
    cipher.final(),
  ]);
  return [
    keys.activeVersion,
    initializationVector.toString("base64url"),
    ciphertext.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(":");
}

function decryptPhoneBytes(
  envelope: string,
  keys: VersionedKeyRing,
): Buffer {
  const [version, initializationVector, ciphertext, tag, extra] =
    envelope.split(":");
  if (
    version === undefined ||
    initializationVector === undefined ||
    ciphertext === undefined ||
    tag === undefined ||
    extra !== undefined
  ) {
    throw new Error("Invalid encrypted phone");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyForVersion(keys, version),
    Buffer.from(initializationVector, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  const phone = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]);
  if (
    phone.length !== 14 ||
    phone[0] !== 0x2b ||
    phone[1] !== 0x38 ||
    phone[2] !== 0x36 ||
    phone[3] !== 0x31 ||
    phone[4]! < 0x33 ||
    phone[4]! > 0x39 ||
    phone.subarray(5).some((byte) => byte < 0x30 || byte > 0x39)
  ) {
    phone.fill(0);
    throw new Error("Invalid encrypted phone");
  }
  return phone;
}

export function decryptPhone(
  envelope: string,
  keys: VersionedKeyRing,
): string {
  const phone = decryptPhoneBytes(envelope, keys);
  try {
    return phone.toString("utf8");
  } finally {
    phone.fill(0);
  }
}

export function maskEncryptedPhone(
  envelope: string,
  keys: VersionedKeyRing,
): string {
  const phone = decryptPhoneBytes(envelope, keys);
  try {
    return `+86 ${phone.subarray(3, 6).toString("ascii")}****${
      phone.subarray(10, 14).toString("ascii")
    }`;
  } finally {
    phone.fill(0);
  }
}

export function maskAuthenticatedPhone(phone: string): string {
  const normalized = normalizeMainlandChinaPhone(phone);
  return `+86*******${normalized.slice(-4)}`;
}

export function keyVersion(envelope: string): string {
  const separator = envelope.indexOf(":");
  if (separator <= 0) {
    throw new Error("Versioned value is invalid");
  }
  return envelope.slice(0, separator);
}
