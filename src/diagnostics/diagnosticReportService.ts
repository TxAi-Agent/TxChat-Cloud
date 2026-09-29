import {
  createHash,
  randomBytes,
} from "node:crypto";

import { z } from "zod";

import {
  createIpLookupCandidates,
  pseudonymizeIp,
  type VersionedKeyRing,
} from "../auth/phoneIdentity.js";
import {
  type CoreDatabase,
  withImmediateTransaction,
} from "../db/database.js";
import {
  type InternalIdGenerator,
} from "../ids/internalId.js";
import { allocateRuntimeEntityId } from "../ids/runtimeEntityId.js";

export const diagnosticCategories = [
  "application",
  "authentication",
  "dictation",
  "insertion",
  "update",
  "custom_asr",
  "custom_optimization",
] as const;

export const diagnosticStages = [
  "lifecycle",
  "session_restore",
  "session_install",
  "session_delete",
  "capture_preflight",
  "capture_start",
  "stream_start",
  "audio_pump",
  "stream_finish",
  "final_preparation",
  "target_capture",
  "clipboard_transaction",
  "event_delivery",
  "update_check",
  "update_download",
  "update_install",
  "provider_configuration",
  "provider_test",
  "provider_request",
  "provider_response",
] as const;

export const diagnosticCodes = [
  "ABNORMAL_EXIT",
  "LOCAL_STATE_READ_FAILED",
  "LOCAL_STATE_WRITE_FAILED",
  "LOCAL_STATE_DELETE_FAILED",
  "PROTOCOL_VIOLATION",
  "AUDIO_CONVERSION_FAILED",
  "AUDIO_BUFFER_OVERFLOW",
  "CAPTURE_INTERNAL_FAILURE",
  "INSERTION_TRANSACTION_BUSY",
  "PASTEBOARD_SNAPSHOT_FAILED",
  "PASTEBOARD_WRITE_FAILED",
  "PASTE_EVENT_FAILED",
  "UPDATE_METADATA_INVALID",
  "UPDATE_SIGNATURE_INVALID",
  "UPDATE_INSTALL_FAILED",
  "PROVIDER_CONFIGURATION_INVALID",
  "PROVIDER_PROTOCOL_VIOLATION",
  "INTERNAL_ERROR",
] as const;

const diagnosticPermissionStates = [
  "authorized",
  "denied",
  "not_determined",
  "restricted",
  "unknown",
] as const;

export const diagnosticPlatforms = ["macos", "windows"] as const;

const canonicalUtcTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) &&
      new Date(milliseconds).toISOString() === value;
  });
const numericVersion = z
  .string()
  .min(1)
  .max(64)
  .regex(/^\d+(?:\.\d+){1,3}$/);
const normalizedUuid = z.uuid().transform((value) => value.toLowerCase());
const taskId = normalizedUuid.optional();
const diagnosticCategory = z.enum(diagnosticCategories);
const diagnosticStage = z.enum(diagnosticStages);
const diagnosticCode = z.enum(diagnosticCodes);
const diagnosticPermission = z.enum(diagnosticPermissionStates);

const diagnosticLegacyMacOSSystemSchema = z
  .object({
    macOSVersion: numericVersion,
    microphone: diagnosticPermission,
    accessibility: diagnosticPermission,
  })
  .strict();

const diagnosticCrossPlatformSystemSchema = z
  .object({
    platform: z.enum(diagnosticPlatforms),
    osVersion: numericVersion,
    microphone: diagnosticPermission,
    accessibility: diagnosticPermission,
  })
  .strict();

const diagnosticIncidentSchema = z
  .object({
    category: diagnosticCategory,
    taskId,
    stage: diagnosticStage,
    code: diagnosticCode,
  })
  .strict();

const diagnosticEventSchema = z
  .object({
    occurredAt: canonicalUtcTimestamp,
    category: diagnosticCategory,
    taskId,
    stage: diagnosticStage,
    code: diagnosticCode,
    durationMs: z.number().int().min(0).max(3_600_000).optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
  })
  .strict();

