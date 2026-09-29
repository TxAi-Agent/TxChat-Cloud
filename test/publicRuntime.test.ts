import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createConfiguredApplication } from "../src/server.js";
import { openDatabase } from "../src/db/database.js";
import { applyPublicSchema } from "../src/db/migrator.js";

const directories: string[] = [];
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "community-runtime-"));
  directories.push(path);
  return path;
}
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("community runtime", () => {
  it("starts an empty database with the real admin and fails closed when services are unconfigured", async () => {
    const dataDirectory = directory();
    const config = loadConfig({ COMMUNITY_DATA_DIRECTORY: dataDirectory });
    const app = await createConfiguredApplication({ config });
    try {
      const live = await app.dataApp.inject({ url: "/api/community/health/live" });
      expect(live.statusCode).toBe(200);
      const ready = await app.dataApp.inject({ url: "/api/community/health/ready" });
      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toMatchObject({ databases: true, migrations: true, configuredLogin: false });
      const admin = await app.adminApp.inject({ url: "/console/" });
      expect(admin.statusCode).toBe(200);
      const phone = `+86139${String(randomBytes(4).readUInt32BE() % 100000000).padStart(8, "0")}`;
      const sms = await app.dataApp.inject({ method: "POST", url: "/api/community/v1/auth/sms/send", payload: { phone } });
      expect(sms.statusCode).toBe(503);
      expect(sms.json().code).toBe("SMS_PROVIDER_UNAVAILABLE");
      expect(app.database.prepare("SELECT COUNT(*) AS count FROM users").get()).toEqual({ count: 0 });
      expect(app.database.prepare("SELECT COUNT(*) AS count FROM admin_accounts").get()).toEqual({ count: 0 });
      expect(app.database.prepare("SELECT COUNT(*) AS count FROM billing_orders").get()).toEqual({ count: 0 });
      expect(config.billing).toMatchObject({ salesAvailable: false, enforcementMode: "enforce", paymentMode: "disabled" });
      expect(existsSync(join(dataDirectory, "administrator-setup.json"))).toBe(true);
    } finally { await app.close(); }
  });

  it("persists independent encryption keys across restarts and never exposes them through configuration serialization", async () => {
    const dataDirectory = directory();
    const first = loadConfig({ COMMUNITY_DATA_DIRECTORY: dataDirectory });
    const fingerprint = first.withSecretFile("jwtSigning", (source) => source.toString("base64"));
    const app = await createConfiguredApplication({ config: first });
    await app.close();
    const second = loadConfig({ COMMUNITY_DATA_DIRECTORY: dataDirectory });
    expect(second.withSecretFile("jwtSigning", (source) => source.toString("base64")) === fingerprint).toBe(true);
    const keyFile = join(dataDirectory, "application-keys.json");
    const bundle = JSON.parse(readFileSync(keyFile, "utf8")) as Record<string, { keys: { v1: string } }>;
    const all = Object.values(bundle).map((ring) => ring.keys.v1);
    expect(new Set(all).size).toBe(9);
    expect(all.every((key) => Buffer.from(key, "base64").length === 32)).toBe(true);
    expect(all.some((key) => JSON.stringify(second).includes(key))).toBe(false);
    if (process.platform !== "win32") expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    const restarted = await createConfiguredApplication({ config: second });
    await restarted.close();
    rmSync(keyFile);
    expect(() => loadConfig({ COMMUNITY_DATA_DIRECTORY: dataDirectory })).toThrow(/keys are missing/);
  });

  it("preserves a real verified session across restart, refreshes it, and revokes it on logout", async () => {
    const dataDirectory = directory();
    const config = loadConfig({ COMMUNITY_DATA_DIRECTORY: dataDirectory });
    let verificationCode = "";
    const smsTransport = { send: async (request: { code: string }) => {
      verificationCode = request.code;
      return { kind: "accepted" as const };
    } };
    const first = await createConfiguredApplication({ config, smsTransport });
    let accessToken = "";
    let refreshToken = "";
    let accountId = "";
    try {
      const phone = `+86139${String(randomBytes(4).readUInt32BE() % 100000000).padStart(8, "0")}`;
      const sent = await first.dataApp.inject({ method: "POST", url: "/api/community/v1/auth/sms/send", payload: { phone } });
      expect(sent.statusCode).toBe(200);
      expect(/^\d{6}$/.test(verificationCode)).toBe(true);
      const verified = await first.dataApp.inject({ method: "POST", url: "/api/community/v1/auth/sms/verify", payload: {
        challengeId: sent.json().challengeId, verificationCode,
      } });
      expect(verified.statusCode).toBe(200);
      expect(verified.json().accountCreated).toBe(true);
      accessToken = verified.json().session.access.accessToken;
      refreshToken = verified.json().session.refresh.refreshToken;
      const account = await first.dataApp.inject({ url: "/api/community/v1/auth/account-context", headers: { authorization: `Bearer ${accessToken}` } });
      expect(account.statusCode).toBe(200);
      accountId = account.json().accountId;
      expect(/^[A-Z0-9]{32}$/.test(accountId)).toBe(true);
      expect(first.database.prepare("SELECT COUNT(*) AS count FROM users").get()).toEqual({ count: 1 });
    } finally { await first.close(); }
    const second = await createConfiguredApplication({ config: loadConfig({ COMMUNITY_DATA_DIRECTORY: dataDirectory }), smsTransport });
    try {
      const afterRestart = await second.dataApp.inject({ url: "/api/community/v1/auth/account-context", headers: { authorization: `Bearer ${accessToken}` } });
      expect(afterRestart.statusCode).toBe(200);
      expect(afterRestart.json().accountId === accountId).toBe(true);
      const refreshed = await second.dataApp.inject({ method: "POST", url: "/api/community/v1/auth/refresh", payload: {
        refreshToken, refreshRequestId: randomUUID(),
      } });
      expect(refreshed.statusCode).toBe(200);
      const updatedAccess = refreshed.json().session.access.accessToken as string;
      const context = await second.dataApp.inject({ url: "/api/community/v1/auth/account-context", headers: { authorization: `Bearer ${updatedAccess}` } });
      expect(context.statusCode).toBe(200);
      expect(context.json().accountId === accountId).toBe(true);
      const logout = await second.dataApp.inject({ method: "POST", url: "/api/community/v1/auth/logout", headers: { authorization: `Bearer ${updatedAccess}` } });
      expect(logout.statusCode).toBe(204);
      for (const token of [accessToken, updatedAccess]) {
        const denied = await second.dataApp.inject({ url: "/api/community/v1/auth/me", headers: { authorization: `Bearer ${token}` } });
        expect(denied.statusCode).toBe(401);
      }
      const deniedRefresh = await second.dataApp.inject({ method: "POST", url: "/api/community/v1/auth/refresh", payload: {
        refreshToken: refreshed.json().session.refresh.refreshToken, refreshRequestId: randomUUID(),
      } });
      expect(deniedRefresh.statusCode).toBe(401);
    } finally { await second.close(); }
  });

  it("rejects broad secret-file permissions and symlinks", () => {
    const dataDirectory = directory();
    const config = loadConfig({ COMMUNITY_DATA_DIRECTORY: dataDirectory });
    const file = join(dataDirectory, "application-keys.json");
    if (process.platform !== "win32") {
      chmodSync(file, 0o644);
      expect(() => config.withSecretFile("jwtSigning", () => undefined)).toThrow();
      chmodSync(file, 0o600);
    }
    const moved = join(dataDirectory, "stored-keys.json");
    writeFileSync(moved, readFileSync(file), { mode: 0o600 });
    rmSync(file);
    symlinkSync(moved, file);
    expect(() => config.withSecretFile("jwtSigning", () => undefined)).toThrow();
  });

  it("bootstraps the latest business schema without imported data and rejects unrelated existing databases", () => {
    const db = openDatabase(":memory:");
    try {
      applyPublicSchema(db, "core");
      applyPublicSchema(db, "core");
      expect(db.prepare("SELECT COUNT(*) AS count FROM billing_offer_versions").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM admin_trial_regrant_events").get()).toEqual({ count: 0 });
      const diagnosticColumns = db.pragma("table_xinfo(diagnostic_reports)") as { name: string }[];
      expect(diagnosticColumns.some(({ name }) => name === "platform")).toBe(true);
      expect(diagnosticColumns.some(({ name }) => name === "os_version")).toBe(true);
      const guard = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'billing_orders_status_transition_guard'").get() as { sql: string };
      expect(guard.sql).toContain("OLD.status = 'payment_exception' AND NEW.status = 'expired'");
      expect(guard.sql).toContain("NOT EXISTS (SELECT 1 FROM wechat_payment_events");
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally { db.close(); }
    const unrelated = openDatabase(":memory:");
    try {
      unrelated.exec("CREATE TABLE unrelated_data (value TEXT)");
      expect(() => applyPublicSchema(unrelated, "core")).toThrow("Unsupported database schema");
    } finally { unrelated.close(); }
  });
});
