import type {
  SelectedASRRoute,
  StreamingRouteSelector,
} from "../realtime/asrModelRouter.js";
import type { StreamingASRProvider } from "../realtime/streamingProvider.js";
import { ProviderError } from "../providers/providerTypes.js";
import { ModelCredentialCipher } from "./modelCredentialCipher.js";
import {
  type CreateModelDraftInput,
  ModelConfigurationError,
  ModelConfigurationRepository,
  type RuntimeModelCredential,
} from "./modelConfigurationRepository.js";
import type { RealtimeProviderFactory } from "./realtimeProviderFactory.js";
import type {
  ModelCapability,
  SafeModelConfiguration,
} from "./modelTypes.js";

const MAX_IDENTITY_LENGTH = 512;
const MAX_DISPLAY_NAME_LENGTH = 80;
const MAX_ENDPOINT_LENGTH = 2_048;
const MAX_MODEL_ID_LENGTH = 128;
const MAX_CREDENTIAL_LENGTH = 16_384;
const TRANSIENT_FAILURE_WINDOW_MS = 60_000;
const PUBLIC_DESCRIPTOR = Object.freeze({ routeVersion: 1 as const });

export type RuntimeModelRegistryErrorCode =
  | "INVALID_INPUT"
  | "NO_ACTIVE_PROVIDER"
  | "REQUEST_PIN_CONFLICT"
  | "VALIDATION_FAILED";

export class RuntimeModelRegistryError extends Error {
  constructor(readonly code: RuntimeModelRegistryErrorCode) {
    super(code);
    this.name = "RuntimeModelRegistryError";
  }

  toJSON(): Readonly<{ name: string; code: RuntimeModelRegistryErrorCode }> {
    return Object.freeze({ name: this.name, code: this.code });
  }
}

export type RuntimeProviderFailure =
  | Readonly<{ kind: "invalid_configuration" }>
  | Readonly<{ kind: "connection_failure" }>
  | Readonly<{ kind: "upstream_unavailable" }>
  | Readonly<{ kind: "final_timeout" }>
  | Readonly<{ kind: "client_cancelled" }>
  | Readonly<{ kind: "client_protocol" }>
  | Readonly<{ kind: "audio_limit" }>
  | Readonly<{ kind: "authentication" }>
  | Readonly<{ kind: "insertion_failure" }>
  | Readonly<{ kind: "no_speech" }>;

export function classifyRuntimeProviderFailure(
  error: unknown,
): RuntimeProviderFailure {
  if (!(error instanceof ProviderError)) {
    return Object.freeze({ kind: "connection_failure" });
  }
  if (error.code === "PROVIDER_ABORTED") {
    return Object.freeze({ kind: "client_cancelled" });
  }
  if (
    error.code === "PROVIDER_CONFIGURATION_REJECTED" ||
    error.code === "PROVIDER_INVALID_INPUT" ||
    error.code === "PROVIDER_PROTOCOL_ERROR"
  ) {
    return Object.freeze({ kind: "invalid_configuration" });
  }
  if (error.code === "PROVIDER_EMPTY_OUTPUT") {
    return Object.freeze({ kind: "no_speech" });
  }
  return Object.freeze({ kind: "connection_failure" });
}

export type RuntimeModelDraftInput = Readonly<
  Omit<CreateModelDraftInput, "now" | "id"> & { id?: string }
>;

export type RuntimeSafeModelConfiguration = Readonly<
  SafeModelConfiguration & {
    activeTaskCount: number;
    isActive: boolean;
    isFallback: boolean;
  }
>;

export type RuntimeModelCapabilityStatus = Readonly<{
  capability: ModelCapability;
  status: "ready" | "unconfigured" | "unavailable";
  activeModelId: string | null;
  fallbackModelId: string | null;
  configurationCount: number;
  activeTaskCount: number;
}>;

export type RuntimeModelRegistryOptions = Readonly<{
  repository: ModelConfigurationRepository;
  cipher: ModelCredentialCipher;
  factory: RealtimeProviderFactory;
  now: () => Date;
}>;

