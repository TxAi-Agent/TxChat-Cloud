import type { CoreDatabase } from "../db/database.js";
import {
  allocateInternalId,
  generateInternalId,
  type InternalIdGenerator,
} from "../ids/internalId.js";
import {
  createPhoneLookupCandidates,
  encryptPhone,
  keyVersion,
  type VersionedKeyRing,
} from "./phoneIdentity.js";
import {
  SessionFailure,
  type SessionBundle,
  type SessionService,
} from "./sessionService.js";

export type VerifiedPhoneUser = Readonly<{
  id: string;
  phone_lookup: string;
  phone_ciphertext: string;
  status: "enabled" | "disabled";
}>;

export type VerifiedPhoneSessionInstallation = Readonly<{
  accountCreated: boolean;
  user: VerifiedPhoneUser;
  session: SessionBundle;
  revokedSessionIds: readonly string[];
}>;

type VerifiedPhoneSessionInstallerOptions = Readonly<{
  database: CoreDatabase;
  phoneLookupKeys: VersionedKeyRing;
  phoneEncryptionKeys: VersionedKeyRing;
  sessionService: SessionService;
  internalId?: InternalIdGenerator;
}>;

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

export class VerifiedPhoneSessionInstaller {
  constructor(
    private readonly options: VerifiedPhoneSessionInstallerOptions,
  ) {}

  installWithinTransaction(
    phone: string,
    now: Date,
  ): VerifiedPhoneSessionInstallation {
    if (!this.options.database.inTransaction) {
      throw new Error(
        "Verified phone session installation requires a caller transaction",
      );
    }

    const phoneCandidates = createPhoneLookupCandidates(
      phone,
      this.options.phoneLookupKeys,
    );
    const canonicalPhoneLookup = phoneCandidates[0]!;
    const canonicalPhoneCiphertext = encryptPhone(
      phone,
      this.options.phoneEncryptionKeys,
    );
    const matchingUsers = this.options.database
      .prepare(
        `SELECT id, phone_lookup, phone_ciphertext, status
         FROM users
         WHERE phone_lookup IN (${placeholders(phoneCandidates)})`,
      )
      .all(...phoneCandidates) as VerifiedPhoneUser[];
    const canonicalUser = matchingUsers.find(
      (user) => user.phone_lookup === canonicalPhoneLookup,
    );
    if (canonicalUser === undefined && matchingUsers.length > 1) {
      throw new Error("Verified phone account state is inconsistent");
    }
    const existingUser = canonicalUser ?? matchingUsers[0];
    if (existingUser?.status === "disabled") {
      throw new SessionFailure("ACCOUNT_DISABLED", 403);
    }

    let accountCreated = false;
    if (existingUser === undefined) {
      const insert = this.options.database
        .prepare(
          `INSERT OR IGNORE INTO users (
            id, phone_lookup, phone_ciphertext, phone_key_version,
            status, current_session_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'enabled', NULL, ?, ?)`,
        )
        .run(
          allocateInternalId(this.options.internalId ?? generateInternalId),
          canonicalPhoneLookup,
          canonicalPhoneCiphertext,
          keyVersion(canonicalPhoneCiphertext),
          now.toISOString(),
          now.toISOString(),
        );
      accountCreated = Number(insert.changes) === 1;
    } else {
      this.options.database
        .prepare(
          `UPDATE users
           SET phone_lookup = ?, phone_ciphertext = ?,
               phone_key_version = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          canonicalPhoneLookup,
          canonicalPhoneCiphertext,
          keyVersion(canonicalPhoneCiphertext),
          now.toISOString(),
          existingUser.id,
        );
    }

    const user = this.options.database
      .prepare(
        `SELECT id, phone_lookup, phone_ciphertext, status
         FROM users WHERE phone_lookup = ?`,
      )
      .get(canonicalPhoneLookup) as VerifiedPhoneUser | undefined;
    if (user === undefined) {
      throw new Error("Verified phone account installation failed");
    }
    if (user.status === "disabled") {
      throw new SessionFailure("ACCOUNT_DISABLED", 403);
    }
    const session = this.options.sessionService.createWithinTransaction(
      user.id,
      now,
    );
    return {
      accountCreated,
      user,
      session: session.bundle,
      revokedSessionIds: session.revokedSessionIds,
    };
  }
}