export const diagnosticReportRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    reportId: normalizedUuid,
    installationId: normalizedUuid,
    consent: z
      .object({
        promptVersion: z.literal(1),
        confirmedAt: canonicalUtcTimestamp,
      })
      .strict(),
    occurredAt: canonicalUtcTimestamp,
    app: z
      .object({
        version: numericVersion,
        build: z.string().min(1).max(18).regex(/^\d+$/),
        locale: z.enum(["zh-Hans", "en"]),
        architecture: z.enum(["arm64", "x86_64", "unknown"]),
      })
      .strict(),
    system: z.union([
      diagnosticLegacyMacOSSystemSchema,
      diagnosticCrossPlatformSystemSchema,
    ]),
    service: z
      .object({
        mode: z.enum(["txchat_cloud", "custom"]),
      })
      .strict(),
    incident: diagnosticIncidentSchema,
    events: z.array(diagnosticEventSchema).max(20),
  })
  .strict();

export type DiagnosticReportRequest = z.infer<
  typeof diagnosticReportRequestSchema
>;

export type DiagnosticReportFailureCode =
  | "DIAGNOSTIC_INVALID"
  | "REPORT_ID_CONFLICT"
  | "TOO_MANY_REQUESTS"
  | "SERVICE_UNAVAILABLE";

export class DiagnosticReportFailure extends Error {
  constructor(
    readonly code: DiagnosticReportFailureCode,
    readonly statusCode: 400 | 409 | 429 | 503,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = "DiagnosticReportFailure";
  }
}

export type DiagnosticReportResult = Readonly<{
  created: boolean;
  diagnosticNumber: string;
  reportId: string;
  receivedAt: string;
}>;

type DiagnosticReportServiceOptions = Readonly<{
  database: CoreDatabase;
  ipLookupKeys: VersionedKeyRing;
  now?: () => Date;
  generateDiagnosticNumber?: () => string;
  internalId?: InternalIdGenerator;
}>;

const diagnosticNumberAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const installationDomain = "txchat-diagnostic-installation-v1:";
const tenMinutesMs = 10 * 60_000;
const oneHourMs = 60 * 60_000;
const oneDayMs = 24 * oneHourMs;
const futureClockToleranceMs = 5 * 60_000;
const maximumIncidentAgeMs = 7 * oneDayMs;

