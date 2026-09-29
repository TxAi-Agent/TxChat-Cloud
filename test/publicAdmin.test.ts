import { describe, expect, it, vi, afterEach } from "vitest";
import { AdminApiClient } from "../admin-web/src/api.js";
import { MENU_ORDER } from "../admin-web/src/navigation.js";
import { ADMIN_MENU_CODES } from "../src/admin/unified/adminTypes.js";
import { renderAdminDocument } from "../src/admin/unified/adminDocument.js";

afterEach(() => vi.unstubAllGlobals());

describe("community administrator boundary", () => {
  it("keeps the seven business and account menus in the shell", () => {
    const expected = ["users.list", "feedback.list", "offers.list", "orders.list", "models.config", "sms.config", "accounts.list"];
    expect([...MENU_ORDER]).toEqual(expected);
    expect([...ADMIN_MENU_CODES]).toEqual(expected);
    const document = renderAdminDocument();
    for (const menu of expected) expect(document).toContain(`data-menu-code="${menu}"`);
    expect(document).toContain('src="/console/assets/modules/app.js"');
  });

  it("uses a same-origin API with CSRF rotation and refuses another surface", async () => {
    const csrf = "c".repeat(43);
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ ready: true }), {
      headers: { "content-type": "application/json", "x-txchat-admin-csrf": csrf },
    })));
    vi.stubGlobal("fetch", fetch);
    const client = new AdminApiClient();
    await expect(client.request("/console/api/v1/session")).resolves.toEqual({ ready: true });
    await client.request("/console/api/v1/session/logout", { method: "POST" });
    const options = fetch.mock.calls[1]![1] as RequestInit;
    expect(options.credentials).toBe("same-origin");
    expect(options.redirect).toBe("error");
    expect((options.headers as Headers).get("x-txchat-admin-csrf")).toBe(csrf);
    await expect(client.request("https://example.invalid/console/api/v1/session")).rejects.toMatchObject({ code: "ADMIN_INVALID_REQUEST" });
    await expect(client.request("/elsewhere/session")).rejects.toMatchObject({ code: "ADMIN_INVALID_REQUEST" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

import Fastify from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { registerUnifiedAdminRoutes, type UnifiedAdminRoutesOptions } from "../src/admin/unified/adminRoutes.js";
import { AdminRateLimiter } from "../src/admin/unified/adminRateLimiter.js";
import { AdminSessionStore } from "../src/admin/unified/adminSession.js";
import { hashAdminPassword } from "../src/admin/unified/adminPassword.js";
import { generateInternalId } from "../src/ids/internalId.js";
import type { SafeAdminAccount } from "../src/admin/unified/adminTypes.js";

it("serves console assets and protects all seven business endpoints", async () => {
  const origin = "https://example.invalid";
  const password = randomBytes(24).toString("base64url");
  const passwordHash = await hashAdminPassword(password);
  const account: SafeAdminAccount = {
    id: generateInternalId(), username: randomUUID().replaceAll("-", ""),
    normalizedUsername: "", kind: "super_admin", status: "active", permissions: ADMIN_MENU_CODES,
    revision: 1, passwordRevision: 1, permissionRevision: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null,
  };
  const storedAccount = { ...account, normalizedUsername: account.username };
  const sessions = new AdminSessionStore({ origin, accountById: () => storedAccount });
  const rateLimiter = new AdminRateLimiter({ key: randomBytes(32) });
  const setupRateLimiter = new AdminRateLimiter({ key: randomBytes(32) });
  const options = {
    origin, sessions, rateLimiter, setupRateLimiter, fallbackPasswordHash: passwordHash,
    accounts: { authenticationByUsername: (name: string) => name === storedAccount.username ? {
      account: storedAccount, password: { ...passwordHash, salt: Buffer.from(passwordHash.salt), digest: Buffer.from(passwordHash.digest) },
    } : null },
    audit: { record: () => undefined },
    users: {}, feedback: {}, orders: {}, offers: {}, models: {}, sms: {},
  } as unknown as UnifiedAdminRoutesOptions;
  const app = Fastify();
  registerUnifiedAdminRoutes(app, options);
  try {
    const shell = await app.inject({ method: "GET", url: "/console/" });
    expect(shell.statusCode).toBe(200);
    expect(shell.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect((await app.inject({ method: "GET", url: "/console/assets/modules/app.js" })).statusCode).toBe(200);
    for (const name of ["users", "feedback", "orders", "offers", "model-configurations", "sms-configurations", "accounts"]) {
      const response = await app.inject({ method: "GET", url: `/console/api/v1/${name}` });
      expect(response.statusCode, name).toBe(401);
    }
    expect((await app.inject({ method: "GET", url: "/console/api/v1/releases" })).statusCode).toBe(404);
    const login = await app.inject({ method: "POST", url: "/console/api/v1/session/login",
      headers: { origin, host: new URL(origin).host }, payload: { username: storedAccount.username, password } });
    expect(login.statusCode).toBe(200);
    expect(login.headers["set-cookie"]).toContain("Path=/console; Secure; HttpOnly; SameSite=Strict");
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const denied = await app.inject({ method: "POST", url: "/console/api/v1/session/logout", headers: { cookie, origin, host: new URL(origin).host } });
    expect(denied.statusCode).toBe(403);
    const logout = await app.inject({ method: "POST", url: "/console/api/v1/session/logout", headers: {
      cookie, origin, host: new URL(origin).host, "x-txchat-admin-csrf": String(login.headers["x-txchat-admin-csrf"]),
    } });
    expect(logout.statusCode).toBe(204);
    expect(logout.headers["set-cookie"]).toContain("Path=/console; Secure; HttpOnly; SameSite=Strict; Max-Age=0");
    expect((await app.inject({ method: "GET", url: "/console/api/v1/session", headers: { cookie } })).statusCode).toBe(401);
  } finally {
    sessions.dispose(); rateLimiter.dispose(); setupRateLimiter.dispose();
    passwordHash.salt.fill(0); passwordHash.digest.fill(0);
    await app.close();
  }
});
