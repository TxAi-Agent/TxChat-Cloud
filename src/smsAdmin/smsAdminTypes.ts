export type SmsAdminTokenPurpose = "setup" | "password_reset";
export type SmsConfigurationLifecycle = "draft" | "active" | "standby" | "retired";
export type SmsDraftTestOutcome = "accepted" | "rejected" | "uncertain";

export type EncryptedSmsCredentials = Readonly<{
  keyVersion: string;
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}>;

export type SmsAdminAccount = Readonly<{
  username: string;
  passwordAlgorithm: "scrypt-v1";
  passwordSalt: Buffer;
  passwordDigest: Buffer;
  passwordN: 32768;
  passwordR: 8;
  passwordP: 1;
  revision: number;
  createdAt: string;
  updatedAt: string;
}>;

export type SafeSmsConfiguration = Readonly<{
  id: string;
  revision: number;
  templateCode: string;
  lifecycle: SmsConfigurationLifecycle;
  lastTestOutcome: SmsDraftTestOutcome | null;
  createdAt: string;
  updatedAt: string;
  credentialsConfigured: true;
}>;

export type SmsConfigurationCiphertext = Readonly<
  SafeSmsConfiguration & {
    encrypted: EncryptedSmsCredentials;
    claimId: string | null;
    claimedAt: string | null;
  }
>;

export type SmsAdminRateLimitScope =
  | "account"
  | "ip"
  | "account_ip"
  | "test_phone"
  | "administrator";

export type SmsAdminRateLimitEvent =
  | "login_failed"
  | "login_succeeded"
  | "test_attempt"
  | "suspension";

export type SmsAdminRateLimitResult = Readonly<{
  allowed: boolean;
  count: number;
}>;

export type SmsAdminAuditEvent =
  | "initialized"
  | "login"
  | "logout"
  | "password_changed"
  | "password_reset"
  | "draft_saved"
  | "test_completed"
  | "activated";
