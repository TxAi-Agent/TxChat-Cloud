import { randomBytes as nodeRandomBytes } from "node:crypto";

export const INTERNAL_ID_ALPHABET =
  "0123456789ABCDEFGHJKMNPQRSTVWXYZ" as const;
export const INTERNAL_ID_PATTERN =
  /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{32}$/u;

export const INTERNAL_ID_SQL_CHECK =
  "length(id) = 32 AND id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'";

type RandomBytes = (size: number) => Buffer;

export type InternalIdGenerator = () => string;

export class InternalIdAllocationError extends Error {
  constructor() {
    super("Internal ID allocation failed");
    this.name = "InternalIdAllocationError";
  }
}

export function isInternalId(value: unknown): value is string {
  return typeof value === "string" && INTERNAL_ID_PATTERN.test(value);
}

export function generateInternalId(
  randomBytes: RandomBytes = nodeRandomBytes,
): string {
  const source = randomBytes(20);
  if (!Buffer.isBuffer(source) || source.length !== 20) {
    throw new TypeError("Internal ID randomness is unavailable");
  }

  try {
    let value = 0n;
    for (const byte of source) {
      value = (value << 8n) | BigInt(byte);
    }

    let result = "";
    for (let position = 31; position >= 0; position -= 1) {
      const shift = BigInt(position * 5);
      result += INTERNAL_ID_ALPHABET[Number((value >> shift) & 31n)]!;
    }

    if (!isInternalId(result)) {
      throw new TypeError("Internal ID generation failed");
    }
    return result;
  } finally {
    source.fill(0);
  }
}

export function allocateInternalId(
  generate: InternalIdGenerator = generateInternalId,
): string {
  const candidate = generate();
  if (!isInternalId(candidate)) {
    throw new TypeError("Internal ID generation failed");
  }
  return candidate;
}

export function nextUniqueInternalId(input: Readonly<{
  generate?: () => string;
  insert(id: string): "inserted" | "collision";
}>): string {
  const generate = input.generate ?? generateInternalId;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = generate();
    if (!isInternalId(candidate)) {
      throw new TypeError("Invalid generated internal ID");
    }
    if (input.insert(candidate) === "inserted") {
      return candidate;
    }
  }
  throw new InternalIdAllocationError();
}
