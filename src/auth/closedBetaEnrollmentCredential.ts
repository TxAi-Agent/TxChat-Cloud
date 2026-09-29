import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import type { VersionedKeyRing } from "./phoneIdentity.js";

const enrollmentCredentialPattern = /^[A-Za-z0-9_-]{43}$/;
const verifierPattern =
  /^([A-Za-z0-9][A-Za-z0-9._-]{0,63}):([0-9a-f]{64})$/;
const domain = Buffer.from(
  "community-closed-beta-enrollment-v1\0",
  "utf8",
);
const separator = Buffer.from([0]);

export function generateEnrollmentCredential(): string {
  return randomBytes(32).toString("base64url");
}

export function isEnrollmentCredential(value: string): boolean {
  if (!enrollmentCredentialPattern.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, "base64url");
  return (
    decoded.length === 32 && decoded.toString("base64url") === value
  );
}

function verifierBytes(
  phoneLookup: string,
  credential: string,
  key: Buffer,
): Buffer {
  return createHmac("sha256", key)
    .update(domain)
    .update(phoneLookup, "utf8")
    .update(separator)
    .update(credential, "utf8")
    .digest();
}

export function createEnrollmentVerifier(
  phoneLookup: string,
  credential: string,
  keys: VersionedKeyRing,
): string {
  if (!isEnrollmentCredential(credential)) {
    throw new Error("Invalid enrollment credential");
  }
  if (phoneLookup.length === 0) {
    throw new Error("Invalid phone lookup");
  }
  const key = keys.versions.get(keys.activeVersion);
  if (key === undefined || key.length !== 32) {
    throw new Error("Active enrollment verification key is unavailable");
  }
  return `${keys.activeVersion}:${verifierBytes(
    phoneLookup,
    credential,
    key,
  ).toString("hex")}`;
}

export function matchesEnrollmentVerifier(
  storedVerifier: string,
  phoneLookup: string,
  candidate: string,
  keys: VersionedKeyRing,
): boolean {
  if (phoneLookup.length === 0 || !isEnrollmentCredential(candidate)) {
    return false;
  }
  const match = verifierPattern.exec(storedVerifier);
  if (match === null) {
    return false;
  }
  const version = match[1]!;
  const storedHex = match[2]!;
  const key = keys.versions.get(version);
  if (key === undefined || key.length !== 32) {
    return false;
  }
  const storedBytes = Buffer.from(storedHex, "hex");
  if (storedBytes.length !== 32) {
    return false;
  }
  const candidateBytes = verifierBytes(
    phoneLookup,
    candidate,
    key,
  );
  return timingSafeEqual(storedBytes, candidateBytes);
}
