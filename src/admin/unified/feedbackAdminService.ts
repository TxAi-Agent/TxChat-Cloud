import type { CoreDatabase } from "../../db/database.js";
import {
  diagnosticCategories,
  diagnosticCodes,
  diagnosticPlatforms,
  diagnosticStages,
} from "../../diagnostics/diagnosticReportService.js";
import { isInternalId } from "../../ids/internalId.js";

const ID_PREFIX = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{1,32}$/u;
const SAFE_EXTERNAL_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_RESULTS = 100;
const CATEGORIES = new Set<string>(diagnosticCategories);
const STAGES = new Set<string>(diagnosticStages);
const CODES = new Set<string>(diagnosticCodes);
const PLATFORMS = new Set<string>(diagnosticPlatforms);
const PERMISSION_STATES = new Set<string>([
  "authorized",
  "denied",
  "not_determined",
  "restricted",
  "unknown",
]);

type DiagnosticCategory = typeof diagnosticCategories[number];
type DiagnosticStage = typeof diagnosticStages[number];
type DiagnosticCode = typeof diagnosticCodes[number];
type DiagnosticPlatform = typeof diagnosticPlatforms[number];
type PermissionState =
  | "authorized"
  | "denied"
  | "not_determined"
  | "restricted"
  | "unknown";

export type FeedbackAdminErrorCode =
  | "ADMIN_INVALID_REQUEST"
  | "ADMIN_FEEDBACK_NOT_FOUND"
  | "ADMIN_SERVICE_UNAVAILABLE";

export class FeedbackAdminError extends Error {
  constructor(readonly code: FeedbackAdminErrorCode) {
    super(code);
    this.name = "FeedbackAdminError";
  }
}

export type FeedbackSummary = Readonly<{
  id: string;
  externalReportId: string;
  diagnosticNumber: string;
  consentConfirmedAt: string;
  occurredAt: string;
  receivedAt: string;
  application: Readonly<{
    version: string;
    build: string;
    locale: "zh-Hans" | "en";
    architecture: "arm64" | "x86_64" | "unknown";
    macosVersion: string;
  }>;
  system: Readonly<{
    platform: DiagnosticPlatform;
    version: string;
  }>;
  permissions: Readonly<{
    microphone: PermissionState;
    accessibility: PermissionState;
  }>;
  serviceMode: "txchat_cloud" | "custom";
  incident: Readonly<{
    category: DiagnosticCategory;
    taskRef: string | null;
    stage: DiagnosticStage;
    code: DiagnosticCode;
  }>;
  eventCount: number;
}>;

export type FeedbackEvent = Readonly<{
  index: number;
  occurredAt: string;
  category: DiagnosticCategory;
  taskRef: string | null;
  stage: DiagnosticStage;
  code: DiagnosticCode;
  durationMs: number | null;
  httpStatus: number | null;
}>;

export type FeedbackDetail = FeedbackSummary & Readonly<{
  events: readonly FeedbackEvent[];
}>;

type ReportRow = Readonly<{
  id: string;
  external_report_id: string;
  diagnostic_number: string;
  consent_confirmed_at: string;
  occurred_at: string;
  received_at: string;
  app_version: string;
  app_build: string;
  locale: "zh-Hans" | "en";
  architecture: "arm64" | "x86_64" | "unknown";
  macos_version: string;
  platform: DiagnosticPlatform;
  os_version: string;
  microphone_permission: PermissionState;
  accessibility_permission: PermissionState;
  service_mode: "txchat_cloud" | "custom";
  incident_category: DiagnosticCategory;
  incident_task_ref: string | null;
  incident_stage: DiagnosticStage;
  incident_code: DiagnosticCode;
  event_count: number;
}>;

type EventRow = Readonly<{
  event_index: number;
  occurred_at: string;
  category: DiagnosticCategory;
  task_ref: string | null;
  stage: DiagnosticStage;
  code: DiagnosticCode;
  duration_ms: number | null;
  http_status: number | null;
}>;

export type FeedbackAdminListInput = Readonly<{
  page?: number | undefined;
  status?: string | undefined;
  keyword?: string | undefined;
  idPrefix?: string | undefined;
  limit?: number | undefined;
}>;

function fail(code: FeedbackAdminErrorCode): never {
  throw new FeedbackAdminError(code);
}

function timestamp(value: string): string {
  if (typeof value !== "string" || !value.isWellFormed()) {
    return fail("ADMIN_SERVICE_UNAVAILABLE");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    return fail("ADMIN_SERVICE_UNAVAILABLE");
  }
  return value;
}

