import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";

import { parseStrictJson } from "../../billing/strictJson.js";
import { isInternalId } from "../../ids/internalId.js";
import {
  AdminFailure,
  requireMenu,
  type AdminIdentity,
} from "./adminAuthorization.js";
import {
  AdminAccountError,
  type AdminAccountRepository,
} from "./adminAccountRepository.js";
import {
  AdminAuditError,
  type AdminAuditRepository,
} from "./adminAuditRepository.js";
import { renderAdminDocument } from "./adminDocument.js";
import {
  FeedbackAdminError,
  type FeedbackAdminService,
} from "./feedbackAdminService.js";
import {
  OrderAdminError,
  type OrderAdminService,
} from "./orderAdminService.js";
import {
  OfferAdminError,
  type OfferAdminService,
} from "./offerAdminService.js";
import {
  ModelAdminError,
  type ModelAdminAdapter,
} from "./modelAdminAdapter.js";
import {
  SmsAdminError,
  type SmsAdminAdapter,
} from "./smsAdminAdapter.js";
import {
  AdminCredentialError,
  createAdminSetupSecret,
  normalizeAdminUsername,
  verifyAdminPassword,
} from "./adminPassword.js";
import type { AdminRateLimiter } from "./adminRateLimiter.js";
import {
  deriveAdminSetupPassword,
  parseAdminSetupMaterial,
} from "./adminSetupConsumption.js";
import {
  ADMIN_CSRF_HEADER,
  AdminSessionFailure,
  type AdminMutationProof,
  type AdminSessionStore,
} from "./adminSession.js";
import type {
  AdminMenuCode,
  AdminPasswordHash,
} from "./adminTypes.js";
import {
  UserAdminError,
  type UserAdminService,
} from "./userAdminService.js";

const BODY_LIMIT = 4 * 1_024;
const SETUP_TTL_MS = 10 * 60_000;
const ASSET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const INTERNAL_ID_PREFIX_PATTERN = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{1,32}$/u;

export const ADMIN_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

type ApiFailureCode =
  | "ADMIN_AUTH_REQUIRED"
  | "ADMIN_AUTH_FAILED"
  | "ADMIN_ACCESS_DENIED"
  | "ADMIN_CSRF_REJECTED"
  | "ADMIN_INVALID_REQUEST"
  | "ADMIN_BODY_TOO_LARGE"
  | "ADMIN_UNSUPPORTED_MEDIA_TYPE"
  | "ADMIN_ACCOUNT_NOT_FOUND"
  | "ADMIN_USER_NOT_FOUND"
  | "ADMIN_FEEDBACK_NOT_FOUND"
  | "ADMIN_ORDER_NOT_FOUND"
  | "ADMIN_OFFER_NOT_FOUND"
  | "ADMIN_OFFER_INVALID"
  | "ADMIN_OFFER_IMMUTABLE"
  | "ADMIN_OFFER_SCHEDULE_CONFLICT"
  | "ADMIN_MODEL_NOT_FOUND"
  | "ADMIN_MODEL_TEST_FAILED"
  | "ADMIN_MODEL_STATE_CONFLICT"
  | "ADMIN_SMS_NOT_FOUND"
  | "ADMIN_SMS_TEST_FAILED"
  | "ADMIN_SMS_RATE_LIMITED"
  | "ADMIN_SMS_STATE_CONFLICT"
  | "ADMIN_USERNAME_UNAVAILABLE"
  | "ADMIN_SETUP_REJECTED"
  | "ADMIN_REVISION_CONFLICT"
  | "ADMIN_RATE_LIMITED"
  | "ADMIN_SERVICE_UNAVAILABLE";

class UnifiedAdminApiFailure extends Error {
  constructor(readonly code: ApiFailureCode, readonly statusCode: number) {
    super(code);
    this.name = "UnifiedAdminApiFailure";
  }
}

type Asset = Readonly<{
  body: Buffer;
  contentType: string;
}>;

type Manifest = Readonly<{
  files: Readonly<Record<string, Readonly<{ bytes: number; sha256: string }>>>;
}>;

export type UnifiedAdminRoutesOptions = Readonly<{
  accounts: AdminAccountRepository;
  audit: AdminAuditRepository;
  sessions: AdminSessionStore;
  rateLimiter: AdminRateLimiter;
  setupRateLimiter: AdminRateLimiter;
  fallbackPasswordHash: AdminPasswordHash;
  origin: string;
  now?: () => Date;
  assetRoot?: string;
  users?: UserAdminService;
  feedback?: FeedbackAdminService;
  orders?: OrderAdminService;
  offers?: OfferAdminService;
  models?: ModelAdminAdapter;
  sms?: SmsAdminAdapter;
}>;

const loginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
}).strict();

const setupConsumeBody = z.object({
  token: z.string().min(1).max(76),
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
}).strict();

const resetConsumeBody = z.object({
  token: z.string().min(1).max(76),
  password: z.string().min(1).max(128),
}).strict();

const revisionBody = z.object({
  expectedRevision: z.number().int().min(1),
}).strict();

const permissionsBody = z.object({
  expectedRevision: z.number().int().min(1),
  permissions: z.array(z.string().min(1).max(64)).max(8),
}).strict();

const setupLinkBody = z.discriminatedUnion("purpose", [
  z.object({ purpose: z.literal("create_administrator") }).strict(),
  z.object({
    purpose: z.literal("reset_administrator"),
    accountId: z.string(),
    expectedRevision: z.number().int().min(1),
  }).strict(),
]);

const internalIdPrefixQuery = z.string()
  .min(1)
  .max(32)
  .transform((value) => value.toUpperCase())
  .refine((value) => INTERNAL_ID_PREFIX_PATTERN.test(value));

const listLimitQuery = z.string()
  .regex(/^[1-9][0-9]{0,2}$/u)
  .transform(Number)
  .refine((value) => value <= 100);

const userSearchQuery = z.object({
  page: z.string().regex(/^[1-9][0-9]*$/u).max(16).transform(Number)
    .refine(Number.isSafeInteger).optional(),
  status: z.enum(["enabled", "disabled"]).optional(),
  phone: z.string().optional(),
  idPrefix: internalIdPrefixQuery.optional(),
  limit: listLimitQuery.optional(),
}).strict();

const idPrefixSearchQuery = z.object({
  page: z.string().regex(/^[1-9][0-9]*$/u).max(16).transform(Number).refine(Number.isSafeInteger).optional(),
  status: z.string().min(1).max(64).optional(),
  keyword: z.string().trim().min(1).max(128).optional(),
  idPrefix: internalIdPrefixQuery.optional(),
  limit: listLimitQuery.optional(),
}).strict();

const orderSearchQuery = idPrefixSearchQuery.extend({
  userId: internalIdPrefixQuery.refine((value) => value.length === 32).optional(),
});

