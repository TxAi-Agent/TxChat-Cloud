import type { CoreDatabase } from "../db/database.js";
import { withImmediateTransaction } from "../db/database.js";
import { authenticationPolicy } from "./authenticationPolicy.js";

export type AuthRetentionResult = Readonly<{
  challengeMetadataDeleted: number;
  rateLimitEventsDeleted: number;
  refreshRecoveriesDeleted: number;
  auditEventsDeleted: number;
  enrollmentsExpired: number;
  enrollmentMetadataDeleted: number;
  enrollmentAuditEventsDeleted: number;
  smsAdminTokensDeleted: number;
  smsAdminRateLimitEventsDeleted: number;
  smsAdminAuditEventsDeleted: number;
}>;

export class AuthRetentionService {
  private readonly phaseOneSchema: boolean;

  constructor(private readonly database: CoreDatabase) {
    // Match AuthAuditService's schema discriminator. Generation entrypoints
    // verify the full database pair before constructing retention services.
    this.phaseOneSchema = (
      this.database.prepare("PRAGMA table_info(auth_audit_events)").all() as Array<{
        name: string;
      }>
    ).some(({ name }) => name === "request_ref");
  }

  purge(now: Date): AuthRetentionResult {
    return withImmediateTransaction(this.database, () => {
      this.database
        .prepare(
          `UPDATE sms_challenges
           SET status = 'expired',
               otp_verifier = NULL,
               terminal_at = expires_at
           WHERE status IN ('active', 'pending')
             AND expires_at <= ?`,
        )
        .run(now.toISOString());
      const challengeMetadataDeleted = Number(
        this.database
          .prepare(
            `DELETE FROM sms_challenges
             WHERE terminal_at IS NOT NULL
               AND terminal_at <= ?`,
          )
          .run(
            new Date(
              now.getTime() -
                authenticationPolicy.challengeMetadataRetentionMs,
            ).toISOString(),
          ).changes,
      );
      const rateLimitEventsDeleted = Number(
        this.database
          .prepare(
            `DELETE FROM auth_rate_limit_events
             WHERE occurred_at <= ?`,
          )
          .run(
            new Date(
              now.getTime() - authenticationPolicy.rateLimitRetentionMs,
            ).toISOString(),
          ).changes,
      );
      const refreshRecoveriesDeleted = Number(
        this.database
          .prepare(
            `DELETE FROM refresh_recoveries
             WHERE expires_at <= ?`,
          )
          .run(now.toISOString()).changes,
      );
      // Phase-one audit evidence is protected append-only history. Its
      // ordinary DELETE triggers must remain enforced during maintenance.
      const auditEventsDeleted = this.phaseOneSchema ? 0 : Number(
        this.database
          .prepare(
            `DELETE FROM auth_audit_events
             WHERE occurred_at <= ?`,
          )
          .run(
            new Date(
              now.getTime() - authenticationPolicy.authAuditRetentionMs,
            ).toISOString(),
          ).changes,
      );
      const enrollmentsExpired = Number(
        this.database
          .prepare(
            `UPDATE closed_beta_enrollments
             SET status = 'expired',
                 credential_verifier = NULL,
                 terminal_at = expires_at
             WHERE status = 'active'
               AND expires_at <= ?`,
          )
          .run(now.toISOString()).changes,
      );
      const enrollmentMetadataDeleted = Number(
        this.database
          .prepare(
            `DELETE FROM closed_beta_enrollments
             WHERE terminal_at IS NOT NULL
               AND terminal_at <= ?`,
          )
          .run(
            new Date(
              now.getTime() -
                authenticationPolicy.enrollmentMetadataRetentionMs,
            ).toISOString(),
          ).changes,
      );
      const enrollmentAuditEventsDeleted = this.phaseOneSchema ? 0 : Number(
        this.database
          .prepare(
            `DELETE FROM closed_beta_enrollment_audit_events
             WHERE occurred_at <= ?`,
          )
          .run(
            new Date(
              now.getTime() - authenticationPolicy.authAuditRetentionMs,
            ).toISOString(),
          ).changes,
      );
      const smsAdminTokensDeleted = Number(
        this.database
          .prepare(
            `DELETE FROM sms_admin_bootstrap_tokens
             WHERE expires_at <= ?`,
          )
          .run(now.toISOString()).changes,
      );
      const smsAdminRateLimitEventsDeleted = Number(
        this.database
          .prepare(
            `DELETE FROM sms_admin_rate_limit_events
             WHERE (expires_at IS NOT NULL AND expires_at <= ?)
                OR (expires_at IS NULL AND occurred_at <= ?)`,
          )
          .run(
            now.toISOString(),
            new Date(
              now.getTime() - authenticationPolicy.rateLimitRetentionMs,
            ).toISOString(),
          ).changes,
      );
      const smsAdminAuditEventsDeleted = this.phaseOneSchema ? 0 : Number(
        this.database
          .prepare(
            `DELETE FROM sms_admin_audit
             WHERE occurred_at <= ?`,
          )
          .run(
            new Date(
              now.getTime() - authenticationPolicy.authAuditRetentionMs,
            ).toISOString(),
          ).changes,
      );
      return {
        challengeMetadataDeleted,
        rateLimitEventsDeleted,
        refreshRecoveriesDeleted,
        auditEventsDeleted,
        enrollmentsExpired,
        enrollmentMetadataDeleted,
        enrollmentAuditEventsDeleted,
        smsAdminTokensDeleted,
        smsAdminRateLimitEventsDeleted,
        smsAdminAuditEventsDeleted,
      };
    });
  }
}
