import { expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.js";
import { applyPublicSchema } from "../src/db/migrator.js";
import { initializeCommunityAdmin } from "../src/admin/unified/initializeCommunityAdmin.js";
import { AdminAccountRepository } from "../src/admin/unified/adminAccountRepository.js";
import { parseAdminSetupMaterial } from "../src/admin/unified/adminSetupConsumption.js";
import { hashAdminPassword } from "../src/admin/unified/adminPassword.js";

it("uses a private rotating setup link and never replaces an existing administrator", async () => {
  const directory = mkdtempSync(join(tmpdir(), "community-admin-"));
  const database = openDatabase(":memory:");
  try {
    applyPublicSchema(database, "core");
    const options = { database, dataDirectory: directory, origin: "https://example.invalid" };
    const first = initializeCommunityAdmin(options);
    expect(first.created).toBe(true);
    if (process.platform !== "win32") expect(statSync(first.setupFile!).mode & 0o777).toBe(0o600);
    const before = JSON.parse(readFileSync(first.setupFile!, "utf8")) as { url: string; expiresAt: string };
    const firstMaterial = parseAdminSetupMaterial(new URL(before.url).hash.slice("#setup=".length));
    const stored = database.prepare("SELECT token_digest FROM admin_account_setup_tokens WHERE id = ?").get(firstMaterial.tokenId) as { token_digest: Buffer };
    expect(stored.token_digest).toEqual(firstMaterial.digest);
    expect(Date.parse(before.expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000);

    const second = initializeCommunityAdmin(options);
    const after = JSON.parse(readFileSync(second.setupFile!, "utf8")) as { url: string };
    expect(after.url).not.toBe(before.url);
    const old = database.prepare("SELECT consumed_at FROM admin_account_setup_tokens WHERE id = ?").get(firstMaterial.tokenId) as { consumed_at: string | null };
    expect(old.consumed_at).not.toBeNull();
    const current = parseAdminSetupMaterial(new URL(after.url).hash.slice("#setup=".length));
    const password = await hashAdminPassword(randomBytes(24).toString("base64url"));
    try {
      const account = new AdminAccountRepository(database).consumeInitialSuperadmin({
        tokenId: current.tokenId, digest: current.digest, username: randomUUID().replaceAll("-", ""),
        password, now: new Date().toISOString(),
      });
      expect(account.kind).toBe("super_admin");
      expect(initializeCommunityAdmin(options)).toEqual({ created: false });
      expect(existsSync(second.setupFile!)).toBe(false);
      expect(database.prepare("SELECT count(*) AS count FROM admin_accounts").get()).toEqual({ count: 1 });
    } finally {
      password.salt.fill(0); password.digest.fill(0);
      firstMaterial.digest.fill(0); current.digest.fill(0);
    }
  } finally {
    database.close(); rmSync(directory, { recursive: true, force: true });
  }
});

it("rejects an existing symbolic setup file before issuing a token", () => {
  const directory = mkdtempSync(join(tmpdir(), "community-admin-"));
  const database = openDatabase(":memory:");
  try {
    applyPublicSchema(database, "core");
    const target = join(directory, "preserved.txt");
    writeFileSync(target, "unchanged", { mode: 0o600 });
    symlinkSync(target, join(directory, "administrator-setup.json"));
    expect(() => initializeCommunityAdmin({ database, dataDirectory: directory, origin: "https://example.invalid" })).toThrow("Administrator setup file is invalid");
    expect(readFileSync(target, "utf8")).toBe("unchanged");
    expect(database.prepare("SELECT count(*) AS count FROM admin_account_setup_tokens").get()).toEqual({ count: 0 });
  } finally {
    database.close(); rmSync(directory, { recursive: true, force: true });
  }
});
