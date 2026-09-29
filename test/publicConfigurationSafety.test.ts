import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadConfig, type AppConfig, type SecretFilePurpose } from "../src/config.js";
import { createConfiguredApplication } from "../src/server.js";

it("does not include malformed key material in configuration errors", () => {
  const directory = mkdtempSync(join(tmpdir(), "community-config-"));
  try {
    const config = loadConfig({ COMMUNITY_DATA_DIRECTORY: directory });
    const material = randomBytes(24).toString("hex");
    writeFileSync(join(directory, "application-keys.json"), material, { mode: 0o600 });
    let failure: unknown;
    try { config.withSecretFile("jwtSigning", () => undefined); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure).includes(material)).toBe(false);
    expect(String(failure)).toContain("Community configuration is invalid or unavailable");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


it("does not expose malformed administrator origin input on errors", () => {
  const marker = randomBytes(24).toString("hex");
  let failure: unknown;
  try { loadConfig({ COMMUNITY_ADMIN_ORIGIN: marker }); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure).includes(marker)).toBe(false);
  expect(JSON.stringify(failure).includes(marker)).toBe(false);
  expect(String(failure)).toContain("Community configuration is invalid or unavailable");
});

it.each(["phoneEncryption", "contentEncryption", "smsConfiguration"] as const)(
  "clears already loaded key rings when reading %s fails", async (failingPurpose) => {
    const directory = mkdtempSync(join(tmpdir(), "community-config-"));
    const retained: Buffer[] = [];
    try {
      const base = loadConfig({ COMMUNITY_DATA_DIRECTORY: directory });
      const config: AppConfig = { ...base, withSecretFile<T>(purpose: SecretFilePurpose, consumer: (source: Buffer) => T): T {
        if (purpose === failingPurpose) throw new Error("Simulated unreadable secret file");
        return base.withSecretFile(purpose, (source) => {
          const result = consumer(source);
          if (result && typeof result === "object" && "versions" in result && result.versions instanceof Map) {
            retained.push(...result.versions.values());
          }
          return result;
        });
      } };
      await expect(createConfiguredApplication({ config })).rejects.toThrow("Simulated unreadable secret file");
      expect(retained.length > 0).toBe(true);
      expect(retained.every((buffer) => buffer.every((byte) => byte === 0))).toBe(true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  },
);

it("clears all loaded rings when key-purpose separation fails", async () => {
  const directory = mkdtempSync(join(tmpdir(), "community-config-"));
  const retained: Buffer[] = [];
  try {
    const base = loadConfig({ COMMUNITY_DATA_DIRECTORY: directory });
    const config: AppConfig = { ...base, withSecretFile<T>(purpose: SecretFilePurpose, consumer: (source: Buffer) => T): T {
      return base.withSecretFile(purpose === "phoneLookup" ? "jwtSigning" : purpose, (source) => {
        const result = consumer(source);
        if (result && typeof result === "object" && "versions" in result && result.versions instanceof Map) retained.push(...result.versions.values());
        return result;
      });
    } };
    await expect(createConfiguredApplication({ config })).rejects.toThrow("Duplicate effective application key material");
    expect(retained.length).toBe(9);
    expect(retained.every((buffer) => buffer.every((byte) => byte === 0))).toBe(true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
