import { randomUUID } from "node:crypto";

import {
  allocateInternalId,
  generateInternalId,
  type InternalIdGenerator,
} from "./internalId.js";

const LEGACY_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * Legacy databases remain readable in build and migration tests. Their old
 * CHECK constraints require UUID entity keys, while every phase-one database
 * requires TxChat internal IDs. This compatibility allocator must never be
 * used to select an identifier format from public input.
 */
export function allocateRuntimeEntityId(
  phaseOneSchema: boolean,
  generate?: InternalIdGenerator,
): string {
  if (phaseOneSchema) {
    return allocateInternalId(generate ?? generateInternalId);
  }
  const candidate = (generate ?? randomUUID)();
  if (
    typeof candidate !== "string" ||
    candidate.length < 1 ||
    candidate.length > 128 ||
    candidate.trim() !== candidate ||
    !candidate.isWellFormed() ||
    /[\u0000-\u001f\u007f]/u.test(candidate)
  ) {
    throw new TypeError("Legacy entity ID generation failed");
  }
  return LEGACY_UUID_PATTERN.test(candidate) ? candidate.toLowerCase() : candidate;
}

export function isLegacyEntityId(value: unknown): value is string {
  return typeof value === "string" && LEGACY_UUID_PATTERN.test(value);
}
