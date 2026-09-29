import { isInternalId } from "../../ids/internalId.js";
import { normalizeAdminUsername } from "./adminPassword.js";
import {
  ADMIN_MENU_CODES,
  type AdminAccountKind,
  type AdminMenuCode,
  GRANTABLE_ADMIN_MENU_CODES,
  type GrantableAdminMenuCode,
} from "./adminTypes.js";

export type AdminFailureCode =
  | "ADMIN_ACCESS_DENIED"
  | "ADMIN_INVALID_REQUEST";

export class AdminFailure extends Error {
  constructor(
    readonly code: AdminFailureCode,
    readonly statusCode: 400 | 403,
  ) {
    super(code);
    this.name = "AdminFailure";
  }
}

export type AdminIdentity = Readonly<{
  accountId: string;
  username: string;
  kind: AdminAccountKind;
  menus: readonly AdminMenuCode[];
  accountRevision: number;
  passwordRevision: number;
  permissionRevision: number;
}>;

const MENU_CATALOG = new Set<string>(ADMIN_MENU_CODES);
const GRANTABLE_CATALOG = new Set<string>(GRANTABLE_ADMIN_MENU_CODES);

function invalid(): never {
  throw new AdminFailure("ADMIN_INVALID_REQUEST", 400);
}

function denied(): never {
  throw new AdminFailure("ADMIN_ACCESS_DENIED", 403);
}

function validateRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) invalid();
}

function validateIdentity(identity: AdminIdentity): void {
  if (
    identity === null ||
    typeof identity !== "object" ||
    !isInternalId(identity.accountId) ||
    (identity.kind !== "super_admin" && identity.kind !== "administrator") ||
    !Array.isArray(identity.menus)
  ) {
    invalid();
  }
  try {
    normalizeAdminUsername(identity.username);
  } catch {
    invalid();
  }
  validateRevision(identity.accountRevision);
  validateRevision(identity.passwordRevision);
  validateRevision(identity.permissionRevision);
}

function ordinaryMenuSet(identity: AdminIdentity): ReadonlySet<AdminMenuCode> {
  const result = new Set<AdminMenuCode>();
  for (const menu of identity.menus) {
    if (!GRANTABLE_CATALOG.has(menu)) denied();
    result.add(menu);
  }
  return result;
}

export function grantableMenu(menu: AdminMenuCode): GrantableAdminMenuCode {
  if (!MENU_CATALOG.has(menu)) invalid();
  if (!GRANTABLE_CATALOG.has(menu)) denied();
  return menu as GrantableAdminMenuCode;
}

export function authorizedMenus(
  identity: AdminIdentity,
): readonly AdminMenuCode[] {
  validateIdentity(identity);
  if (identity.kind === "super_admin") return ADMIN_MENU_CODES;
  const allowed = ordinaryMenuSet(identity);
  return Object.freeze(ADMIN_MENU_CODES.filter((menu) => allowed.has(menu)));
}

export function requireMenu(
  identity: AdminIdentity,
  menu: AdminMenuCode,
): void {
  validateIdentity(identity);
  if (!MENU_CATALOG.has(menu)) invalid();
  if (identity.kind === "super_admin") return;
  const allowed = ordinaryMenuSet(identity);
  if (menu === "accounts.list" || !allowed.has(menu)) denied();
}