function filteredPage<T extends Readonly<{ id: string }>>(
  key: string, values: readonly T[],
  query: Readonly<{ idPrefix?: string | undefined; limit?: number | undefined;
    page?: number | undefined; status?: string | undefined; keyword?: string | undefined }>,
): Readonly<Record<string, unknown>> {
  const filtered = values.filter((value) => {
    const row = value as Readonly<Record<string, unknown>>;
    const state = row.state ?? row.status ?? row.lifecycleState ?? row.lifecycle;
    const searchable = [row.displayName, row.username, row.semanticVersion, row.buildNumber,
      row.modelId, row.templateCode].filter((item) => typeof item === "string").join(" ").toLowerCase();
    return (query.idPrefix === undefined || value.id.startsWith(query.idPrefix)) &&
      (query.status === undefined || state === query.status) &&
      (query.keyword === undefined || searchable.includes(query.keyword.toLowerCase()));
  });
  const pageSize = query.limit ?? 20;
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(query.page ?? 1, totalPages);
  return Object.freeze({ [key]: Object.freeze(filtered.slice((page - 1) * pageSize, page * pageSize)),
    pagination: Object.freeze({ page, pageSize, total, totalPages }) });
}

const offerDraftBody = z.object({
  remark: z.string().trim().max(500).optional(),
  productCode: z.string().min(1).max(128),
  displayName: z.string().trim().min(1).max(80),
  productType: z.enum(["membership", "addon"]),
  tierCode: z.string().min(1).max(128),
  currency: z.string().min(1).max(16),
  amountFen: z.number().int().positive().max(100_000_000),
  quotaAmount: z.number().int().min(60_000).max(3_600_000_000_000).multipleOf(60_000),
  quotaUnit: z.string().min(1).max(64),
  includedDurationMs: z.number().int().min(60_000).max(3_600_000_000_000).multipleOf(60_000),
  periodUnit: z.enum(["calendar_month", "calendar_year"]),
  periodCount: z.number().int().positive().max(120),
  timezone: z.string().min(1).max(64),
  rollover: z.boolean(),
  autoRenew: z.boolean(),
  activeMemberRepurchase: z.boolean(),
  effectiveAt: z.string().min(1).max(64),
}).strict();

const offerUpdateBody = offerDraftBody.extend({
  expectedRevision: z.number().int().min(1),
}).strict();

const modelDraftBody = z.object({
  supersedesId: z.string().nullable().optional(),
  capability: z.literal("realtime-asr"),
  providerKind: z.enum([
    "bailian-qwen-realtime",
    "bailian-streaming-asr",
  ]),
  displayName: z.string().min(1).max(80),
  endpoint: z.string().min(1).max(2_048).url(),
  modelId: z.enum([
    "qwen3-asr-flash-realtime",
    "qwen3-asr-flash-realtime-2026-02-10",
    "fun-asr-realtime",
    "paraformer-realtime-v2",
  ]),
  credential: z.string().min(1).max(16_384),
}).strict();

const modelRollbackBody = z.object({
  capability: z.literal("realtime-asr"),
}).strict();

const smsDraftBody = z.object({
  expectedRevision: z.number().int().min(1).nullable().optional(),
  templateCode: z.string().regex(/^SMS_[0-9]{6,32}$/u),
  accessKeyId: z.string().min(1).max(512),
  accessKeySecret: z.string().min(1).max(512),
}).strict();

const smsTestBody = z.object({
  expectedRevision: z.number().int().min(1),
  phone: z.string().regex(/^\+861[3-9][0-9]{9}$/u),
}).strict();

function fail(code: ApiFailureCode, statusCode: number): never {
  throw new UnifiedAdminApiFailure(code, statusCode);
}

function secure(reply: FastifyReply): FastifyReply {
  return reply
    .header("cache-control", "no-store")
    .header("content-security-policy", ADMIN_CSP)
    .header("x-content-type-options", "nosniff")
    .header("referrer-policy", "no-referrer")
    .header("x-frame-options", "DENY");
}

function stringHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requireNoQuery(request: FastifyRequest): void {
  if (
    request.query === null ||
    typeof request.query !== "object" ||
    Object.keys(request.query as Record<string, unknown>).length !== 0
  ) {
    fail("ADMIN_INVALID_REQUEST", 400);
  }
}

function requireEmptyBody(request: FastifyRequest): void {
  if (
    request.body !== undefined ||
    request.headers["content-type"] !== undefined ||
    (request.headers["content-length"] !== undefined &&
      request.headers["content-length"] !== "0")
  ) {
    fail("ADMIN_INVALID_REQUEST", 400);
  }
}

function requireJson(request: FastifyRequest): void {
  const contentType = stringHeader(request.headers["content-type"]);
  if (contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    fail("ADMIN_UNSUPPORTED_MEDIA_TYPE", 415);
  }
}

function parseBody<T>(schema: z.ZodType<T>, request: FastifyRequest): T {
  requireJson(request);
  if (typeof request.body !== "string") fail("ADMIN_INVALID_REQUEST", 400);
  let decoded: unknown;
  try {
    decoded = parseStrictJson(request.body);
  } catch {
    return fail("ADMIN_INVALID_REQUEST", 400);
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) fail("ADMIN_INVALID_REQUEST", 400);
  return parsed.data;
}

function safeNow(source: () => Date): Readonly<{ date: Date; iso: string }> {
  const value = source();
  if (!(value instanceof Date)) fail("ADMIN_SERVICE_UNAVAILABLE", 503);
  const epoch = Date.prototype.getTime.call(value);
  if (!Number.isFinite(epoch)) fail("ADMIN_SERVICE_UNAVAILABLE", 503);
  const date = new Date(epoch);
  return Object.freeze({ date, iso: date.toISOString() });
}

function cookie(request: FastifyRequest): string {
  return stringHeader(request.headers.cookie) ?? "";
}

function assertSameOrigin(request: FastifyRequest, origin: string): void {
  const expected = new URL(origin);
  if (
    stringHeader(request.headers.origin) !== expected.origin ||
    stringHeader(request.headers.host) !== expected.host
  ) {
    fail("ADMIN_CSRF_REJECTED", 403);
  }
}

function mutationBoundary(request: FastifyRequest) {
  return Object.freeze({
    cookie: cookie(request),
    csrfToken: stringHeader(request.headers[ADMIN_CSRF_HEADER]) ?? "",
    host: stringHeader(request.headers.host) ?? "",
    origin: stringHeader(request.headers.origin) ?? "",
  });
}

function sameOriginBoundary(request: FastifyRequest) {
  return Object.freeze({
    cookie: cookie(request),
    host: stringHeader(request.headers.host) ?? "",
    origin: stringHeader(request.headers.origin) ?? "",
  });
}

function sessionView(identity: AdminIdentity) {
  return Object.freeze({
    account: Object.freeze({
      username: identity.username,
      kind: identity.kind,
    }),
    menus: identity.menus,
  });
}

function clearHash(hash: AdminPasswordHash): void {
  hash.salt.fill(0);
  hash.digest.fill(0);
}