type CachedProvider = Readonly<{
  configurationId: string;
  provider: StreamingASRProvider;
}>;

type PinnedProvider = Readonly<{
  accountId: string;
  configurationId: string;
  selection: SelectedASRRoute;
}>;

type TransientHealth = Readonly<{
  count: number;
  lastFailureAt: number;
}>;

type ClockSnapshot = Readonly<{
  milliseconds: number;
  timestamp: string;
}>;

function registryFailure(code: RuntimeModelRegistryErrorCode): never {
  throw new RuntimeModelRegistryError(code);
}

function validBoundedString(
  value: unknown,
  maximumLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value.isWellFormed()
  );
}

function validIdentity(value: unknown): value is string {
  return (
    validBoundedString(value, MAX_IDENTITY_LENGTH) &&
    value.trim() === value
  );
}

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isTransientFailure(kind: unknown): kind is
  | "connection_failure"
  | "upstream_unavailable"
  | "final_timeout" {
  return (
    kind === "connection_failure" ||
    kind === "upstream_unavailable" ||
    kind === "final_timeout"
  );
}

function isIgnoredFailure(kind: unknown): boolean {
  return (
    kind === "client_cancelled" ||
    kind === "client_protocol" ||
    kind === "audio_limit" ||
    kind === "authentication" ||
    kind === "insertion_failure" ||
    kind === "no_speech"
  );
}

function zeroRuntimeCredential(runtime: RuntimeModelCredential): void {
  runtime.encryptedCredential.nonce.fill(0);
  runtime.encryptedCredential.ciphertext.fill(0);
  runtime.encryptedCredential.tag.fill(0);
}

export class RuntimeModelRegistry implements StreamingRouteSelector {
  readonly #repository: ModelConfigurationRepository;
  readonly #cipher: ModelCredentialCipher;
  readonly #factory: RealtimeProviderFactory;
  readonly #now: () => Date;
  readonly #providers = new Map<string, CachedProvider>();
  readonly #pins = new Map<string, PinnedProvider>();
  readonly #leaseCounts = new Map<string, number>();
  readonly #health = new Map<string, TransientHealth>();
  readonly #transientContributions = new Map<string, string>();
  readonly #replacementAttempts = new Set<string>();
  #disposed = false;

  constructor(options: RuntimeModelRegistryOptions) {
    try {
      if (options === null || typeof options !== "object") {
        registryFailure("INVALID_INPUT");
      }
      this.#repository = options.repository;
      this.#cipher = options.cipher;
      this.#factory = options.factory;
      this.#now = options.now;
      if (
        !(this.#repository instanceof ModelConfigurationRepository) ||
        !(this.#cipher instanceof ModelCredentialCipher) ||
        this.#factory === null ||
        typeof this.#factory !== "object" ||
        typeof this.#factory.create !== "function" ||
        typeof this.#factory.validate !== "function" ||
        typeof this.#now !== "function"
      ) {
        registryFailure("INVALID_INPUT");
      }
      this.#clockSnapshot();
    } catch (error) {
      if (error instanceof RuntimeModelRegistryError) {
        throw error;
      }
      registryFailure("INVALID_INPUT");
    }

    this.#hydrate();
  }

  createDraft(input: RuntimeModelDraftInput): SafeModelConfiguration {
    let snapshot: RuntimeModelDraftInput;
    try {
      if (input === null || typeof input !== "object") {
        registryFailure("INVALID_INPUT");
      }
      snapshot = Object.freeze({
        ...(input.id === undefined ? {} : { id: input.id }),
        ...(input.supersedesId === undefined
          ? {}
          : { supersedesId: input.supersedesId }),
        capability: input.capability,
        providerKind: input.providerKind,
        displayName: input.displayName,
        endpoint: input.endpoint,
        modelId: input.modelId,
        credential: input.credential,
      });
    } catch {
      registryFailure("INVALID_INPUT");
    }
    if (
      (snapshot.id !== undefined && !validIdentity(snapshot.id)) ||
      (snapshot.supersedesId !== undefined &&
        snapshot.supersedesId !== null &&
        !validIdentity(snapshot.supersedesId)) ||
      snapshot.capability !== "realtime-asr" ||
      (snapshot.providerKind !== "bailian-qwen-realtime" &&
        snapshot.providerKind !== "bailian-streaming-asr") ||
      !validBoundedString(snapshot.displayName, MAX_DISPLAY_NAME_LENGTH) ||
      !validBoundedString(snapshot.endpoint, MAX_ENDPOINT_LENGTH) ||
      !validBoundedString(snapshot.modelId, MAX_MODEL_ID_LENGTH) ||
      !validBoundedString(snapshot.credential, MAX_CREDENTIAL_LENGTH)
    ) {
      registryFailure("INVALID_INPUT");
    }

    return this.#repository.createDraft({
      ...snapshot,
      now: this.#clockSnapshot().timestamp,
    });
  }

