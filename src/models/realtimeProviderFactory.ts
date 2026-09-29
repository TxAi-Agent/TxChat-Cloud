import { randomUUID } from "node:crypto";

import type { BailianWebSocketFactory } from "../providers/bailianAsrProvider.js";
import {
  BailianQwenRealtimeAsrProvider,
  type BailianQwenRealtimeASRModel,
} from "../providers/bailianQwenRealtimeAsrProvider.js";
import {
  BailianStreamingAsrProvider,
  type BailianStreamingASRModel,
} from "../providers/bailianStreamingAsrProvider.js";
import type {
  StreamingASRProvider,
  StreamingProviderSession,
} from "../realtime/streamingProvider.js";
import type { RuntimeProviderKind } from "./modelTypes.js";

const MAX_ENDPOINT_LENGTH = 2_048;
const MAX_MODEL_ID_LENGTH = 128;
const MAX_CREDENTIAL_LENGTH = 16_384;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 360_000;
const DEFAULT_VALIDATION_TIMEOUT_MS = 15_000;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;
export const SUPPORTED_REALTIME_PROVIDER_MODELS = Object.freeze({
  "bailian-qwen-realtime": Object.freeze([
    "qwen3-asr-flash-realtime",
    "qwen3-asr-flash-realtime-2026-02-10",
  ] as const),
  "bailian-streaming-asr": Object.freeze([
    "fun-asr-realtime",
    "paraformer-realtime-v2",
  ] as const),
});

export type RealtimeProviderFactoryErrorCode =
  | "INVALID_CONFIGURATION"
  | "VALIDATION_FAILED";

export class RealtimeProviderFactoryError extends Error {
  readonly code: RealtimeProviderFactoryErrorCode;

  constructor(code: RealtimeProviderFactoryErrorCode) {
    super(`Realtime provider factory failed (${code})`);
    this.name = "RealtimeProviderFactoryError";
    this.code = code;
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return Object.freeze({ name: this.name, code: this.code });
  }
}

export type RealtimeProviderEndpointPolicy = Readonly<{
  allowTestLoopback: boolean;
}>;

export const PRODUCTION_REALTIME_ENDPOINT_POLICY = Object.freeze({
  allowTestLoopback: false,
});

export const TEST_ONLY_LOOPBACK_REALTIME_ENDPOINT_POLICY = Object.freeze({
  allowTestLoopback: true,
});

export interface RealtimeProviderFactory {
  create(input: {
    providerKind: RuntimeProviderKind;
    endpoint: string;
    modelId: string;
    credential: string;
  }): StreamingASRProvider;

  validate(
    provider: StreamingASRProvider,
    signal: AbortSignal,
  ): Promise<void>;
}

export type ProductionRealtimeProviderFactoryOptions = Readonly<{
  providerTimeoutMs?: number;
  validationTimeoutMs?: number;
  endpointPolicy?: RealtimeProviderEndpointPolicy;
  webSocketFactory?: BailianWebSocketFactory;
}>;

function invalidConfiguration(): never {
  throw new RealtimeProviderFactoryError("INVALID_CONFIGURATION");
}

function validationFailed(): RealtimeProviderFactoryError {
  return new RealtimeProviderFactoryError("VALIDATION_FAILED");
}

function validBoundedString(
  value: unknown,
  maximumLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value.isWellFormed() &&
    !CONTROL_CHARACTERS.test(value)
  );
}

function validateTimeout(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_TIMEOUT_MS
  ) {
    invalidConfiguration();
  }
  return value;
}

