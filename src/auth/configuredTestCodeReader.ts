import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  type Stats,
} from "node:fs";
import { resolve } from "node:path";

import { normalizeMainlandChinaPhone } from "./phoneIdentity.js";

const MAX_CONFIG_BYTES = 1024 * 1024;
const MIN_CLOSED_BETA_ACCOUNT_COUNT = 1;
const MAX_CLOSED_BETA_ACCOUNT_COUNT = 64;
const CLOSED_BETA_LOGIN_CODE_PATTERN = /^\d{6}$/u;

export class ConfiguredTestCodeConfigurationError extends Error {
  constructor() {
    super("Configured internal-test login data is unavailable");
    this.name = "ConfiguredTestCodeConfigurationError";
  }
}

export type ConfiguredTestCodeReader = Readonly<{
  readCode(phone: string): string | undefined;
}>;

function fail(): never {
  throw new ConfiguredTestCodeConfigurationError();
}

function identity(stats: Stats): string {
  return [
    stats.dev,
    stats.ino,
    stats.uid,
    stats.mode,
    stats.nlink,
    stats.size,
    stats.ctimeMs,
    stats.mtimeMs,
  ].join(":");
}

function validateStats(stats: Stats, currentUid: number): void {
  if (
    !stats.isFile() ||
    stats.nlink !== 1 ||
    stats.uid !== currentUid ||
    (stats.mode & 0o777) !== 0o600 ||
    stats.size <= 0 ||
    stats.size > MAX_CONFIG_BYTES
  ) {
    fail();
  }
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}

function rejectDuplicateObjectKeys(serialized: string): void {
  let offset = 0;
  const whitespace = /\s/u;

  const skipWhitespace = (): void => {
    while (offset < serialized.length && whitespace.test(serialized[offset]!)) {
      offset += 1;
    }
  };
  const parseString = (): string => {
    if (serialized[offset] !== '"') fail();
    const start = offset;
    offset += 1;
    let escaped = false;
    while (offset < serialized.length) {
      const character = serialized[offset]!;
      offset += 1;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        try {
          return JSON.parse(serialized.slice(start, offset)) as string;
        } catch {
          fail();
        }
      }
    }
    fail();
  };
  const parseValue = (): void => {
    skipWhitespace();
    const character = serialized[offset];
    if (character === "{") {
      offset += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (serialized[offset] === "}") {
        offset += 1;
        return;
      }
      while (offset < serialized.length) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) fail();
        keys.add(key);
        skipWhitespace();
        if (serialized[offset] !== ":") fail();
        offset += 1;
        parseValue();
        skipWhitespace();
        if (serialized[offset] === "}") {
          offset += 1;
          return;
        }
        if (serialized[offset] !== ",") fail();
        offset += 1;
      }
      fail();
    }
    if (character === "[") {
      offset += 1;
      skipWhitespace();
      if (serialized[offset] === "]") {
        offset += 1;
        return;
      }
      while (offset < serialized.length) {
        parseValue();
        skipWhitespace();
        if (serialized[offset] === "]") {
          offset += 1;
          return;
        }
        if (serialized[offset] !== ",") fail();
        offset += 1;
      }
      fail();
    }
    if (character === '"') {
      parseString();
      return;
    }
    const primitive = serialized.slice(offset).match(
      /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u,
    )?.[0];
    if (primitive === undefined) fail();
    offset += primitive.length;
  };

  parseValue();
  skipWhitespace();
  if (offset !== serialized.length) fail();
}

function parseEntries(serialized: string): ReadonlyMap<string, string> {
  rejectDuplicateObjectKeys(serialized);
  let document: unknown;
  try {
    document = JSON.parse(serialized);
  } catch {
    fail();
  }
  if (
    document === null ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    !exactKeys(document as Record<string, unknown>, ["entries", "schemaVersion"])
  ) {
    fail();
  }
  const root = document as Record<string, unknown>;
  if (
    root.schemaVersion !== 1 ||
    !Array.isArray(root.entries) ||
    root.entries.length < MIN_CLOSED_BETA_ACCOUNT_COUNT ||
    root.entries.length > MAX_CLOSED_BETA_ACCOUNT_COUNT
  ) {
    fail();
  }

  const result = new Map<string, string>();
  for (const rawEntry of root.entries) {
    if (
      rawEntry === null ||
      typeof rawEntry !== "object" ||
      Array.isArray(rawEntry) ||
      !exactKeys(
        rawEntry as Record<string, unknown>,
        ["enrollmentCredential", "phone"],
      )
    ) {
      fail();
    }
    const entry = rawEntry as Record<string, unknown>;
    if (
      typeof entry.phone !== "string" ||
      typeof entry.enrollmentCredential !== "string" ||
      !CLOSED_BETA_LOGIN_CODE_PATTERN.test(entry.enrollmentCredential)
    ) {
      fail();
    }
    let phone: string;
    try {
      phone = normalizeMainlandChinaPhone(entry.phone);
    } catch {
      fail();
    }
    if (phone !== entry.phone || result.has(phone)) {
      fail();
    }
    result.set(phone, entry.enrollmentCredential);
  }
  return result;
}

export class JsonFileConfiguredTestCodeReader
implements ConfiguredTestCodeReader {
  private readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  readCode(phone: string): string | undefined {
    return this.readEntries().get(phone);
  }

  validate(): void {
    void this.readEntries();
  }

  private readEntries(): ReadonlyMap<string, string> {
    if (
      typeof constants.O_NOFOLLOW !== "number" ||
      constants.O_NOFOLLOW === 0 ||
      typeof process.getuid !== "function"
    ) {
      fail();
    }
    const currentUid = process.getuid();
    if (!Number.isSafeInteger(currentUid) || currentUid < 0) {
      fail();
    }

    let descriptor: number | undefined;
    let buffer: Buffer | undefined;
    try {
      descriptor = openSync(
        this.path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const before = fstatSync(descriptor);
      validateStats(before, currentUid);
      buffer = Buffer.alloc(before.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const bytesRead = readSync(
          descriptor,
          buffer,
          offset,
          buffer.length - offset,
          null,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const after = fstatSync(descriptor);
      validateStats(after, currentUid);
      if (
        identity(after) !== identity(before) ||
        offset !== before.size
      ) {
        fail();
      }
      return parseEntries(buffer.subarray(0, offset).toString("utf8"));
    } catch (error) {
      if (error instanceof ConfiguredTestCodeConfigurationError) {
        throw error;
      }
      return fail();
    } finally {
      buffer?.fill(0);
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // The request has already failed closed or completed its read.
        }
      }
    }
  }
}
