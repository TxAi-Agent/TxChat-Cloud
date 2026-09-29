export const ADMIN_MENU_CODES = Object.freeze([
  "users.list",
  "feedback.list",
  "offers.list",
  "orders.list",
  "models.config",
  "sms.config",
  "accounts.list",
] as const);

export type AdminMenuCode = typeof ADMIN_MENU_CODES[number];

export const GRANTABLE_ADMIN_MENU_CODES = Object.freeze(
  ADMIN_MENU_CODES.filter(
    (menu): menu is Exclude<AdminMenuCode, "accounts.list"> =>
      menu !== "accounts.list",
  ),
);

export type GrantableAdminMenuCode =
  typeof GRANTABLE_ADMIN_MENU_CODES[number];

export type AdminAccountKind = "super_admin" | "administrator";
export type AdminAccountStatus = "active" | "deleted";

export type AdminPasswordHash = Readonly<{
  algorithm: "scrypt-v1";
  salt: Buffer;
  digest: Buffer;
  N: 32768;
  r: 8;
  p: 1;
}>;

export type SafeAdminAccount = Readonly<{
  id: string;
  username: string;
  normalizedUsername: string;
  kind: AdminAccountKind;
  status: AdminAccountStatus;
  permissions: readonly AdminMenuCode[];
  revision: number;
  passwordRevision: number;
  permissionRevision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}>;

export type AdminAuthenticationRecord = Readonly<{
  account: SafeAdminAccount;
  password: AdminPasswordHash;
}>;

export type AdminSetupTokenPurpose =
  | "initial_superadmin"
  | "reset_superadmin"
  | "create_administrator"
  | "reset_administrator";

export type IssuedAdminSetupToken = Readonly<{
  id: string;
  purpose: AdminSetupTokenPurpose;
  expiresAt: string;
}>;
