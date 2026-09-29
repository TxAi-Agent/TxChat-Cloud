import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { withImmediateTransaction, type CoreDatabase } from "../../db/database.js";
import { AdminAccountRepository } from "./adminAccountRepository.js";
import { createAdminSetupSecret } from "./adminPassword.js";

export type CommunityAdminInitialization = Readonly<{
  created: boolean;
  setupFile?: string;
  expiresAt?: string;
}>;

/** Create a short-lived local setup file until the owner creates the first account. */
export function initializeCommunityAdmin(options: Readonly<{
  database: CoreDatabase;
  dataDirectory: string;
  origin: string;
}>): CommunityAdminInitialization {
  const origin = new URL(options.origin);
  if (origin.origin !== options.origin ||
      (origin.protocol !== "https:" &&
       !(origin.protocol === "http:" && origin.hostname === "localhost"))) {
    throw new TypeError("Invalid administrator origin");
  }
  const directory = resolve(options.dataDirectory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Administrator setup directory is invalid");
  }
  const setupFile = join(directory, "administrator-setup.json");
  try {
    const previous = lstatSync(setupFile);
    if (!previous.isFile() || previous.isSymbolicLink() || previous.nlink !== 1) {
      throw new Error("Administrator setup file is invalid");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (options.database.prepare(
    "SELECT 1 FROM admin_accounts WHERE account_kind = 'super_admin' LIMIT 1",
  ).get() !== undefined) {
    try { unlinkSync(setupFile); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return Object.freeze({ created: false });
  }

  const accounts = new AdminAccountRepository(options.database);
  const secret = createAdminSetupSecret();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  const temporary = join(directory, `.administrator-setup-${randomUUID()}.tmp`);
  try {
    return withImmediateTransaction(options.database, () => {
      const token = accounts.issueSetupToken({
        purpose: "initial_superadmin",
        digest: secret.digest,
        now: now.toISOString(),
        expiresAt,
      });
      const url = `${origin.origin}/console/#setup=${token.id}.${secret.material}`;
      writeFileSync(temporary, JSON.stringify({ url, expiresAt }) + "\n", {
        encoding: "utf8", mode: 0o600, flag: "wx",
      });
      renameSync(temporary, setupFile);
      return Object.freeze({ created: true, setupFile, expiresAt });
    });
  } finally {
    secret.digest.fill(0);
    try { unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