function safeReference(value: string | null): string | null {
  if (value === null) return null;
  if (!SAFE_EXTERNAL_REFERENCE.test(value)) fail("ADMIN_SERVICE_UNAVAILABLE");
  return value;
}

function prefixUpperBound(prefix: string): string {
  const last = prefix.charCodeAt(prefix.length - 1);
  return `${prefix.slice(0, -1)}${String.fromCharCode(last + 1)}`;
}

function criteria(input: FeedbackAdminListInput): Readonly<{
  idPrefix?: string | undefined;
  limit: number;
  page: number;
  status?: string | undefined;
  keyword?: string | undefined;
}> {
  if (
    input === null ||
    typeof input !== "object" ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null) ||
    Object.keys(input).some((key) => !["idPrefix", "limit", "page", "status", "keyword"].includes(key))
  ) fail("ADMIN_INVALID_REQUEST");
  if (input.idPrefix !== undefined && !ID_PREFIX.test(input.idPrefix)) {
    fail("ADMIN_INVALID_REQUEST");
  }
  if (input.status !== undefined && !CATEGORIES.has(input.status)) fail("ADMIN_INVALID_REQUEST");
  const page = input.page ?? 1;
  if (!Number.isSafeInteger(page) || page < 1 ||
      (input.keyword !== undefined && (typeof input.keyword !== "string" || input.keyword.length > 128))) fail("ADMIN_INVALID_REQUEST");
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RESULTS) {
    fail("ADMIN_INVALID_REQUEST");
  }
  return Object.freeze({
    ...(input.idPrefix === undefined ? {} : { idPrefix: input.idPrefix }),
    limit, page,
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.keyword === undefined ? {} : { keyword: input.keyword }),
  });
}

function safeReport(row: ReportRow): FeedbackSummary {
  if (
    !isInternalId(row.id) ||
    !SAFE_EXTERNAL_REFERENCE.test(row.external_report_id) ||
    !/^TX-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/u.test(row.diagnostic_number) ||
    !/^\d+(?:\.\d+){1,3}$/u.test(row.app_version) ||
    !/^\d{1,18}$/u.test(row.app_build) ||
    (row.locale !== "zh-Hans" && row.locale !== "en") ||
    !["arm64", "x86_64", "unknown"].includes(row.architecture) ||
    !/^\d+(?:\.\d+){1,3}$/u.test(row.macos_version) ||
    !PLATFORMS.has(row.platform) ||
    !/^\d+(?:\.\d+){1,3}$/u.test(row.os_version) ||
    !PERMISSION_STATES.has(row.microphone_permission) ||
    !PERMISSION_STATES.has(row.accessibility_permission) ||
    (row.service_mode !== "txchat_cloud" && row.service_mode !== "custom") ||
    !CATEGORIES.has(row.incident_category) ||
    !STAGES.has(row.incident_stage) ||
    !CODES.has(row.incident_code) ||
    !Number.isSafeInteger(row.event_count) ||
    row.event_count < 0
  ) fail("ADMIN_SERVICE_UNAVAILABLE");
  return Object.freeze({
    id: row.id,
    externalReportId: row.external_report_id,
    diagnosticNumber: row.diagnostic_number,
    consentConfirmedAt: timestamp(row.consent_confirmed_at),
    occurredAt: timestamp(row.occurred_at),
    receivedAt: timestamp(row.received_at),
    application: Object.freeze({
      version: row.app_version,
      build: row.app_build,
      locale: row.locale,
      architecture: row.architecture,
      macosVersion: row.macos_version,
    }),
    system: Object.freeze({
      platform: row.platform,
      version: row.os_version,
    }),
    permissions: Object.freeze({
      microphone: row.microphone_permission,
      accessibility: row.accessibility_permission,
    }),
    serviceMode: row.service_mode,
    incident: Object.freeze({
      category: row.incident_category,
      taskRef: safeReference(row.incident_task_ref),
      stage: row.incident_stage,
      code: row.incident_code,
    }),
    eventCount: row.event_count,
  });
}

