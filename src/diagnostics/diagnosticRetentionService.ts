import type { CoreDatabase } from "../db/database.js";
import { withImmediateTransaction } from "../db/database.js";

export const diagnosticReportRetentionMs = 30 * 86_400_000;
export const diagnosticRateLimitRetentionMs = 48 * 3_600_000;

export type DiagnosticRetentionResult = Readonly<{
  reportsDeleted: number;
  rateLimitEventsDeleted: number;
}>;

export class DiagnosticRetentionService {
  private readonly batchSize: number;
  private readonly reportIdentityColumn: "id" | "report_id";

  constructor(
    private readonly database: CoreDatabase,
    options: Readonly<{ batchSize?: number }> = {},
  ) {
    const batchSize = options.batchSize ?? 500;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
      throw new Error("Diagnostic retention batch size is invalid");
    }
    this.batchSize = batchSize;
    this.reportIdentityColumn = (
      database.prepare("PRAGMA table_info(diagnostic_reports)").all() as Array<{
        name: string;
      }>
    ).some(({ name }) => name === "external_report_id")
      ? "id"
      : "report_id";
  }

  purgeBatch(now: Date): DiagnosticRetentionResult {
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) {
      throw new Error("Diagnostic retention time is invalid");
    }
    const reportBoundary = new Date(
      nowMs - diagnosticReportRetentionMs,
    ).toISOString();
    const rateBoundary = new Date(
      nowMs - diagnosticRateLimitRetentionMs,
    ).toISOString();
    return withImmediateTransaction(this.database, () => {
      const reportsDeleted = Number(
        this.database
          .prepare(
            `DELETE FROM diagnostic_reports
             WHERE ${this.reportIdentityColumn} IN (
               SELECT ${this.reportIdentityColumn}
               FROM diagnostic_reports
               WHERE received_at <= ?
               ORDER BY received_at, ${this.reportIdentityColumn}
               LIMIT ?
             )`,
          )
          .run(reportBoundary, this.batchSize).changes,
      );
      const remaining = this.batchSize - reportsDeleted;
      if (remaining === 0) {
        return { reportsDeleted, rateLimitEventsDeleted: 0 };
      }
      const rateLimitEventsDeleted = Number(
        this.database
          .prepare(
            `DELETE FROM diagnostic_rate_limit_events
             WHERE id IN (
               SELECT id
               FROM diagnostic_rate_limit_events
               WHERE occurred_at <= ?
               ORDER BY occurred_at, id
               LIMIT ?
             )`,
          )
          .run(rateBoundary, remaining).changes,
      );
      return { reportsDeleted, rateLimitEventsDeleted };
    });
  }

  purge(now: Date): DiagnosticRetentionResult {
    let reportsDeleted = 0;
    let rateLimitEventsDeleted = 0;
    while (true) {
      const batch = this.purgeBatch(now);
      reportsDeleted += batch.reportsDeleted;
      rateLimitEventsDeleted += batch.rateLimitEventsDeleted;
      if (
        batch.reportsDeleted + batch.rateLimitEventsDeleted <
        this.batchSize
      ) {
        break;
      }
    }
    return { reportsDeleted, rateLimitEventsDeleted };
  }
}