function contentType(name: string): string {
  if (name.startsWith("licenses/") && name.endsWith("-LICENSE")) {
    return "text/plain; charset=utf-8";
  }
  switch (extname(name)) {
    case ".css": return "text/css; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".txt": return "text/plain; charset=utf-8";
    case ".woff": return "font/woff";
    case ".woff2": return "font/woff2";
    case ".ttf": return "font/ttf";
    default: return fail("ADMIN_SERVICE_UNAVAILABLE", 503);
  }
}

function validManifest(value: unknown): value is Manifest {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== 1 ||
    !("files" in value) ||
    value.files === null ||
    typeof value.files !== "object" ||
    Object.getPrototypeOf(value.files) !== Object.prototype
  ) return false;
  for (const [name, entry] of Object.entries(value.files)) {
    if (
      !ASSET_NAME_PATTERN.test(name) ||
      name.split("/").some((part) => part === "." || part === "..") ||
      entry === null ||
      typeof entry !== "object" ||
      Object.getPrototypeOf(entry) !== Object.prototype ||
      Object.keys(entry).length !== 2 ||
      !("bytes" in entry) ||
      !("sha256" in entry) ||
      !Number.isSafeInteger(entry.bytes) ||
      (entry.bytes as number) < 0 ||
      typeof entry.sha256 !== "string" ||
      !SHA256_PATTERN.test(entry.sha256)
    ) return false;
  }
  return true;
}

function loadAssets(candidateRoot: string): ReadonlyMap<string, Asset> {
  const rootMetadata = lstatSync(candidateRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new TypeError("Invalid unified administrator asset root");
  }
  const root = realpathSync(candidateRoot);
  const manifestPath = resolve(root, "manifest.json");
  const manifestMetadata = lstatSync(manifestPath);
  if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()) {
    throw new TypeError("Invalid unified administrator asset manifest");
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  } catch {
    throw new TypeError("Invalid unified administrator asset manifest");
  }
  if (!validManifest(manifest)) {
    throw new TypeError("Invalid unified administrator asset manifest");
  }
  const assets = new Map<string, Asset>();
  for (const [name, expected] of Object.entries(manifest.files)) {
    const path = resolve(root, name);
    const relation = relative(root, path);
    if (relation.startsWith("..") || relation === "") {
      throw new TypeError("Invalid unified administrator asset path");
    }
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new TypeError("Invalid unified administrator asset file");
    }
    const actual = realpathSync(path);
    const actualRelation = relative(root, actual);
    if (actualRelation.startsWith("..") || actualRelation === "") {
      throw new TypeError("Invalid unified administrator asset file");
    }
    const body = readFileSync(actual);
    const digest = createHash("sha256").update(body).digest("hex");
    if (body.length !== expected.bytes || digest !== expected.sha256) {
      body.fill(0);
      throw new TypeError("Invalid unified administrator asset integrity");
    }
    assets.set(name, Object.freeze({ body, contentType: contentType(name) }));
  }
  return assets;
}

function sendFailure(reply: FastifyReply, error: unknown): FastifyReply {
  let failure: Readonly<{ code: ApiFailureCode; statusCode: number }>;
  if (error instanceof UnifiedAdminApiFailure || error instanceof AdminSessionFailure) {
    failure = error;
  } else if (error instanceof AdminFailure) {
    failure = error;
  } else if (error instanceof AdminAccountError) {
    switch (error.code) {
      case "ADMIN_ACCOUNT_NOT_FOUND": failure = { code: error.code, statusCode: 404 }; break;
      case "ADMIN_REVISION_CONFLICT": failure = { code: error.code, statusCode: 409 }; break;
      case "ADMIN_ACCESS_DENIED": failure = { code: error.code, statusCode: 403 }; break;
      case "ADMIN_USERNAME_UNAVAILABLE": failure = { code: error.code, statusCode: 409 }; break;
      case "ADMIN_INVALID_REQUEST":
      case "ADMIN_SETUP_REJECTED": failure = { code: error.code, statusCode: 400 }; break;
      default: failure = { code: "ADMIN_SERVICE_UNAVAILABLE", statusCode: 503 };
    }
  } else if (error instanceof AdminCredentialError) {
    failure = { code: "ADMIN_INVALID_REQUEST", statusCode: 400 };
  } else if (error instanceof AdminAuditError) {
    failure = { code: "ADMIN_SERVICE_UNAVAILABLE", statusCode: 503 };
  } else if (error instanceof UserAdminError) {
    switch (error.code) {
      case "ADMIN_USER_NOT_FOUND": failure = { code: error.code, statusCode: 404 }; break;
      case "ADMIN_REVISION_CONFLICT": failure = { code: error.code, statusCode: 409 }; break;
      case "ADMIN_INVALID_REQUEST": failure = { code: error.code, statusCode: 400 }; break;
      default: failure = { code: "ADMIN_SERVICE_UNAVAILABLE", statusCode: 503 };
    }
  } else if (error instanceof FeedbackAdminError) {
    switch (error.code) {
      case "ADMIN_FEEDBACK_NOT_FOUND": failure = { code: error.code, statusCode: 404 }; break;
      case "ADMIN_INVALID_REQUEST": failure = { code: error.code, statusCode: 400 }; break;
      default: failure = { code: "ADMIN_SERVICE_UNAVAILABLE", statusCode: 503 };
    }
  } else if (error instanceof OrderAdminError) {
    switch (error.code) {
      case "ADMIN_ORDER_NOT_FOUND": failure = { code: error.code, statusCode: 404 }; break;
      case "ADMIN_INVALID_REQUEST": failure = { code: error.code, statusCode: 400 }; break;
      default: failure = { code: "ADMIN_SERVICE_UNAVAILABLE", statusCode: 503 };
    }
  } else if (error instanceof OfferAdminError) {
    switch (error.code) {
      case "ADMIN_OFFER_NOT_FOUND": failure = { code: error.code, statusCode: 404 }; break;
      case "ADMIN_OFFER_IMMUTABLE":
      case "ADMIN_OFFER_SCHEDULE_CONFLICT":
      case "ADMIN_REVISION_CONFLICT": failure = { code: error.code, statusCode: 409 }; break;
      case "ADMIN_OFFER_INVALID":
      case "ADMIN_INVALID_REQUEST": failure = { code: error.code, statusCode: 400 }; break;
      default: failure = { code: "ADMIN_SERVICE_UNAVAILABLE", statusCode: 503 };
    }
  } else if (error instanceof ModelAdminError) {
    switch (error.code) {
      case "ADMIN_MODEL_NOT_FOUND": failure = { code: error.code, statusCode: 404 }; break;
      case "ADMIN_MODEL_TEST_FAILED":
      case "ADMIN_MODEL_STATE_CONFLICT":
      case "ADMIN_REVISION_CONFLICT": failure = { code: error.code, statusCode: 409 }; break;
      case "ADMIN_INVALID_REQUEST": failure = { code: error.code, statusCode: 400 }; break;
      default: failure = { code: "ADMIN_SERVICE_UNAVAILABLE", statusCode: 503 };
    }
  } else if (error instanceof SmsAdminError) {
    switch (error.code) {
      case "ADMIN_SMS_NOT_FOUND": failure = { code: error.code, statusCode: 404 }; break;
      case "ADMIN_SMS_RATE_LIMITED": failure = { code: error.code, statusCode: 429 }; break;
      case "ADMIN_SMS_TEST_FAILED":
      case "ADMIN_SMS_STATE_CONFLICT":
      case "ADMIN_REVISION_CONFLICT": failure = { code: error.code, statusCode: 409 }; break;
      case "ADMIN_INVALID_REQUEST": failure = { code: error.code, statusCode: 400 }; break;
      default: failure = { code: "ADMIN_SERVICE_UNAVAILABLE", statusCode: 503 };
    }
  } else {
    failure = { code: "ADMIN_SERVICE_UNAVAILABLE", statusCode: 503 };
  }
  const message = failure.code === "ADMIN_AUTH_FAILED"
    ? "账户或密码错误"
    : "管理后台请求被拒绝";
  return secure(reply).code(failure.statusCode).send({
    code: failure.code,
    message,
  });
}

