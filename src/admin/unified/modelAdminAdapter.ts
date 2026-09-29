import { isInternalId } from "../../ids/internalId.js";
import {
  ModelConfigurationError,
} from "../../models/modelConfigurationRepository.js";
import {
  RuntimeModelRegistry,
  RuntimeModelRegistryError,
  type RuntimeModelCapabilityStatus,
  type RuntimeModelDraftInput,
  type RuntimeSafeModelConfiguration,
} from "../../models/runtimeModelRegistry.js";
import type {
  ModelCapability,
  SafeModelConfiguration,
} from "../../models/modelTypes.js";
import type { AdminIdentity } from "./adminAuthorization.js";
import type {
  AdminAuditAction,
  AdminAuditRepository,
  AdminAuditResult,
} from "./adminAuditRepository.js";

const REQUEST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const PROVIDER_MODELS = Object.freeze({
  "bailian-qwen-realtime": new Set([
    "qwen3-asr-flash-realtime",
    "qwen3-asr-flash-realtime-2026-02-10",
  ]),
  "bailian-streaming-asr": new Set([
    "fun-asr-realtime",
    "paraformer-realtime-v2",
  ]),
});

export type ModelAdminErrorCode =
  | "ADMIN_INVALID_REQUEST"
  | "ADMIN_MODEL_NOT_FOUND"
  | "ADMIN_MODEL_TEST_FAILED"
  | "ADMIN_MODEL_STATE_CONFLICT"
  | "ADMIN_REVISION_CONFLICT"
  | "ADMIN_SERVICE_UNAVAILABLE";

export class ModelAdminError extends Error {
  constructor(readonly code: ModelAdminErrorCode) {
    super(code);
    this.name = "ModelAdminError";
  }
}

export type ModelAdminDraftInput = Readonly<{
  supersedesId?: string | null;
  capability: "realtime-asr";
  providerKind: "bailian-qwen-realtime" | "bailian-streaming-asr";
  displayName: string;
  endpoint: string;
  modelId: string;
  credential: string;
}>;

export type ModelAdminSelectionView = RuntimeModelCapabilityStatus;

type MutationContext = Readonly<{
  actor: AdminIdentity;
  requestId: string;
}>;

function fail(code: ModelAdminErrorCode): never {
  throw new ModelAdminError(code);
}

function dataRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("ADMIN_INVALID_REQUEST");
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    return fail("ADMIN_INVALID_REQUEST");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return fail("ADMIN_INVALID_REQUEST");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      return fail("ADMIN_INVALID_REQUEST");
    }
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !allowed.has(key))
  ) fail("ADMIN_INVALID_REQUEST");
}

function validText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.isWellFormed() &&
    value.length >= 1 && value.length <= maximum &&
    value.trim() === value && !CONTROL_CHARACTERS.test(value);
}

function context(value: unknown): MutationContext {
  const row = dataRecord(value);
  const actorValue = dataRecord(row.actor);
  const requestId = row.requestId;
  if (
    !isInternalId(actorValue.accountId) ||
    !validText(actorValue.username, 64) ||
    typeof requestId !== "string" ||
    !REQUEST_PATTERN.test(requestId)
  ) fail("ADMIN_INVALID_REQUEST");
  return Object.freeze({
    actor: row.actor as AdminIdentity,
    requestId,
  });
}

function internalId(value: unknown): string {
  if (!isInternalId(value)) fail("ADMIN_INVALID_REQUEST");
  return value;
}

function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail("ADMIN_INVALID_REQUEST");
  }
  return value as number;
}

function capability(value: unknown): ModelCapability {
  if (value !== "realtime-asr") fail("ADMIN_INVALID_REQUEST");
  return value;
}

function draft(value: unknown): RuntimeModelDraftInput {
  const row = dataRecord(value);
  exactKeys(
    row,
    ["capability", "providerKind", "displayName", "endpoint", "modelId", "credential"],
    ["supersedesId"],
  );
  const selectedCapability = capability(row.capability);
  const providerKind = row.providerKind;
  const modelId = row.modelId;
  if (
    (providerKind !== "bailian-qwen-realtime" &&
      providerKind !== "bailian-streaming-asr") ||
    !validText(row.displayName, 80) ||
    !validText(row.endpoint, 2_048) ||
    !validText(modelId, 128) ||
    !validText(row.credential, 16_384) ||
    !PROVIDER_MODELS[providerKind].has(modelId)
  ) fail("ADMIN_INVALID_REQUEST");
  let endpoint: URL;
  try {
    endpoint = new URL(row.endpoint);
  } catch {
    return fail("ADMIN_INVALID_REQUEST");
  }
  if (
    endpoint.protocol !== "wss:" ||
    endpoint.username !== "" || endpoint.password !== "" ||
    endpoint.hash !== ""
  ) fail("ADMIN_INVALID_REQUEST");
  const suppliedSupersedesId = row.supersedesId;
  const supersedesId = suppliedSupersedesId === undefined ||
      suppliedSupersedesId === null
    ? suppliedSupersedesId
    : internalId(suppliedSupersedesId);
  return Object.freeze({
    ...(supersedesId === undefined ? {} : { supersedesId }),
    capability: selectedCapability,
    providerKind,
    displayName: row.displayName,
    endpoint: row.endpoint,
    modelId,
    credential: row.credential,
  });
}