function parsedEndpoint(input: {
  source: string;
  allowTestLoopback: boolean;
}): URL {
  if (!validBoundedString(input.source, MAX_ENDPOINT_LENGTH)) {
    invalidConfiguration();
  }

  const rawMatch =
    /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([\s\S]*)$/u.exec(
      input.source,
    );
  if (rawMatch === null) {
    invalidConfiguration();
  }

  let url: URL;
  try {
    url = new URL(input.source);
  } catch {
    invalidConfiguration();
  }

  const rawScheme = rawMatch[1];
  const rawAuthority = rawMatch[2];
  if (
    rawAuthority === undefined ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    input.source.includes("#") ||
    url.hash.length > 0
  ) {
    invalidConfiguration();
  }

  if (rawScheme === "wss" && url.protocol === "wss:") {
    if (url.hostname.length === 0 || rawAuthority.includes("@")) {
      invalidConfiguration();
    }
    return url;
  }

  if (
    input.allowTestLoopback &&
    rawScheme === "ws" &&
    url.protocol === "ws:"
  ) {
    const loopbackAuthority = /^127\.0\.0\.1:([0-9]+)$/u.exec(
      rawAuthority,
    );
    const port = Number(loopbackAuthority?.[1]);
    if (
      loopbackAuthority === null ||
      url.hostname !== "127.0.0.1" ||
      !Number.isSafeInteger(port) ||
      port <= 0 ||
      port > 65_535
    ) {
      invalidConfiguration();
    }
    return url;
  }

  invalidConfiguration();
}

function normalizedEndpoint(input: {
  providerKind: RuntimeProviderKind;
  endpoint: string;
  modelId: string;
  endpointPolicy: RealtimeProviderEndpointPolicy;
}): string {
  const url = parsedEndpoint({
    source: input.endpoint,
    allowTestLoopback: input.endpointPolicy.allowTestLoopback,
  });
  const hasQueryDelimiter = input.endpoint.includes("?");

  if (input.providerKind === "bailian-qwen-realtime") {
    const query = [...url.searchParams.entries()];
    if (
      (hasQueryDelimiter &&
        (query.length !== 1 || query[0]?.[0] !== "model")) ||
      (!hasQueryDelimiter && query.length !== 0)
    ) {
      invalidConfiguration();
    }
    url.search = "";
    url.searchParams.set("model", input.modelId);
    return url.toString();
  }

  if (
    hasQueryDelimiter ||
    url.search.length > 0
  ) {
    invalidConfiguration();
  }
  return url.toString();
}

function isQwenModel(modelId: string): modelId is BailianQwenRealtimeASRModel {
  return (
    modelId === "qwen3-asr-flash-realtime" ||
    modelId === "qwen3-asr-flash-realtime-2026-02-10"
  );
}

function isStreamingModel(
  modelId: string,
): modelId is BailianStreamingASRModel {
  return (
    modelId === "fun-asr-realtime" ||
    modelId === "paraformer-realtime-v2"
  );
}

type ValidatedStreamingProviderSession = Readonly<{
  session: StreamingProviderSession;
  cancel: StreamingProviderSession["cancel"];
}>;

type StreamingProviderSessionInspection = Readonly<{
  valid: boolean;
  cleanup?: ValidatedStreamingProviderSession;
}>;

function validSession(
  value: unknown,
): StreamingProviderSessionInspection {
  if (value === null || typeof value !== "object") {
    return Object.freeze({ valid: false });
  }

  const session = value as StreamingProviderSession;
  let cleanup: ValidatedStreamingProviderSession | undefined;
  try {
    const cancel = session.cancel;
    if (typeof cancel === "function") {
      cleanup = Object.freeze({ session, cancel });
    }
  } catch {
    // A malformed session may not expose a usable cleanup function.
  }

  try {
    const sendAudio = session.sendAudio;
    const finish = session.finish;
    const events = session.events;
    if (
      typeof sendAudio !== "function" ||
      typeof finish !== "function" ||
      typeof events !== "function" ||
      cleanup === undefined
    ) {
      return Object.freeze({
        valid: false,
        ...(cleanup === undefined ? {} : { cleanup }),
      });
    }
    return Object.freeze({ valid: true, cleanup });
  } catch {
    return Object.freeze({
      valid: false,
      ...(cleanup === undefined ? {} : { cleanup }),
    });
  }
}