  async validate(
    id: string,
    expectedRevision: number,
    signal: AbortSignal,
  ): Promise<SafeModelConfiguration> {
    if (
      !validIdentity(id) ||
      !validRevision(expectedRevision) ||
      !(signal instanceof AbortSignal)
    ) {
      registryFailure("INVALID_INPUT");
    }

    let validating: SafeModelConfiguration;
    try {
      validating = this.#repository.beginValidation(
        id,
        expectedRevision,
        this.#clockSnapshot().timestamp,
      );
    } catch {
      registryFailure("VALIDATION_FAILED");
    }

    let provider: StreamingASRProvider | undefined;
    try {
      provider = this.#constructProvider(id);
      await this.#factory.validate(provider, signal);
      const completed = this.#repository.completeValidation(
        id,
        validating.revision,
        "passed",
        this.#clockSnapshot().timestamp,
      );
      this.#providers.set(
        id,
        Object.freeze({ configurationId: id, provider }),
      );
      this.#health.delete(id);
      return completed;
    } catch {
      this.#providers.delete(id);
      this.#health.delete(id);
      try {
        this.#repository.completeValidation(
          id,
          validating.revision,
          "failed",
          this.#clockSnapshot().timestamp,
        );
      } catch {
        // The safe validation result is terminal even if persistence raced.
      }
      registryFailure("VALIDATION_FAILED");
    }
  }

  activate(
    id: string,
    expectedRevision: number,
  ): SafeModelConfiguration {
    if (!validIdentity(id) || !validRevision(expectedRevision)) {
      registryFailure("INVALID_INPUT");
    }
    if (!this.#providers.has(id)) {
      registryFailure("VALIDATION_FAILED");
    }

    const previousActive = this.#repository.selection(
      "realtime-asr",
    ).activeModelId;
    const previousActiveLeaseCount =
      previousActive === null
        ? 0
        : (this.#leaseCounts.get(previousActive) ?? 0);
    const activated = this.#repository.activate(
      id,
      expectedRevision,
      this.#clockSnapshot().timestamp,
      previousActiveLeaseCount,
    );
    this.#health.delete(id);
    return activated;
  }

  select(input: Readonly<{
    accountId: string;
    requestId: string;
  }>): SelectedASRRoute {
    let accountId: string;
    let requestId: string;
    try {
      accountId = input.accountId;
      requestId = input.requestId;
    } catch {
      registryFailure("INVALID_INPUT");
    }
    if (!validIdentity(accountId) || !validIdentity(requestId)) {
      registryFailure("INVALID_INPUT");
    }

    const pinned = this.#pins.get(requestId);
    if (pinned !== undefined) {
      if (pinned.accountId !== accountId) {
        registryFailure("REQUEST_PIN_CONFLICT");
      }
      return pinned.selection;
    }

    const selection = this.#repository.selection("realtime-asr");
    const activeId = selection.activeModelId;
    if (activeId === null) {
      registryFailure("NO_ACTIVE_PROVIDER");
    }
    const configuration = this.#safeRow(activeId);
    const cached = this.#providers.get(activeId);
    if (
      configuration === undefined ||
      configuration.lifecycleState !== "active" ||
      configuration.validationStatus !== "passed" ||
      configuration.deleteWhenDrained ||
      cached === undefined
    ) {
      registryFailure("NO_ACTIVE_PROVIDER");
    }

    const route = Object.freeze({
      routeId: activeId,
      provider: cached.provider,
      publicDescriptor: PUBLIC_DESCRIPTOR,
    });
    const count = this.#leaseCounts.get(activeId) ?? 0;
    if (!Number.isSafeInteger(count) || count < 0 || count === Number.MAX_SAFE_INTEGER) {
      registryFailure("NO_ACTIVE_PROVIDER");
    }
    this.#leaseCounts.set(activeId, count + 1);
    this.#pins.set(
      requestId,
      Object.freeze({
        accountId,
        configurationId: activeId,
        selection: route,
      }),
    );
    return route;
  }

  reportReady(requestId: string): void {
    if (!validIdentity(requestId)) {
      registryFailure("INVALID_INPUT");
    }
    const pin = this.#pins.get(requestId);
    if (pin !== undefined) {
      this.#health.delete(pin.configurationId);
    }
  }

  replaceAfterOpenFailure(input: Readonly<{
    accountId: string;
    requestId: string;
    error: unknown;
  }>): SelectedASRRoute | undefined {
    let accountId: string;
    let requestId: string;
    let error: unknown;
    try {
      accountId = input.accountId;
      requestId = input.requestId;
      error = input.error;
    } catch {
      registryFailure("INVALID_INPUT");
    }
    if (!validIdentity(accountId) || !validIdentity(requestId)) {
      registryFailure("INVALID_INPUT");
    }
    const pin = this.#pins.get(requestId);
    if (pin === undefined) {
      return undefined;
    }
    if (pin.accountId !== accountId) {
      registryFailure("REQUEST_PIN_CONFLICT");
    }
    if (this.#replacementAttempts.has(requestId)) {
      return undefined;
    }
    this.#replacementAttempts.add(requestId);

    const selectionBefore = this.#repository.selection("realtime-asr");
    const fallbackBefore = selectionBefore.fallbackModelId;
    this.reportFailure(requestId, classifyRuntimeProviderFailure(error));
    const selectionAfter = this.#repository.selection("realtime-asr");
    const replacementId =
      selectionAfter.activeModelId !== null &&
      selectionAfter.activeModelId !== pin.configurationId
        ? selectionAfter.activeModelId
        : fallbackBefore;
    if (
      replacementId === null ||
      replacementId === pin.configurationId
    ) {
      return undefined;
    }
    const replacement = this.#safeRow(replacementId);
    const cached = this.#providers.get(replacementId);
    if (
      replacement === undefined ||
      replacement.validationStatus !== "passed" ||
      (replacement.lifecycleState !== "active" &&
        replacement.lifecycleState !== "standby" &&
        replacement.lifecycleState !== "draining") ||
      replacement.deleteWhenDrained ||
      cached === undefined
    ) {
      return undefined;
    }

    const oldCount = this.#leaseCounts.get(pin.configurationId) ?? 0;
    const replacementCount = this.#leaseCounts.get(replacementId) ?? 0;
    if (
      !Number.isSafeInteger(oldCount) ||
      oldCount <= 0 ||
      !Number.isSafeInteger(replacementCount) ||
      replacementCount < 0 ||
      replacementCount === Number.MAX_SAFE_INTEGER
    ) {
      return undefined;
    }
    const route = Object.freeze({
      routeId: replacementId,
      provider: cached.provider,
      publicDescriptor: PUBLIC_DESCRIPTOR,
    });
    this.#leaseCounts.set(replacementId, replacementCount + 1);
    if (oldCount === 1) {
      this.#leaseCounts.delete(pin.configurationId);
    } else {
      this.#leaseCounts.set(pin.configurationId, oldCount - 1);
    }
    this.#pins.set(
      requestId,
      Object.freeze({
        accountId,
        configurationId: replacementId,
        selection: route,
      }),
    );
    if (oldCount === 1) {
      const oldConfiguration = this.#safeRow(pin.configurationId);
      if (
        oldConfiguration?.lifecycleState === "draining" ||
        oldConfiguration?.lifecycleState === "pending_deletion"
      ) {
        try {
          const completed = this.#repository.completeDrain(
            oldConfiguration.id,
            oldConfiguration.revision,
            0,
            this.#clockSnapshot().timestamp,
          );
          if (completed === undefined) {
            this.#dropProvider(oldConfiguration.id);
          }
        } catch {
          // The in-memory lease already moved; recovery can reconcile metadata.
        }
      }
    }
    return route;
  }

  reportFailure(
    requestId: string,
    failure: RuntimeProviderFailure,
  ): void {
    if (!validIdentity(requestId)) {
      registryFailure("INVALID_INPUT");
    }
    let kind: unknown;
    try {
      kind = failure?.kind;
    } catch {
      return;
    }
    if (isIgnoredFailure(kind)) {
      return;
    }
    const pin = this.#pins.get(requestId);
    if (pin === undefined) {
      return;
    }

    if (kind === "invalid_configuration") {
      const clock = this.#clockSnapshot();
      this.#markUnhealthy(pin.configurationId, clock.timestamp);
      return;
    }
    if (!isTransientFailure(kind)) {
      return;
    }
    if (
      this.#transientContributions.get(requestId) ===
      pin.configurationId
    ) {
      return;
    }
    const clock = this.#clockSnapshot();
    this.#transientContributions.set(requestId, pin.configurationId);

    const previous = this.#health.get(pin.configurationId);
    const elapsed =
      previous === undefined
        ? undefined
        : clock.milliseconds - previous.lastFailureAt;
    const count =
      previous !== undefined &&
      elapsed !== undefined &&
      elapsed >= 0 &&
      elapsed <= TRANSIENT_FAILURE_WINDOW_MS
        ? previous.count + 1
        : 1;
    if (count < 2) {
      this.#health.set(
        pin.configurationId,
        Object.freeze({ count, lastFailureAt: clock.milliseconds }),
      );
      return;
    }
    this.#health.delete(pin.configurationId);
    this.#markUnhealthy(pin.configurationId, clock.timestamp);
  }

  release(requestId: string): boolean {
    if (!validIdentity(requestId)) {
      registryFailure("INVALID_INPUT");
    }
    const pin = this.#pins.get(requestId);
    if (pin === undefined) {
      return false;
    }

    this.#pins.delete(requestId);
    this.#transientContributions.delete(requestId);
    this.#replacementAttempts.delete(requestId);
    const count = this.#leaseCounts.get(pin.configurationId) ?? 0;
    if (count <= 1) {
      this.#leaseCounts.delete(pin.configurationId);
    } else {
      this.#leaseCounts.set(pin.configurationId, count - 1);
    }

    if (count <= 1) {
      const current = this.#safeRow(pin.configurationId);
      if (
        current?.lifecycleState === "draining" ||
        current?.lifecycleState === "pending_deletion"
      ) {
        try {
          const completed = this.#repository.completeDrain(
            current.id,
            current.revision,
            0,
            this.#clockSnapshot().timestamp,
          );
          if (completed === undefined) {
            this.#dropProvider(current.id);
          }
        } catch (error) {
          if (
            !(error instanceof ModelConfigurationError) ||
            error.code !== "LAST_VALIDATED_MODEL"
          ) {
            throw error;
          }
        }
      }
    }
    return true;
  }

  requestDeletion(
    id: string,
    expectedRevision: number,
    whenDrained: boolean,
  ): RuntimeSafeModelConfiguration | undefined {
    if (
      !validIdentity(id) ||
      !validRevision(expectedRevision) ||
      typeof whenDrained !== "boolean"
    ) {
      registryFailure("INVALID_INPUT");
    }
    const result = this.#repository.requestDeletion(
      id,
      expectedRevision,
      this.#leaseCounts.get(id) ?? 0,
      this.#clockSnapshot().timestamp,
      whenDrained,
    );
    if (result === undefined) {
      this.#dropProvider(id);
      return undefined;
    }
    return this.#decorate(result);
  }

  listSafe(): readonly RuntimeSafeModelConfiguration[] {
    const rows = this.#repository.listSafe();
    return Object.freeze(rows.map((configuration) => this.#decorate(configuration)));
  }

  capabilityStatus(
    capability: ModelCapability,
  ): RuntimeModelCapabilityStatus {
    if (capability !== "realtime-asr") {
      registryFailure("INVALID_INPUT");
    }
    const rows = this.#repository.listSafe();
    const selection = this.#repository.selection(capability);
    const active =
      selection.activeModelId === null
        ? undefined
        : rows.find((candidate) => candidate.id === selection.activeModelId);
    const ready =
      active !== undefined &&
      active.lifecycleState === "active" &&
      active.validationStatus === "passed" &&
      !active.deleteWhenDrained &&
      this.#providers.has(active.id);
    const activeTaskCount = [...this.#leaseCounts.values()].reduce(
      (total, count) => total + count,
      0,
    );
    return Object.freeze({
      capability,
      status: ready ? "ready" : rows.length === 0 ? "unconfigured" : "unavailable",
      activeModelId: selection.activeModelId,
      fallbackModelId: selection.fallbackModelId,
      configurationCount: rows.length,
      activeTaskCount,
    });
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#providers.clear();
    this.#pins.clear();
    this.#leaseCounts.clear();
    this.#health.clear();
    this.#transientContributions.clear();
    this.#replacementAttempts.clear();
  }

  #clockSnapshot(): ClockSnapshot {
    try {
      const date = this.#now();
      if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
        registryFailure("INVALID_INPUT");
      }
      return Object.freeze({
        milliseconds: date.getTime(),
        timestamp: date.toISOString(),
      });
    } catch (error) {
      if (error instanceof RuntimeModelRegistryError) {
        throw error;
      }
      registryFailure("INVALID_INPUT");
    }
  }

  #decorate(
    configuration: SafeModelConfiguration,
  ): RuntimeSafeModelConfiguration {
    const selection = this.#repository.selection(configuration.capability);
    return Object.freeze({
      ...configuration,
      activeTaskCount: this.#leaseCounts.get(configuration.id) ?? 0,
      isActive: selection.activeModelId === configuration.id,
      isFallback: selection.fallbackModelId === configuration.id,
    });
  }

  #safeRow(id: string): SafeModelConfiguration | undefined {
    return this.#repository
      .listSafe()
      .find((configuration) => configuration.id === id);
  }

  #constructProvider(id: string): StreamingASRProvider {
    const runtime = this.#repository.readRuntimeCredential(id);
    let credential: string | undefined;
    try {
      credential = this.#cipher.decrypt({
        configurationId: runtime.id,
        capability: runtime.capability,
        providerKind: runtime.providerKind,
        revision: runtime.credentialAADRevision,
        encrypted: runtime.encryptedCredential,
      });
      return this.#factory.create({
        providerKind: runtime.providerKind,
        endpoint: runtime.endpoint,
        modelId: runtime.modelId,
        credential,
      });
    } finally {
      credential = undefined;
      zeroRuntimeCredential(runtime);
    }
  }

  #cacheHydratedProvider(id: string): void {
    const provider = this.#constructProvider(id);
    this.#providers.set(
      id,
      Object.freeze({ configurationId: id, provider }),
    );
  }

  #dropProvider(id: string): void {
    this.#providers.delete(id);
    this.#health.delete(id);
  }

  #markUnhealthy(id: string, timestamp: string): void {
    let current = this.#safeRow(id);
    if (
      current === undefined ||
      current.validationStatus !== "passed" ||
      (current.lifecycleState !== "active" &&
        current.lifecycleState !== "standby" &&
        current.lifecycleState !== "draining")
    ) {
      return;
    }

    if (current.lifecycleState === "active") {
      const selection = this.#repository.selection(current.capability);
      const fallbackId = selection.fallbackModelId;
      if (fallbackId !== null) {
        const fallback = this.#safeRow(fallbackId);
        const fallbackEligible =
          fallback !== undefined &&
          fallback.validationStatus === "passed" &&
          (fallback.lifecycleState === "standby" ||
            fallback.lifecycleState === "draining") &&
          !fallback.deleteWhenDrained;
        if (fallbackEligible && !this.#providers.has(fallbackId)) {
          try {
            this.#cacheHydratedProvider(fallbackId);
          } catch {
            try {
              this.#repository.markUnhealthy(
                fallbackId,
                fallback.revision,
                timestamp,
              );
            } catch {
              // The active transition below will still fail closed.
            }
            this.#dropProvider(fallbackId);
          }
        }
      }
      current = this.#safeRow(id);
      if (current === undefined) {
        return;
      }
    }

    try {
      this.#repository.markUnhealthy(id, current.revision, timestamp);
    } finally {
      this.#dropProvider(id);
    }
  }

  #hydrate(): void {
    let rows = this.#repository.listSafe();

    for (const configuration of rows) {
      if (
        configuration.lifecycleState === "validating" &&
        configuration.validationStatus === "testing"
      ) {
        try {
          this.#repository.completeValidation(
            configuration.id,
            configuration.revision,
            "failed",
            this.#clockSnapshot().timestamp,
          );
        } catch {
          // One interrupted row must not prevent process recovery.
        }
        this.#dropProvider(configuration.id);
      }
    }

    rows = this.#repository.listSafe();
    const selection = this.#repository.selection("realtime-asr");
    const fallbackFirst = [...rows]
      .filter(
        (configuration) =>
          configuration.id !== selection.activeModelId &&
          configuration.validationStatus === "passed" &&
          (configuration.lifecycleState === "standby" ||
            configuration.lifecycleState === "draining"),
      )
      .sort((left, right) => {
        const leftFallback = left.id === selection.fallbackModelId ? 0 : 1;
        const rightFallback = right.id === selection.fallbackModelId ? 0 : 1;
        return leftFallback - rightFallback;
      });

    for (const configuration of fallbackFirst) {
      try {
        this.#cacheHydratedProvider(configuration.id);
      } catch {
        try {
          this.#repository.markUnhealthy(
            configuration.id,
            configuration.revision,
            this.#clockSnapshot().timestamp,
          );
        } catch {
          // A corrupt non-active row is isolated from registry startup.
        }
        this.#dropProvider(configuration.id);
      }
    }

    rows = this.#repository.listSafe();
    for (const configuration of rows) {
      if (
        configuration.lifecycleState === "draining" &&
        configuration.validationStatus === "passed"
      ) {
        try {
          const completed = this.#repository.completeDrain(
            configuration.id,
            configuration.revision,
            0,
            this.#clockSnapshot().timestamp,
          );
          if (completed === undefined) {
            this.#dropProvider(configuration.id);
          }
        } catch {
          // Recovery remains available even when one row cannot transition.
        }
      }
    }

    rows = this.#repository.listSafe();
    for (const configuration of rows) {
      if (
        configuration.lifecycleState === "active" &&
        configuration.validationStatus === "passed"
      ) {
        try {
          this.#cacheHydratedProvider(configuration.id);
        } catch {
          try {
            this.#markUnhealthy(
              configuration.id,
              this.#clockSnapshot().timestamp,
            );
          } catch {
            this.#dropProvider(configuration.id);
          }
        }
      }
    }

    rows = this.#repository.listSafe();
    for (const configuration of rows) {
      if (
        configuration.lifecycleState === "pending_deletion" &&
        configuration.validationStatus === "passed"
      ) {
        try {
          const completed = this.#repository.completeDrain(
            configuration.id,
            configuration.revision,
            0,
            this.#clockSnapshot().timestamp,
          );
          if (completed === undefined) {
            this.#dropProvider(configuration.id);
          }
        } catch {
          this.#dropProvider(configuration.id);
        }
      }
    }
  }
}