function safeEvent(row: EventRow): FeedbackEvent {
  if (
    !Number.isSafeInteger(row.event_index) ||
    row.event_index < 0 ||
    row.event_index > 19 ||
    !CATEGORIES.has(row.category) ||
    !STAGES.has(row.stage) ||
    !CODES.has(row.code) ||
    (row.duration_ms !== null &&
      (!Number.isSafeInteger(row.duration_ms) || row.duration_ms < 0 ||
        row.duration_ms > 3_600_000)) ||
    (row.http_status !== null &&
      (!Number.isSafeInteger(row.http_status) || row.http_status < 100 ||
        row.http_status > 599))
  ) fail("ADMIN_SERVICE_UNAVAILABLE");
  return Object.freeze({
    index: row.event_index,
    occurredAt: timestamp(row.occurred_at),
    category: row.category,
    taskRef: safeReference(row.task_ref),
    stage: row.stage,
    code: row.code,
    durationMs: row.duration_ms,
    httpStatus: row.http_status,
  });
}

const REPORT_COLUMNS = `
  report.id,
  report.external_report_id,
  report.diagnostic_number,
  report.consent_confirmed_at,
  report.occurred_at,
  report.received_at,
  report.app_version,
  report.app_build,
  report.locale,
  report.architecture,
  report.macos_version,
  report.platform,
  report.os_version,
  report.microphone_permission,
  report.accessibility_permission,
  report.service_mode,
  report.incident_category,
  report.incident_task_ref,
  report.incident_stage,
  report.incident_code,
  (SELECT COUNT(*) FROM diagnostic_events AS event
   WHERE event.report_id = report.id) AS event_count`;

export class FeedbackAdminService {
  constructor(private readonly database: CoreDatabase) {
    if (database === null || typeof database !== "object") {
      throw new TypeError("Invalid unified feedback administration options");
    }
  }

  list(input: FeedbackAdminListInput = {}): readonly FeedbackSummary[] {
    return this.searchPage(input).feedback;
  }

  searchPage(input: FeedbackAdminListInput = {}): Readonly<{
    feedback: readonly FeedbackSummary[];
    pagination: Readonly<{ page: number; pageSize: number; total: number; totalPages: number }>;
  }> {
    const parsed = criteria(input);
    const values: unknown[] = [];
    let where = "";
    if (parsed.idPrefix !== undefined) {
      if (parsed.idPrefix.length === 32) {
        where = "WHERE report.id = ?";
        values.push(parsed.idPrefix);
      } else {
        where = "WHERE report.id >= ? AND report.id < ?";
        values.push(parsed.idPrefix, prefixUpperBound(parsed.idPrefix));
      }
    }
    if (parsed.status !== undefined) {
      where += `${where === "" ? "WHERE" : " AND"} report.incident_category = ?`; values.push(parsed.status);
    }
    if (parsed.keyword !== undefined) {
      where += `${where === "" ? "WHERE" : " AND"} (instr(report.diagnostic_number, ?) > 0 OR instr(report.app_build, ?) > 0)`;
      values.push(parsed.keyword, parsed.keyword);
    }
    return this.read(() => this.database.transaction(() => {
      const count = this.database.prepare(`SELECT COUNT(*) AS total FROM diagnostic_reports AS report ${where}`).get(...values) as { total: number };
      const totalPages = Math.max(1, Math.ceil(count.total / parsed.limit));
      const page = Math.min(parsed.page, totalPages);
      const records = this.database.prepare(`SELECT ${REPORT_COLUMNS} FROM diagnostic_reports AS report
        ${where} ORDER BY report.received_at DESC, report.id DESC LIMIT ? OFFSET ?`)
        .all(...values, parsed.limit, (page - 1) * parsed.limit) as ReportRow[];
      return Object.freeze({ feedback: Object.freeze(records.map(safeReport)),
        pagination: Object.freeze({ page, pageSize: parsed.limit, total: count.total, totalPages }) });
    })());
  }

  detail(id: string): FeedbackDetail {
    if (!isInternalId(id)) fail("ADMIN_INVALID_REQUEST");
    return this.read(() => {
      const row = this.database.prepare(
        `SELECT ${REPORT_COLUMNS}
         FROM diagnostic_reports AS report
         WHERE report.id = ?`,
      ).get(id) as ReportRow | undefined;
      if (row === undefined) fail("ADMIN_FEEDBACK_NOT_FOUND");
      const events = (this.database.prepare(
        `SELECT event_index, occurred_at, category, task_ref, stage, code,
                duration_ms, http_status
         FROM diagnostic_events
         WHERE report_id = ?
         ORDER BY event_index`,
      ).all(id) as EventRow[]).map(safeEvent);
      return Object.freeze({ ...safeReport(row), events: Object.freeze(events) });
    });
  }

  private read<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      if (error instanceof FeedbackAdminError) throw error;
      return fail("ADMIN_SERVICE_UNAVAILABLE");
    }
  }
}