export class ProductionRealtimeProviderFactory
  implements RealtimeProviderFactory
{
  readonly #providerTimeoutMs: number;
  readonly #validationTimeoutMs: number;
  readonly #endpointPolicy: RealtimeProviderEndpointPolicy;
  readonly #webSocketFactory: BailianWebSocketFactory | undefined;

  constructor(options: ProductionRealtimeProviderFactoryOptions = {}) {
    try {
      if (options === null || typeof options !== "object") {
        invalidConfiguration();
      }
      const optionsSnapshot = Object.freeze({
        providerTimeoutMs: options.providerTimeoutMs,
        validationTimeoutMs: options.validationTimeoutMs,
        endpointPolicy: options.endpointPolicy,
        webSocketFactory: options.webSocketFactory,
      });
      this.#providerTimeoutMs = validateTimeout(
        optionsSnapshot.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
      );
      this.#validationTimeoutMs = validateTimeout(
        optionsSnapshot.validationTimeoutMs ?? DEFAULT_VALIDATION_TIMEOUT_MS,
      );
      const endpointPolicy =
        optionsSnapshot.endpointPolicy ?? PRODUCTION_REALTIME_ENDPOINT_POLICY;
      if (
        endpointPolicy === null ||
        typeof endpointPolicy !== "object"
      ) {
        invalidConfiguration();
      }
      const allowTestLoopback = endpointPolicy.allowTestLoopback;
      if (
        typeof allowTestLoopback !== "boolean" ||
        (optionsSnapshot.webSocketFactory !== undefined &&
          typeof optionsSnapshot.webSocketFactory !== "function")
      ) {
        invalidConfiguration();
      }
      this.#endpointPolicy = Object.freeze({
        allowTestLoopback,
      });
      this.#webSocketFactory = optionsSnapshot.webSocketFactory;
    } catch {
      invalidConfiguration();
    }
  }

  create(input: {
    providerKind: RuntimeProviderKind;
    endpoint: string;
    modelId: string;
    credential: string;
  }): StreamingASRProvider {
    try {
      if (input === null || typeof input !== "object") {
        invalidConfiguration();
      }
      const inputSnapshot = Object.freeze({
        providerKind: input.providerKind,
        endpoint: input.endpoint,
        modelId: input.modelId,
        credential: input.credential,
      });
      if (
        (inputSnapshot.providerKind !== "bailian-qwen-realtime" &&
          inputSnapshot.providerKind !== "bailian-streaming-asr") ||
        !validBoundedString(inputSnapshot.modelId, MAX_MODEL_ID_LENGTH) ||
        !validBoundedString(
          inputSnapshot.credential,
          MAX_CREDENTIAL_LENGTH,
        ) ||
        inputSnapshot.credential.trim() !== inputSnapshot.credential
      ) {
        invalidConfiguration();
      }

      const url = normalizedEndpoint({
        providerKind: inputSnapshot.providerKind,
        endpoint: inputSnapshot.endpoint,
        modelId: inputSnapshot.modelId,
        endpointPolicy: this.#endpointPolicy,
      });
      const sharedOptions = {
        apiKey: inputSnapshot.credential,
        url,
        timeoutMs: this.#providerTimeoutMs,
        ...(this.#webSocketFactory === undefined
          ? {}
          : { webSocketFactory: this.#webSocketFactory }),
      };

      if (inputSnapshot.providerKind === "bailian-qwen-realtime") {
        if (!isQwenModel(inputSnapshot.modelId)) {
          invalidConfiguration();
        }
        return new BailianQwenRealtimeAsrProvider(
          Object.freeze({ ...sharedOptions, model: inputSnapshot.modelId }),
        );
      }

      if (!isStreamingModel(inputSnapshot.modelId)) {
        invalidConfiguration();
      }
      return new BailianStreamingAsrProvider(
        Object.freeze({
          ...sharedOptions,
          model: inputSnapshot.modelId,
        }),
      );
    } catch {
      invalidConfiguration();
    }
  }

  async validate(
    provider: StreamingASRProvider,
    signal: AbortSignal,
  ): Promise<void> {
    let openProvider: StreamingASRProvider["open"];
    let callerAborted: boolean;
    let callerAddEventListener: AbortSignal["addEventListener"];
    let callerRemoveEventListener: AbortSignal["removeEventListener"];
    try {
      if (
        provider === null ||
        typeof provider !== "object" ||
        !(signal instanceof AbortSignal)
      ) {
        throw validationFailed();
      }
      openProvider = provider.open;
      if (typeof openProvider !== "function") {
        throw validationFailed();
      }
      callerAborted = signal.aborted;
      callerAddEventListener = signal.addEventListener;
      callerRemoveEventListener = signal.removeEventListener;
      if (
        typeof callerAborted !== "boolean" ||
        typeof callerAddEventListener !== "function" ||
        typeof callerRemoveEventListener !== "function"
      ) {
        throw validationFailed();
      }
    } catch {
      throw validationFailed();
    }

    const validationController = new AbortController();
    const validationSignal = validationController.signal;
    const internalAddEventListener = validationSignal.addEventListener;
    const internalRemoveEventListener = validationSignal.removeEventListener;
    let callerListenerRegistered = false;
    let internalListenerRegistered = false;
    let timeout: NodeJS.Timeout | undefined;
    const abortValidation = () => {
      try {
        validationController.abort();
      } catch {
        // Abort cleanup must not expose provider-controlled failures.
      }
    };
    const forwardAbort = () => {
      abortValidation();
    };

    let rejectOnAbort: ((error: Error) => void) | undefined;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      rejectOnAbort = reject;
    });
    const rejectValidation = () => {
      rejectOnAbort?.(validationFailed());
    };
    void abortPromise.catch(() => undefined);

    let validationFinished = false;
    let session: ValidatedStreamingProviderSession | undefined;
    let cancelledSession: StreamingProviderSession | undefined;
    const cancelOnce = (
      candidate: ValidatedStreamingProviderSession | undefined,
    ) => {
      if (
        candidate === undefined ||
        cancelledSession === candidate.session
      ) {
        return;
      }
      cancelledSession = candidate.session;
      try {
        const result: unknown = Reflect.apply(
          candidate.cancel,
          candidate.session,
          [],
        );
        void Promise.resolve(result).catch(() => undefined);
      } catch {
        // Validation cleanup is deliberately content-free and best effort.
      }
    };

    try {
      if (callerAborted) {
        abortValidation();
      } else {
        Reflect.apply(callerAddEventListener, signal, [
          "abort",
          forwardAbort,
          { once: true },
        ]);
        callerListenerRegistered = true;
      }

      if (validationSignal.aborted) {
        rejectValidation();
      } else {
        Reflect.apply(internalAddEventListener, validationSignal, [
          "abort",
          rejectValidation,
          { once: true },
        ]);
        internalListenerRegistered = true;
      }

      timeout = setTimeout(() => {
        abortValidation();
      }, this.#validationTimeoutMs);
      timeout.unref();

      let openPromise: Promise<StreamingProviderSession>;
      try {
        openPromise = Promise.resolve(
          openProvider.call(provider, {
            requestId: randomUUID(),
            signal: validationSignal,
          }),
        );
      } catch (error) {
        openPromise = Promise.reject(error);
      }
      const observedOpen = openPromise.then((candidate) => {
        const inspected = validSession(candidate);
        if (inspected.cleanup !== undefined) {
          session = inspected.cleanup;
          if (validationFinished || validationSignal.aborted) {
            cancelOnce(inspected.cleanup);
          }
        }
        if (!inspected.valid || inspected.cleanup === undefined) {
          throw validationFailed();
        }
        return inspected.cleanup;
      });
      void observedOpen.catch(() => undefined);

      session = validationSignal.aborted
        ? await abortPromise
        : await Promise.race([observedOpen, abortPromise]);
      if (validationSignal.aborted) {
        throw validationFailed();
      }
    } catch {
      throw validationFailed();
    } finally {
      validationFinished = true;
      try {
        cancelOnce(session);
      } catch {
        // Continue every remaining cleanup step independently.
      }
      if (timeout !== undefined) {
        try {
          clearTimeout(timeout);
        } catch {
          // Continue every remaining cleanup step independently.
        }
      }
      if (callerListenerRegistered) {
        try {
          Reflect.apply(callerRemoveEventListener, signal, [
            "abort",
            forwardAbort,
          ]);
        } catch {
          // Caller-controlled listener cleanup is best effort.
        }
      }
      if (internalListenerRegistered) {
        try {
          Reflect.apply(internalRemoveEventListener, validationSignal, [
            "abort",
            rejectValidation,
          ]);
        } catch {
          // Continue to abort even if a provider shadowed the method.
        }
      }
      abortValidation();
    }
  }
}