function randomDiagnosticNumber(): string {
  const source = randomBytes(8);
  let suffix = "";
  for (const byte of source) {
    suffix += diagnosticNumberAlphabet[byte % diagnosticNumberAlphabet.length];
  }
  return `TX-${suffix}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, "en-US"))
      .map(([key, nested]) =>
        `${JSON.stringify(key)}:${canonicalJson(nested)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function lookupDigest(lookup: string): string {
  const separator = lookup.indexOf(":");
  const digest = separator < 0 ? "" : lookup.slice(separator + 1);
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error("Diagnostic IP lookup is invalid");
  }
  return digest;
}

function lookupVersion(lookup: string): string {
  const separator = lookup.indexOf(":");
  if (separator <= 0) {
    throw new Error("Diagnostic IP lookup version is invalid");
  }
  return lookup.slice(0, separator);
}

type RateLimitSubject = Readonly<{
  ref: string;
  ipKeyVersion: string | null;
}>;

type NormalizedDiagnosticSystem = Readonly<{
  platform: typeof diagnosticPlatforms[number];
  osVersion: string;
  microphone: typeof diagnosticPermissionStates[number];
  accessibility: typeof diagnosticPermissionStates[number];
}>;

function normalizeDiagnosticSystem(
  system: DiagnosticReportRequest["system"],
): NormalizedDiagnosticSystem {
  if ("platform" in system) {
    return Object.freeze({
      platform: system.platform,
      osVersion: system.osVersion,
      microphone: system.microphone,
      accessibility: system.accessibility,
    });
  }
  return Object.freeze({
    platform: "macos",
    osVersion: system.macOSVersion,
    microphone: system.microphone,
    accessibility: system.accessibility,
  });
}

function rateLimitSubject(lookup: string): RateLimitSubject {
  return {
    ref: lookupDigest(lookup),
    ipKeyVersion: lookupVersion(lookup),
  };
}

function retryAfterSeconds(expiresAt: number, now: number): number {
  return Math.max(1, Math.ceil((expiresAt - now) / 1_000));
}

export class DiagnosticReportService {
  private readonly now: () => Date;
  private readonly generateDiagnosticNumber: () => string;
  private readonly internalId: InternalIdGenerator;
  private readonly phaseOneSchema: boolean;

  constructor(private readonly options: DiagnosticReportServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.generateDiagnosticNumber =
      options.generateDiagnosticNumber ?? randomDiagnosticNumber;
    this.internalId = options.internalId ?? (() =>
      allocateRuntimeEntityId(this.phaseOneSchema));
    this.phaseOneSchema = (
      options.database.prepare("PRAGMA table_info(diagnostic_reports)").all() as Array<{
        name: string;
      }>
    ).some(({ name }) => name === "external_report_id");
  }

  private quotaRetry(
    subjectKind: "installation" | "ip",
    subjects: readonly RateLimitSubject[],
    windowMs: number,
    limit: number,
    now: Date,
  ): number | undefined {
    if (subjects.length === 0) {
      return undefined;
    }
    const rows = this.options.database
      .prepare(
        `SELECT occurred_at
         FROM diagnostic_rate_limit_events
         WHERE subject_kind = ?
           AND (${subjects
             .map(() => "(subject_ref = ? AND ip_key_version IS ?)")
             .join(" OR ")})
           AND occurred_at > ?
         ORDER BY occurred_at ASC`,
      )
      .all(
        subjectKind,
        ...subjects.flatMap((subject) => [
          subject.ref,
          subject.ipKeyVersion,
        ]),
        new Date(now.getTime() - windowMs).toISOString(),
      ) as Array<{ occurred_at: string }>;
    if (rows.length < limit) {
      return undefined;
    }
    const firstBlocking = rows[rows.length - limit]!;
    return retryAfterSeconds(
      Date.parse(firstBlocking.occurred_at) + windowMs,
      now.getTime(),
    );
  }

  private enforceRateLimit(
    installationRef: string,
    ipSubjects: readonly RateLimitSubject[],
    now: Date,
  ): void {
    const retries = [
      this.quotaRetry(
        "installation",
        [{ ref: installationRef, ipKeyVersion: null }],
        tenMinutesMs,
        5,
        now,
      ),
      this.quotaRetry(
        "installation",
        [{ ref: installationRef, ipKeyVersion: null }],
        oneDayMs,
        20,
        now,
      ),
      this.quotaRetry("ip", ipSubjects, oneHourMs, 30, now),
      this.quotaRetry("ip", ipSubjects, oneDayMs, 200, now),
    ].filter((value): value is number => value !== undefined);
    if (retries.length > 0) {
      throw new DiagnosticReportFailure(
        "TOO_MANY_REQUESTS",
        429,
        Math.max(...retries),
      );
    }
  }

  private allocateDiagnosticNumber(): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = this.generateDiagnosticNumber();
      if (!/^TX-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/.test(candidate)) {
        throw new Error("Generated diagnostic number is invalid");
      }
      const existing = this.options.database
        .prepare(
          "SELECT 1 FROM diagnostic_reports WHERE diagnostic_number = ?",
        )
        .get(candidate);
      if (existing === undefined) {
        return candidate;
      }
    }
    throw new Error("Diagnostic number allocation exhausted");
  }

  submit(input: Readonly<{
    body: unknown;
    ipAddress: string;
  }>): DiagnosticReportResult {
    const parsed = diagnosticReportRequestSchema.safeParse(input.body);
    if (!parsed.success) {
      throw new DiagnosticReportFailure("DIAGNOSTIC_INVALID", 400);
    }
    const report = parsed.data;

    try {
      const now = this.now();
      const nowMs = now.getTime();
      const occurredAtMs = Date.parse(report.occurredAt);
      const confirmedAtMs = Date.parse(report.consent.confirmedAt);
      if (
        !Number.isFinite(nowMs) ||
        occurredAtMs > confirmedAtMs ||
        confirmedAtMs > nowMs + futureClockToleranceMs ||
        occurredAtMs < nowMs - maximumIncidentAgeMs ||
        report.events.some(
          (event) => Date.parse(event.occurredAt) > confirmedAtMs,
        )
      ) {
        throw new DiagnosticReportFailure("DIAGNOSTIC_INVALID", 400);
      }
      const payloadDigest = sha256(canonicalJson(report));
      const normalizedSystem = normalizeDiagnosticSystem(report.system);
      const installationRef = sha256(
        `${installationDomain}${report.installationId}`,
      );
      const receivedAt = now.toISOString();
      const ipCandidates = createIpLookupCandidates(
        input.ipAddress,
        this.options.ipLookupKeys,
      );
      const ipSubjects = ipCandidates.map(rateLimitSubject);
      const activeIpLookup = pseudonymizeIp(
        input.ipAddress,
        this.options.ipLookupKeys,
      );

      return withImmediateTransaction(this.options.database, () => {
        const existing = this.options.database
          .prepare(
            `SELECT payload_digest, diagnostic_number, received_at
             FROM diagnostic_reports
             WHERE ${this.phaseOneSchema ? "external_report_id" : "report_id"} = ?`,
          )
          .get(report.reportId) as
          | {
              payload_digest: string;
              diagnostic_number: string;
              received_at: string;
            }
          | undefined;
        if (existing !== undefined) {
          if (existing.payload_digest !== payloadDigest) {
            throw new DiagnosticReportFailure(
              "REPORT_ID_CONFLICT",
              409,
            );
          }
          return {
            created: false,
            diagnosticNumber: existing.diagnostic_number,
            reportId: report.reportId,
            receivedAt: existing.received_at,
          };
        }

        this.enforceRateLimit(installationRef, ipSubjects, now);
        const diagnosticNumber = this.allocateDiagnosticNumber();
        const internalReportId = this.phaseOneSchema
          ? allocateRuntimeEntityId(true, this.internalId)
          : report.reportId;
        this.options.database
          .prepare(
            `INSERT INTO diagnostic_reports (
              ${this.phaseOneSchema ? "id, external_report_id" : "report_id"},
              payload_digest, diagnostic_number,
              installation_ref, ip_ref, ip_key_version, schema_version,
              consent_prompt_version, consent_confirmed_at, occurred_at,
              received_at, app_version, app_build, locale, architecture,
              macos_version, platform, microphone_permission,
              accessibility_permission,
              service_mode, incident_category,
              ${this.phaseOneSchema ? "incident_task_ref" : "incident_task_id"},
              incident_stage, incident_code
            ) VALUES (
              ${this.phaseOneSchema ? "?," : ""}
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?
            )`,
          )
          .run(
            ...(this.phaseOneSchema ? [internalReportId] : []),
            report.reportId,
            payloadDigest,
            diagnosticNumber,
            installationRef,
            lookupDigest(activeIpLookup),
            lookupVersion(activeIpLookup),
            report.schemaVersion,
            report.consent.promptVersion,
            report.consent.confirmedAt,
            report.occurredAt,
            receivedAt,
            report.app.version,
            report.app.build,
            report.app.locale,
            report.app.architecture,
            normalizedSystem.osVersion,
            normalizedSystem.platform,
            normalizedSystem.microphone,
            normalizedSystem.accessibility,
            report.service.mode,
            report.incident.category,
            report.incident.taskId ?? null,
            report.incident.stage,
            report.incident.code,
          );
        const insertEvent = this.options.database.prepare(
          `INSERT INTO diagnostic_events (
            report_id, event_index, occurred_at, category,
            ${this.phaseOneSchema ? "task_ref" : "task_id"}, stage,
            code, duration_ms, http_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const [index, event] of report.events.entries()) {
          insertEvent.run(
            this.phaseOneSchema ? internalReportId : report.reportId,
            index,
            event.occurredAt,
            event.category,
            event.taskId ?? null,
            event.stage,
            event.code,
            event.durationMs ?? null,
            event.httpStatus ?? null,
          );
        }
        const insertRateEvent = this.options.database.prepare(
          `INSERT INTO diagnostic_rate_limit_events (
            id, subject_kind, subject_ref, ip_key_version, occurred_at
          ) VALUES (?, ?, ?, ?, ?)`,
        );
        insertRateEvent.run(
          allocateRuntimeEntityId(this.phaseOneSchema, this.internalId),
          "installation",
          installationRef,
          null,
          receivedAt,
        );
        insertRateEvent.run(
          allocateRuntimeEntityId(this.phaseOneSchema, this.internalId),
          "ip",
          lookupDigest(activeIpLookup),
          lookupVersion(activeIpLookup),
          receivedAt,
        );

        return {
          created: true,
          diagnosticNumber,
          reportId: report.reportId,
          receivedAt,
        };
      });
    } catch (error) {
      if (error instanceof DiagnosticReportFailure) {
        throw error;
      }
      throw new DiagnosticReportFailure("SERVICE_UNAVAILABLE", 503);
    }
  }
}