function mappedError(error: unknown, action: AdminAuditAction): ModelAdminError {
  if (error instanceof ModelAdminError) return error;
  if (error instanceof ModelConfigurationError) {
    if (error.code === "NOT_FOUND") {
      return new ModelAdminError("ADMIN_MODEL_NOT_FOUND");
    }
    if (error.code === "REVISION_CONFLICT") {
      return new ModelAdminError("ADMIN_REVISION_CONFLICT");
    }
    if (
      error.code === "INVALID_STATE" ||
      error.code === "ACTIVE_MODEL" ||
      error.code === "MODEL_BUSY" ||
      error.code === "LAST_VALIDATED_MODEL" ||
      error.code === "VALIDATION_REQUIRED"
    ) return new ModelAdminError("ADMIN_MODEL_STATE_CONFLICT");
    return new ModelAdminError("ADMIN_SERVICE_UNAVAILABLE");
  }
  if (error instanceof RuntimeModelRegistryError) {
    if (error.code === "INVALID_INPUT") {
      return new ModelAdminError("ADMIN_INVALID_REQUEST");
    }
    if (error.code === "VALIDATION_FAILED" && action === "model_tested") {
      return new ModelAdminError("ADMIN_MODEL_TEST_FAILED");
    }
    if (error.code === "VALIDATION_FAILED" || error.code === "NO_ACTIVE_PROVIDER") {
      return new ModelAdminError("ADMIN_MODEL_STATE_CONFLICT");
    }
  }
  return new ModelAdminError("ADMIN_SERVICE_UNAVAILABLE");
}

function auditResult(error: ModelAdminError): AdminAuditResult {
  if (
    error.code === "ADMIN_REVISION_CONFLICT" ||
    error.code === "ADMIN_MODEL_STATE_CONFLICT"
  ) return "conflict";
  if (
    error.code === "ADMIN_MODEL_TEST_FAILED" ||
    error.code === "ADMIN_SERVICE_UNAVAILABLE"
  ) return "failed";
  return "rejected";
}

export class ModelAdminAdapter {
  readonly #registry: RuntimeModelRegistry;
  readonly #audit: AdminAuditRepository;
  readonly #now: () => Date;

  constructor(options: Readonly<{
    registry: RuntimeModelRegistry;
    audit: AdminAuditRepository;
    now?: () => Date;
  }>) {
    if (
      options === null || typeof options !== "object" ||
      !(options.registry instanceof RuntimeModelRegistry) ||
      options.audit === null || typeof options.audit !== "object" ||
      (options.now !== undefined && typeof options.now !== "function")
    ) throw new TypeError("Invalid unified model administration options");
    this.#registry = options.registry;
    this.#audit = options.audit;
    this.#now = options.now ?? (() => new Date());
  }

  list(): readonly RuntimeSafeModelConfiguration[] {
    try {
      return this.#registry.listSafe();
    } catch {
      return fail("ADMIN_SERVICE_UNAVAILABLE");
    }
  }

  status(value: unknown): ModelAdminSelectionView {
    const selected = capability(value);
    try {
      return this.#registry.capabilityStatus(selected);
    } catch (error) {
      throw mappedError(error, "model_tested");
    }
  }

  createDraft(value: unknown): SafeModelConfiguration {
    const mutation = context(value);
    return this.acceptedMutation(
      "model_drafted",
      mutation,
      undefined,
      () => {
        const row = dataRecord(value);
        exactKeys(row, ["actor", "requestId", "input"]);
        return this.#registry.createDraft(draft(row.input));
      },
    );
  }

