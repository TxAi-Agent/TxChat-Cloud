import { createHash } from "node:crypto";

import { isInternalId } from "../../ids/internalId.js";
import { AdminAccountError } from "./adminAccountRepository.js";
import { hashAdminPassword } from "./adminPassword.js";
import type { AdminPasswordHash } from "./adminTypes.js";

const SETUP_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

function rejected(): never {
  throw new AdminAccountError("ADMIN_SETUP_REJECTED");
}

export function parseAdminSetupMaterial(value: string): Readonly<{
  tokenId: string;
  digest: Buffer;
}> {
  if (typeof value !== "string" || !value.isWellFormed()) rejected();
  const separator = value.indexOf(".");
  if (separator < 0 || separator !== value.lastIndexOf(".")) rejected();
  const tokenId = value.slice(0, separator);
  const material = value.slice(separator + 1);
  if (!isInternalId(tokenId) || !SETUP_SECRET_PATTERN.test(material)) rejected();

  let decoded: Buffer | undefined;
  try {
    decoded = Buffer.from(material, "base64url");
    if (decoded.length !== 32 || decoded.toString("base64url") !== material) {
      rejected();
    }
    return Object.freeze({
      tokenId,
      digest: createHash("sha256").update(decoded).digest(),
    });
  } catch (error) {
    if (error instanceof AdminAccountError) throw error;
    return rejected();
  } finally {
    decoded?.fill(0);
  }
}

export async function deriveAdminSetupPassword(
  value: string,
): Promise<AdminPasswordHash> {
  return hashAdminPassword(value);
}