function sendSetupFailure(reply: FastifyReply, error: unknown): FastifyReply {
  let statusCode: number;
  if (error instanceof UnifiedAdminApiFailure) {
    statusCode = error.statusCode;
  } else if (error instanceof AdminAccountError) {
    statusCode = error.code === "ADMIN_SERVICE_UNAVAILABLE" ? 503 : 400;
  } else if (error instanceof AdminSessionFailure) {
    statusCode = error.code === "ADMIN_SERVICE_UNAVAILABLE" ? 503 : 400;
  } else if (error instanceof AdminCredentialError) {
    statusCode = 400;
  } else if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    switch (error.code) {
      case "FST_ERR_CTP_BODY_TOO_LARGE": statusCode = 413; break;
      case "FST_ERR_CTP_INVALID_MEDIA_TYPE": statusCode = 415; break;
      case "FST_ERR_CTP_EMPTY_JSON_BODY":
      case "FST_ERR_CTP_INVALID_JSON_BODY":
      case "FST_ERR_CTP_INVALID_CONTENT_LENGTH": statusCode = 400; break;
      default: statusCode = 503;
    }
  } else statusCode = 503;
  return secure(reply).code(statusCode).send({
    code: "ADMIN_SETUP_REJECTED",
    message: "管理后台请求被拒绝",
  });
}

function isSetupConsumptionRequest(request: FastifyRequest): boolean {
  return request.routeOptions.url === "/console/api/v1/setup/consume" ||
    request.routeOptions.url === "/console/api/v1/reset/consume";
}

function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (isSetupConsumptionRequest(request)) {
    return sendSetupFailure(reply, error);
  }
  if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
    return sendFailure(reply, new UnifiedAdminApiFailure("ADMIN_BODY_TOO_LARGE", 413));
  }
  if (error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
    return sendFailure(reply, new UnifiedAdminApiFailure("ADMIN_UNSUPPORTED_MEDIA_TYPE", 415));
  }
  if (
    error.code === "FST_ERR_CTP_EMPTY_JSON_BODY" ||
    error.code === "FST_ERR_CTP_INVALID_JSON_BODY" ||
    error.code === "FST_ERR_CTP_INVALID_CONTENT_LENGTH"
  ) {
    return sendFailure(reply, new UnifiedAdminApiFailure("ADMIN_INVALID_REQUEST", 400));
  }
  return sendFailure(reply, error);
}

function setupRateLimitSubject(tokenId: string): string {
  return `setup.${tokenId}`;
}

function parseAccountId(request: FastifyRequest): string {
  const parsed = z.object({ id: z.string() }).strict().safeParse(request.params);
  if (!parsed.success || !isInternalId(parsed.data.id)) {
    fail("ADMIN_INVALID_REQUEST", 400);
  }
  return parsed.data.id;
}

function authorizeMutation(
  request: FastifyRequest,
  sessions: AdminSessionStore,
  menu: AdminMenuCode,
): AdminMutationProof {
  const proof = sessions.authorizeMutation(mutationBoundary(request));
  try {
    requireMenu(proof.identity, menu);
    return proof;
  } catch (error) {
    sessions.abortMutation(proof);
    throw error;
  }
}