  async test(value: unknown): Promise<SafeModelConfiguration> {
    const mutation = context(value);
    const candidate = dataRecord(value);
    const targetId = isInternalId(candidate.id) ? candidate.id : undefined;
    try {
      exactKeys(
        candidate,
        ["actor", "requestId", "id", "expectedRevision"],
        ["signal"],
      );
      const id = internalId(candidate.id);
      const expectedRevision = revision(candidate.expectedRevision);
      const signal = candidate.signal ?? new AbortController().signal;
      if (!(signal instanceof AbortSignal)) fail("ADMIN_INVALID_REQUEST");
      const tested = await this.#registry.validate(id, expectedRevision, signal);
      this.record(
        "model_tested",
        "accepted",
        mutation,
        tested.id,
        tested.revision,
      );
      return tested;
    } catch (error) {
      const mapped = mappedError(error, "model_tested");
      this.record(
        "model_tested",
        auditResult(mapped),
        mutation,
        targetId,
        Number.isSafeInteger(candidate.expectedRevision)
          ? candidate.expectedRevision as number
          : undefined,
      );
      throw mapped;
    }
  }

  activate(value: unknown): ModelAdminSelectionView {
    const mutation = context(value);
    return this.acceptedMutation(
      "model_activated",
      mutation,
      isInternalId(dataRecord(value).id) ? dataRecord(value).id as string : undefined,
      () => {
        const row = dataRecord(value);
        exactKeys(row, ["actor", "requestId", "id", "expectedRevision"]);
        const activated = this.#registry.activate(
          internalId(row.id),
          revision(row.expectedRevision),
        );
        return Object.freeze({
          result: this.#registry.capabilityStatus(activated.capability),
          revision: activated.revision,
        });
      },
    );
  }

  rollback(value: unknown): ModelAdminSelectionView {
    const mutation = context(value);
    const row = dataRecord(value);
    return this.acceptedMutation(
      "model_rolled_back",
      mutation,
      undefined,
      () => {
        exactKeys(row, ["actor", "requestId", "capability"]);
        const selectedCapability = capability(row.capability);
        const status = this.#registry.capabilityStatus(selectedCapability);
        if (status.activeModelId === null || status.fallbackModelId === null) {
          fail("ADMIN_MODEL_STATE_CONFLICT");
        }
        const fallback = this.#registry.listSafe().find(
          (candidate) => candidate.id === status.fallbackModelId,
        );
        if (fallback === undefined) fail("ADMIN_SERVICE_UNAVAILABLE");
        const activated = this.#registry.activate(fallback.id, fallback.revision);
        return Object.freeze({
          result: this.#registry.capabilityStatus(selectedCapability),
          targetId: activated.id,
          revision: activated.revision,
        });
      },
    );
  }

  private acceptedMutation<T>(
    action: AdminAuditAction,
    mutation: MutationContext,
    initialTargetId: string | undefined,
    work: () => T | Readonly<{
      result: T;
      targetId?: string;
      revision?: number;
    }>,
  ): T {
    try {
      const output = work();
      const wrapped = output !== null && typeof output === "object" &&
        Object.hasOwn(output, "result")
        ? output as Readonly<{ result: T; targetId?: string; revision?: number }>
        : undefined;
      const result = wrapped?.result ?? output as T;
      const resultRecord = result !== null && typeof result === "object"
        ? result as Record<string, unknown>
        : undefined;
      const targetId = wrapped?.targetId ?? initialTargetId ??
        (isInternalId(resultRecord?.id) ? resultRecord.id : undefined);
      const targetRevision = wrapped?.revision ??
        (Number.isSafeInteger(resultRecord?.revision)
          ? resultRecord?.revision as number
          : undefined);
      this.record(action, "accepted", mutation, targetId, targetRevision);
      return result;
    } catch (error) {
      const mapped = mappedError(error, action);
      this.record(
        action,
        auditResult(mapped),
        mutation,
        initialTargetId,
        undefined,
      );
      throw mapped;
    }
  }

  private record(
    action: AdminAuditAction,
    result: AdminAuditResult,
    mutation: MutationContext,
    targetId?: string,
    targetRevision?: number,
  ): void {
    const value = this.#now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      fail("ADMIN_SERVICE_UNAVAILABLE");
    }
    const occurredAt = new Date(
      Math.floor(value.getTime() / 1_000) * 1_000,
    ).toISOString();
    try {
      this.#audit.record({
        occurredAt,
        actorAdminId: mutation.actor.accountId,
        actorUsernameSnapshot: mutation.actor.username,
        requestRef: mutation.requestId,
        action,
        result,
        ...(targetId === undefined ? {} : { targetId }),
        ...(targetRevision === undefined ? {} : { targetRevision }),
      });
    } catch {
      fail("ADMIN_SERVICE_UNAVAILABLE");
    }
  }
}