export function registerUnifiedAdminRoutes(
  app: FastifyInstance,
  options: UnifiedAdminRoutesOptions,
): void {
  if (
    options === null ||
    typeof options !== "object" ||
    typeof options.origin !== "string" ||
    (options.now !== undefined && typeof options.now !== "function") ||
    (options.assetRoot !== undefined && typeof options.assetRoot !== "string")
  ) {
    throw new TypeError("Invalid unified administrator route options");
  }
  const expectedOrigin = new URL(options.origin);
  if (expectedOrigin.origin !== options.origin) {
    throw new TypeError("Invalid unified administrator route options");
  }
  const now = options.now ?? (() => new Date());
  const defaultAssetRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../dist/admin/assets",
  );
  const assets = loadAssets(options.assetRoot ?? defaultAssetRoot);

  void app.register(async (routes) => {
    routes.removeContentTypeParser("application/json");
    routes.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      (_request, body, done) => done(null, body),
    );
    routes.setErrorHandler(errorHandler);
    routes.addHook("onRequest", (_request, reply, done) => {
      secure(reply);
      done();
    });

    routes.get("/console/", { exposeHeadRoute: false }, async (request, reply) => {
      requireNoQuery(request);
      return reply
        .header("content-type", "text/html; charset=utf-8")
        .send(renderAdminDocument());
    });

    routes.get("/console/assets/*", { exposeHeadRoute: false }, async (request, reply) => {
      requireNoQuery(request);
      const parsed = z.object({ "*": z.string() }).strict().safeParse(request.params);
      if (!parsed.success) fail("ADMIN_INVALID_REQUEST", 400);
      const asset = assets.get(parsed.data["*"]);
      if (asset === undefined) return reply.code(404).send();
      return reply.header("content-type", asset.contentType).send(asset.body);
    });

    routes.post(
      "/console/api/v1/setup/consume",
      { bodyLimit: BODY_LIMIT },
      async (request, reply) => {
        let material: ReturnType<typeof parseAdminSetupMaterial> | undefined;
        let password: AdminPasswordHash | undefined;
        let rateSubject: string | undefined;
        let rateEpoch: number | undefined;
        let reserved = false;
        try {
          requireNoQuery(request);
          assertSameOrigin(request, options.origin);
          const submitted = parseBody(setupConsumeBody, request);
          material = parseAdminSetupMaterial(submitted.token);
          rateSubject = setupRateLimitSubject(material.tokenId);
          const reservationTime = safeNow(now);
          rateEpoch = reservationTime.date.getTime();
          reserved = options.setupRateLimiter.reserve(
            rateSubject,
            request.ip,
            rateEpoch,
          );
          if (!reserved) {
            return sendSetupFailure(
              reply,
              new UnifiedAdminApiFailure("ADMIN_SETUP_REJECTED", 429),
            );
          }
          password = await deriveAdminSetupPassword(submitted.password);
          const consumedAt = safeNow(now).iso;
          try {
            options.accounts.consumeInitialSuperadmin({
              tokenId: material.tokenId,
              digest: material.digest,
              username: submitted.username,
              password,
              now: consumedAt,
            });
          } catch (error) {
            if (!(error instanceof AdminAccountError) ||
                error.code !== "ADMIN_SETUP_REJECTED") {
              throw error;
            }
            options.accounts.consumeCreateAdministrator({
              tokenId: material.tokenId,
              digest: material.digest,
              username: submitted.username,
              password,
              permissions: [],
              now: consumedAt,
            });
          }
          options.setupRateLimiter.recordSuccess(rateSubject, request.ip, rateEpoch);
          reserved = false;
          return reply.code(204).send();
        } catch (error) {
          if (reserved && rateSubject !== undefined && rateEpoch !== undefined) {
            try {
              options.setupRateLimiter.recordFailure(
                rateSubject,
                request.ip,
                rateEpoch,
              );
            } catch {
              return sendSetupFailure(
                reply,
                new UnifiedAdminApiFailure("ADMIN_SETUP_REJECTED", 503),
              );
            }
          }
          return sendSetupFailure(reply, error);
        } finally {
          if (password !== undefined) clearHash(password);
          material?.digest.fill(0);
        }
      },
    );

    routes.post(
      "/console/api/v1/reset/consume",
      { bodyLimit: BODY_LIMIT },
      async (request, reply) => {
        let material: ReturnType<typeof parseAdminSetupMaterial> | undefined;
        let password: AdminPasswordHash | undefined;
        let rateSubject: string | undefined;
        let rateEpoch: number | undefined;
        let reserved = false;
        try {
          requireNoQuery(request);
          assertSameOrigin(request, options.origin);
          const submitted = parseBody(resetConsumeBody, request);
          material = parseAdminSetupMaterial(submitted.token);
          rateSubject = setupRateLimitSubject(material.tokenId);
          const reservationTime = safeNow(now);
          rateEpoch = reservationTime.date.getTime();
          reserved = options.setupRateLimiter.reserve(
            rateSubject,
            request.ip,
            rateEpoch,
          );
          if (!reserved) {
            return sendSetupFailure(
              reply,
              new UnifiedAdminApiFailure("ADMIN_SETUP_REJECTED", 429),
            );
          }
          password = await deriveAdminSetupPassword(submitted.password);
          const consumedAt = safeNow(now).iso;
          const account = options.accounts.consumePasswordReset({
            tokenId: material.tokenId,
            digest: material.digest,
            password,
            now: consumedAt,
          });
          options.sessions.revokeStaleAccountSessions(account);
          options.setupRateLimiter.recordSuccess(rateSubject, request.ip, rateEpoch);
          reserved = false;
          return reply.code(204).send();
        } catch (error) {
          if (reserved && rateSubject !== undefined && rateEpoch !== undefined) {
            try {
              options.setupRateLimiter.recordFailure(
                rateSubject,
                request.ip,
                rateEpoch,
              );
            } catch {
              return sendSetupFailure(
                reply,
                new UnifiedAdminApiFailure("ADMIN_SETUP_REJECTED", 503),
              );
            }
          }
          return sendSetupFailure(reply, error);
        } finally {
          if (password !== undefined) clearHash(password);
          material?.digest.fill(0);
        }
      },
    );

    routes.post(
      "/console/api/v1/session/login",
      { bodyLimit: BODY_LIMIT },
      async (request, reply) => {
        requireNoQuery(request);
        assertSameOrigin(request, options.origin);
        const submitted = parseBody(loginBody, request);
        let username: string;
        try {
          username = normalizeAdminUsername(submitted.username);
        } catch {
          username = "invalid.login";
        }
        const epoch = safeNow(now).date.getTime();
        if (!options.rateLimiter.reserve(username, request.ip, epoch)) {
          const retryAfter = options.rateLimiter.retryAfterSeconds(
            username,
            request.ip,
            epoch,
          );
          options.audit.record({
            occurredAt: new Date(epoch).toISOString(),
            requestRef: request.id,
            action: "rate_limited",
            result: "rate_limited",
          });
          reply.header("retry-after", String(retryAfter));
          return sendFailure(reply, new UnifiedAdminApiFailure("ADMIN_RATE_LIMITED", 429));
        }

        let authentication: ReturnType<AdminAccountRepository["authenticationByUsername"]> = null;
        let accepted = false;
        try {
          try {
            authentication = options.accounts.authenticationByUsername(username);
          } catch (error) {
            if (!(error instanceof AdminCredentialError)) throw error;
          }
          const selected = authentication?.password ?? options.fallbackPasswordHash;
          try {
            accepted = await verifyAdminPassword(submitted.password, selected);
          } catch (error) {
            if (!(error instanceof AdminCredentialError)) throw error;
          }
        } finally {
          if (authentication !== null) clearHash(authentication.password);
        }

        if (!accepted || authentication === null) {
          options.rateLimiter.recordFailure(username, request.ip, epoch);
          options.audit.record({
            occurredAt: new Date(epoch).toISOString(),
            requestRef: request.id,
            action: "login",
            result: "rejected",
          });
          return sendFailure(reply, new UnifiedAdminApiFailure("ADMIN_AUTH_FAILED", 401));
        }

        options.rateLimiter.recordSuccess(username, request.ip, epoch);
        const issued = options.sessions.login(authentication.account);
        try {
          options.audit.record({
            occurredAt: new Date(epoch).toISOString(),
            actorAdminId: issued.identity.accountId,
            actorUsernameSnapshot: issued.identity.username,
            requestRef: request.id,
            action: "login",
            result: "accepted",
            targetRevision: issued.identity.accountRevision,
          });
        } catch (error) {
          options.sessions.revokeIssuedSession(issued.cookie);
          throw error;
        }
        return reply
          .header("set-cookie", issued.cookie)
          .header(ADMIN_CSRF_HEADER, issued.csrfToken)
          .send(sessionView(issued.identity));
      },
    );

    routes.get("/console/api/v1/session", async (request) => {
      requireNoQuery(request);
      requireEmptyBody(request);
      return sessionView(options.sessions.authenticate(cookie(request)));
    });

    routes.post("/console/api/v1/session/csrf", async (request, reply) => {
      requireNoQuery(request);
      requireEmptyBody(request);
      const issued = options.sessions.issueCsrf(sameOriginBoundary(request));
      return reply.header(ADMIN_CSRF_HEADER, issued.csrfToken).code(204).send();
    });

    routes.post("/console/api/v1/session/logout", async (request, reply) => {
      requireNoQuery(request);
      requireEmptyBody(request);
      const proof = options.sessions.authorizeMutation(mutationBoundary(request));
      const cleared = options.sessions.logout(proof);
      options.audit.record({
        occurredAt: safeNow(now).iso,
        actorAdminId: proof.identity.accountId,
        actorUsernameSnapshot: proof.identity.username,
        requestRef: request.id,
        action: "logout",
        result: "accepted",
        targetRevision: proof.identity.accountRevision,
      });
      return reply.header("set-cookie", cleared).code(204).send();
    });

    routes.get("/console/api/v1/accounts", async (request) => {
      requireEmptyBody(request);
      const identity = options.sessions.authenticate(cookie(request));
      requireMenu(identity, "accounts.list");
      const parsed = idPrefixSearchQuery.safeParse(request.query);
      if (!parsed.success) fail("ADMIN_INVALID_REQUEST", 400);
      return Object.freeze({
        ...filteredPage("accounts", options.accounts.listActive(), parsed.data),
      });
    });

    routes.put(
      "/console/api/v1/accounts/:id/permissions",
      { bodyLimit: BODY_LIMIT },
      async (request, reply) => {
        requireNoQuery(request);
        const proof = authorizeMutation(request, options.sessions, "accounts.list");
        try {
          const accountId = parseAccountId(request);
          const submitted = parseBody(permissionsBody, request);
          const account = options.accounts.replacePermissions({
            accountId,
            expectedRevision: submitted.expectedRevision,
            permissions: submitted.permissions as readonly AdminMenuCode[],
            actorId: proof.identity.accountId,
            now: safeNow(now).iso,
          });
          const rotated = options.sessions.commitMutation(proof);
          return reply.header(ADMIN_CSRF_HEADER, rotated.csrfToken).send({ account });
        } catch (error) {
          try { options.sessions.abortMutation(proof); } catch { /* consumed */ }
          throw error;
        }
      },
    );

    routes.delete(
      "/console/api/v1/accounts/:id",
      { bodyLimit: BODY_LIMIT },
      async (request, reply) => {
        requireNoQuery(request);
        const proof = authorizeMutation(request, options.sessions, "accounts.list");
        try {
          const accountId = parseAccountId(request);
          const submitted = parseBody(revisionBody, request);
          options.accounts.deleteOrdinary({
            accountId,
            expectedRevision: submitted.expectedRevision,
            actorId: proof.identity.accountId,
            now: safeNow(now).iso,
          });
          const rotated = options.sessions.commitMutation(proof);
          return reply.header(ADMIN_CSRF_HEADER, rotated.csrfToken).code(204).send();
        } catch (error) {
          try { options.sessions.abortMutation(proof); } catch { /* consumed */ }
          throw error;
        }
      },
    );

    routes.post(
      "/console/api/v1/accounts/setup-links",
      { bodyLimit: BODY_LIMIT },
      async (request, reply) => {
        requireNoQuery(request);
        const proof = authorizeMutation(request, options.sessions, "accounts.list");
        let secret: ReturnType<typeof createAdminSetupSecret> | undefined;
        try {
          const submitted = parseBody(setupLinkBody, request);
          const issuedAt = safeNow(now).date;
          const expiresAt = new Date(issuedAt.getTime() + SETUP_TTL_MS);
          if (submitted.purpose === "reset_administrator") {
            if (!isInternalId(submitted.accountId)) fail("ADMIN_INVALID_REQUEST", 400);
            const target = options.accounts.activeById(submitted.accountId);
            if (target === null) fail("ADMIN_ACCOUNT_NOT_FOUND", 404);
            if (target.kind !== "administrator") fail("ADMIN_ACCESS_DENIED", 403);
            if (target.revision !== submitted.expectedRevision) {
              fail("ADMIN_REVISION_CONFLICT", 409);
            }
          }
          secret = createAdminSetupSecret();
          const issued = options.accounts.issueSetupToken({
            purpose: submitted.purpose,
            digest: secret.digest,
            now: issuedAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
            issuedByAdminId: proof.identity.accountId,
            ...(submitted.purpose === "reset_administrator"
              ? { adminAccountId: submitted.accountId }
              : {}),
          });
          const fragment = submitted.purpose === "create_administrator" ? "setup" : "reset";
          const setupLink = `${options.origin}/console/#${fragment}=${issued.id}.${secret.material}`;
          const rotated = options.sessions.commitMutation(proof);
          return reply.header(ADMIN_CSRF_HEADER, rotated.csrfToken).send({
            setupLink,
            expiresAt: issued.expiresAt,
          });
        } catch (error) {
          try { options.sessions.abortMutation(proof); } catch { /* consumed */ }
          throw error;
        } finally {
          secret?.digest.fill(0);
        }
      },
    );

    if (options.users !== undefined) {
      routes.get("/console/api/v1/users", async (request) => {
        const identity = options.sessions.authenticate(cookie(request));
        requireMenu(identity, "users.list");
        requireEmptyBody(request);
        const parsed = userSearchQuery.safeParse(request.query);
        if (!parsed.success) fail("ADMIN_INVALID_REQUEST", 400);
        return options.users!.searchPage({
          ...(parsed.data.phone === undefined ? {} : { phone: parsed.data.phone }),
          ...(parsed.data.idPrefix === undefined ? {} : { idPrefix: parsed.data.idPrefix }),
          ...(parsed.data.status === undefined ? {} : { status: parsed.data.status }),
          ...(parsed.data.page === undefined ? {} : { page: parsed.data.page }),
          ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
        });
      });

      routes.get("/console/api/v1/users/:id", async (request) => {
        const identity = options.sessions.authenticate(cookie(request));
        requireMenu(identity, "users.list");
        requireNoQuery(request);
        requireEmptyBody(request);
        return Object.freeze({ user: options.users!.detail(parseAccountId(request)) });
      });

      for (const action of ["disable", "restore"] as const) {
        routes.post(
          `/console/api/v1/users/:id/${action}`,
          { bodyLimit: BODY_LIMIT },
          async (request, reply) => {
            requireNoQuery(request);
            const proof = authorizeMutation(request, options.sessions, "users.list");
            try {
              const id = parseAccountId(request);
              const submitted = parseBody(revisionBody, request);
              const user = action === "disable"
                ? await options.users!.disable({
                    id,
                    expectedRevision: submitted.expectedRevision,
                    actor: proof.identity,
                    requestId: request.id,
                  })
                : options.users!.restore({
                    id,
                    expectedRevision: submitted.expectedRevision,
                    actor: proof.identity,
                    requestId: request.id,
                  });
              const rotated = options.sessions.commitMutation(proof);
              return reply.header(ADMIN_CSRF_HEADER, rotated.csrfToken).send({ user });
            } catch (error) {
              try { options.sessions.abortMutation(proof); } catch { /* consumed */ }
              throw error;
            }
          },
        );
      }

      routes.post(
        "/console/api/v1/users/:id/regrant-trial",
        { bodyLimit: BODY_LIMIT },
        async (request, reply) => {
          requireNoQuery(request);
          const proof = authorizeMutation(request, options.sessions, "users.list");
          try {
            if (proof.identity.kind !== "super_admin") {
              fail("ADMIN_ACCESS_DENIED", 403);
            }
            const submitted = parseBody(revisionBody, request);
            const user = options.users!.regrantTrial({
              id: parseAccountId(request),
              expectedRevision: submitted.expectedRevision,
              actor: proof.identity,
              requestId: request.id,
            });
            const rotated = options.sessions.commitMutation(proof);
            return reply.header(ADMIN_CSRF_HEADER, rotated.csrfToken).send({ user });
          } catch (error) {
            try { options.sessions.abortMutation(proof); } catch { /* consumed */ }
            throw error;
          }
        },
      );
    }

    if (options.feedback !== undefined) {
      routes.get("/console/api/v1/feedback", async (request) => {
        const identity = options.sessions.authenticate(cookie(request));
        requireMenu(identity, "feedback.list");
        requireEmptyBody(request);
        const parsed = idPrefixSearchQuery.safeParse(request.query);
        if (!parsed.success) fail("ADMIN_INVALID_REQUEST", 400);
        return Object.freeze({
          ...options.feedback!.searchPage(parsed.data),
        });
      });

      routes.get("/console/api/v1/feedback/:id", async (request) => {
        const identity = options.sessions.authenticate(cookie(request));
        requireMenu(identity, "feedback.list");
        requireNoQuery(request);
        requireEmptyBody(request);
        return Object.freeze({
          feedback: options.feedback!.detail(parseAccountId(request)),
        });
      });
    }

    if (options.orders !== undefined) {
      routes.get("/console/api/v1/orders", async (request) => {
        const identity = options.sessions.authenticate(cookie(request));
        requireMenu(identity, "orders.list");
        requireEmptyBody(request);
        const parsed = orderSearchQuery.safeParse(request.query);
        if (!parsed.success) fail("ADMIN_INVALID_REQUEST", 400);
        return Object.freeze({
          ...options.orders!.searchPage(parsed.data),
        });
      });

      routes.get("/console/api/v1/orders/:id", async (request) => {
        const identity = options.sessions.authenticate(cookie(request));
        requireMenu(identity, "orders.list");
        requireNoQuery(request);
        requireEmptyBody(request);
        return Object.freeze({
          order: options.orders!.detail(parseAccountId(request)),
        });
      });
    }

    if (options.offers !== undefined) {
      routes.get("/console/api/v1/offers", async (request) => {
        const identity = options.sessions.authenticate(cookie(request));
        requireMenu(identity, "offers.list");
        requireEmptyBody(request);
        const parsed = idPrefixSearchQuery.safeParse(request.query);
        if (!parsed.success) fail("ADMIN_INVALID_REQUEST", 400);
        return Object.freeze({
          catalog: options.offers!.catalog(),
          ...filteredPage("offers", options.offers!.list(), parsed.data),
        });
      });

      routes.get("/console/api/v1/offers/:id", async (request) => {
        const identity = options.sessions.authenticate(cookie(request));
        requireMenu(identity, "offers.list");
        requireNoQuery(request);
        requireEmptyBody(request);
        return Object.freeze({
          offer: options.offers!.detail(parseAccountId(request)),
        });
      });

      routes.post(
        "/console/api/v1/offers",
        { bodyLimit: BODY_LIMIT },
        async (request, reply) => {
          requireNoQuery(request);
          const proof = authorizeMutation(request, options.sessions, "offers.list");
          try {
            const submitted = parseBody(offerDraftBody, request);
            const offer = options.offers!.createDraft({
              ...submitted,
              actor: proof.identity,
              requestId: request.id,
            });
            const rotated = options.sessions.commitMutation(proof);
            return reply.header(ADMIN_CSRF_HEADER, rotated.csrfToken).send({ offer });
          } catch (error) {
            try { options.sessions.abortMutation(proof); } catch { /* consumed */ }
            throw error;
          }
        },
      );

      routes.put(
        "/console/api/v1/offers/:id",
        { bodyLimit: BODY_LIMIT },
        async (request, reply) => {
          requireNoQuery(request);
          const proof = authorizeMutation(request, options.sessions, "offers.list");
          try {
            const id = parseAccountId(request);
            const submitted = parseBody(offerUpdateBody, request);
            const offer = options.offers!.updateDraft({
              id,
              ...submitted,
              actor: proof.identity,
              requestId: request.id,
            });
            const rotated = options.sessions.commitMutation(proof);
            return reply.header(ADMIN_CSRF_HEADER, rotated.csrfToken).send({ offer });
          } catch (error) {
            try { options.sessions.abortMutation(proof); } catch { /* consumed */ }
            throw error;
          }
        },
      );

      routes.post(
        "/console/api/v1/offers/:id/publish",
        { bodyLimit: BODY_LIMIT },
        async (request, reply) => {
          requireNoQuery(request);
          const proof = authorizeMutation(request, options.sessions, "offers.list");
          try {
            const id = parseAccountId(request);
            const submitted = parseBody(revisionBody, request);
            const offer = options.offers!.publish({
              id,
              expectedRevision: submitted.expectedRevision,
              actor: proof.identity,
              requestId: request.id,
            });
            const rotated = options.sessions.commitMutation(proof);
            return reply.header(ADMIN_CSRF_HEADER, rotated.csrfToken).send({ offer });
          } catch (error) {
            try { options.sessions.abortMutation(proof); } catch { /* consumed */ }
            throw error;
          }
        },
      );

      routes.post(
        "/console/api/v1/offers/:id/withdraw",
        { bodyLimit: BODY_LIMIT },
        async (request, reply) => {
          requireNoQuery(request);
          const proof = authorizeMutation(request, options.sessions, "offers.list");
          try {
            const id = parseAccountId(request);
            const submitted = parseBody(revisionBody, request);
            const offer = options.offers!.withdraw({
              id,
              expectedRevision: submitted.expectedRevision,
              actor: proof.identity,
              requestId: request.id,
            });
            const rotated = options.sessions.commitMutation(proof);
            return reply.header(ADMIN_CSRF_HEADER, rotated.csrfToken).send({ offer });
          } catch (error) {
            try { options.sessions.abortMutation(proof); } catch { /* consumed */ }
            throw error;
          }
        },
      );

      for (const state of ["pause", "resume"] as const) {
        routes.post(
          `/console/api/v1/offers/sales/${state}`,
          async (request, reply) => {
            requireNoQuery(request);
            requireEmptyBody(request);
            const proof = authorizeMutation(request, options.sessions, "offers.list");
            try {
              const catalog = options.offers!.setSalesState({
                state: state === "pause" ? "paused" : "active",
                actor: proof.identity,
                requestId: request.id,
              });
              const rotated = options.sessions.commitMutation(proof);
              return reply.header(ADMIN_CSRF_HEADER, rotated.csrfToken).send({ catalog });
            } catch (error) {
              try { options.sessions.abortMutation(proof); } catch { /* consumed */ }
              throw error;
            }
          },
        );
      }
    }

    if (options.models !== undefined) {
      routes.get("/console/api/v1/model-configurations", async (request) => {
        const identity = options.sessions.authenticate(cookie(request));
        requireMenu(identity, "models.config");
        requireEmptyBody(request);
        const parsed = idPrefixSearchQuery.safeParse(request.query);
        if (!parsed.success) fail("ADMIN_INVALID_REQUEST", 400);
        return Object.freeze({
          status: options.models!.status("realtime-asr"),
          ...filteredPage("models", options.models!.list(), parsed.data),
        });
      });

      routes.post(
        "/console/api/v1/model-configurations",
        { bodyLimit: BODY_LIMIT },
        async (request, reply) => {
          requireNoQuery(request);
          const proof = authorizeMutation(request, options.sessions, "models.config");
          try {
            const input = parseBody(modelDraftBody, request);
            const model = options.models!.createDraft({
              actor: proof.identity,
              requestId: request.id,
              input,
            });
            const rotated = options.sessions.commitMutation(proof);
            return reply.header(ADMIN_CSRF_HEADER, rotated.csrfToken)
              .code(201).send({ model });
          } catch (error) {
            try { options.sessions.abortMutation(proof); } catch { /* consumed */ }
            throw error;
          }
        },
      );

      routes.post(
        "/console/api/v1/model-configurations/:id/test",
        { bodyLimit: BODY_LIMIT },
        async (request, reply) => {
          requireNoQuery(request);
          const proof = authorizeMutation(request, options.sessions, "models.config");
          try {
            const id = parseAccountId(request);
            const submitted = parseBody(revisionBody, request);
            const model = await options.models!.test({
              actor: proof.identity,
              requestId: request.id,
              id,
              expectedRevision: submitted.expectedRevision,
            });
            const rotated = options.sessions.commitMutation(proof);
            return reply.header(ADMIN_CSRF_HEADER, rotated.csrfToken).send({ model });
          } catch (error) {
            try { options.sessions.abortMutation(proof); } catch { /* consumed */ }
            throw error;
          }
        },
      );

      routes.post(
        "/console/api/v1/model-configurations/:id/activate",
        { bodyLimit: BODY_LIMIT },
        async (request, reply) => {
          requireNoQuery(request);
          const proof = authorizeMutation(request, options.sessions, "models.config");
          try {
            const id = parseAccountId(request);
            const submitted = parseBody(revisionBody, request);
            const status = options.models!.activate({
              actor: proof.identity,
              requestId: request.id,
              id,
              expectedRevision: submitted.expectedRevision,
            });
            const rotated = options.sessions.commitMutation(proof);
            return reply.header(ADMIN_CSRF_HEADER, rotated.csrfToken).send({ status });
          } catch (error) {
            try { options.sessions.abortMutation(proof); } catch { /* consumed */ }
            throw error;
          }
        },
      );

      routes.post(
        "/console/api/v1/model-configurations/rollback",
        { bodyLimit: BODY_LIMIT },
        async (request, reply) => {
          requireNoQuery(request);
          const proof = authorizeMutation(request, options.sessions, "models.config");
          try {
            const submitted = parseBody(modelRollbackBody, request);
            const status = options.models!.rollback({
              actor: proof.identity,
              requestId: request.id,
              capability: submitted.capability,
            });
            const rotated = options.sessions.commitMutation(proof);
            return reply.header(ADMIN_CSRF_HEADER, rotated.csrfToken).send({ status });
          } catch (error) {
            try { options.sessions.abortMutation(proof); } catch { /* consumed */ }
            throw error;
          }
        },
      );
    }

    if (options.sms !== undefined) {
      routes.get("/console/api/v1/sms-configurations", async (request) => {
        const identity = options.sessions.authenticate(cookie(request));
        requireMenu(identity, "sms.config");
        requireEmptyBody(request);
        const parsed = idPrefixSearchQuery.safeParse(request.query);
        if (!parsed.success) fail("ADMIN_INVALID_REQUEST", 400);
        return Object.freeze({
          status: options.sms!.status(),
          ...filteredPage("configurations", options.sms!.list(), parsed.data),
        });
      });

      routes.post("/console/api/v1/sms-configurations", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
        requireNoQuery(request);
        const proof = authorizeMutation(request, options.sessions, "sms.config");
        try {
          const input = parseBody(smsDraftBody, request);
          const configuration = options.sms!.createDraft({ actor: proof.identity, requestId: request.id, input });
          const rotated = options.sessions.commitMutation(proof);
          return reply.header(ADMIN_CSRF_HEADER, rotated.csrfToken).code(201).send({ configuration });
        } catch (error) { try { options.sessions.abortMutation(proof); } catch { /* consumed */ } throw error; }
      });

      routes.post("/console/api/v1/sms-configurations/:id/test", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
        requireNoQuery(request);
        const proof = authorizeMutation(request, options.sessions, "sms.config");
        try {
          const id = parseAccountId(request); const submitted = parseBody(smsTestBody, request);
          const configuration = await options.sms!.test({ actor: proof.identity, requestId: request.id,
            id, expectedRevision: submitted.expectedRevision, phone: submitted.phone });
          const rotated = options.sessions.commitMutation(proof);
          return reply.header(ADMIN_CSRF_HEADER, rotated.csrfToken).send({ configuration });
        } catch (error) { try { options.sessions.abortMutation(proof); } catch { /* consumed */ } throw error; }
      });

      routes.post("/console/api/v1/sms-configurations/:id/activate", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
        requireNoQuery(request);
        const proof = authorizeMutation(request, options.sessions, "sms.config");
        try {
          const id = parseAccountId(request); const submitted = parseBody(revisionBody, request);
          const status = options.sms!.activate({ actor: proof.identity, requestId: request.id,
            id, expectedRevision: submitted.expectedRevision });
          const rotated = options.sessions.commitMutation(proof);
          return reply.header(ADMIN_CSRF_HEADER, rotated.csrfToken).send({ status });
        } catch (error) { try { options.sessions.abortMutation(proof); } catch { /* consumed */ } throw error; }
      });

      routes.post("/console/api/v1/sms-configurations/rollback", async (request, reply) => {
        requireNoQuery(request); requireEmptyBody(request);
        const proof = authorizeMutation(request, options.sessions, "sms.config");
        try {
          const status = options.sms!.rollback({ actor: proof.identity, requestId: request.id });
          const rotated = options.sessions.commitMutation(proof);
          return reply.header(ADMIN_CSRF_HEADER, rotated.csrfToken).send({ status });
        } catch (error) { try { options.sessions.abortMutation(proof); } catch { /* consumed */ } throw error; }
      });
    }

  });
}
