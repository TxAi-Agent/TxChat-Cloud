export interface SpeechRecognitionProvider {
  recognize(input: {
    audioPath: string;
    pcmDataOffset: number;
    pcmDataLength: number;
    durationMs: number;
    signal: AbortSignal;
  }): Promise<{ text: string; providerRequestId?: string }>;
}

export interface TextRewriteProvider {
  rewrite(input: {
    rawTranscript: string;
    signal: AbortSignal;
    systemPrompt?: string;
  }): Promise<{
    finalText: string;
    inputTokens: number;
    outputTokens: number;
  }>;
}

export type ProviderStage = "asr" | "rewrite";

export type ProviderErrorCode =
  | "PROVIDER_ABORTED"
  | "PROVIDER_CONFIGURATION_REJECTED"
  | "PROVIDER_EMPTY_OUTPUT"
  | "PROVIDER_INVALID_INPUT"
  | "PROVIDER_PROTOCOL_ERROR"
  | "PROVIDER_REQUEST_FAILED"
  | "PROVIDER_TIMEOUT";

const CONFIGURATION_REJECTION_CODES: ReadonlySet<string> = new Set([
  "InvalidApiKey",
  "InvalidParameter",
  "AccessDenied",
  "Arrearage",
  "NotFound",
  "ModelNotFound",
  "ModelNotExist",
  "ModelNotSupported",
  "PermissionDenied",
  "Forbidden",
  "Unauthorized",
]);

export function classifyProviderRejectionCode(
  value: unknown,
): "PROVIDER_CONFIGURATION_REJECTED" | "PROVIDER_REQUEST_FAILED" {
  return typeof value === "string" &&
    CONFIGURATION_REJECTION_CODES.has(value)
    ? "PROVIDER_CONFIGURATION_REJECTED"
    : "PROVIDER_REQUEST_FAILED";
}

const SAFE_PROVIDER_PROTOCOL_STATUSES = new Set([
  "content_filter",
  "function_call",
  "length",
  "task-failed",
  "tool_calls",
]);

function safeProviderStatus(
  value: number | string | undefined,
): number | string | undefined {
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    return value;
  }
  if (
    typeof value === "string" &&
    SAFE_PROVIDER_PROTOCOL_STATUSES.has(value)
  ) {
    return value;
  }
  return undefined;
}

export class ProviderError extends Error {
  readonly stage: ProviderStage;
  readonly code: ProviderErrorCode;
  readonly status?: number | string;

  constructor(input: {
    stage: ProviderStage;
    code: ProviderErrorCode;
    status?: number | string;
  }) {
    super(`${input.stage} provider failed (${input.code})`);
    this.name = "ProviderError";
    this.stage = input.stage;
    this.code = input.code;

    const status = safeProviderStatus(input.status);
    if (status !== undefined) {
      this.status = status;
    }
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      name: this.name,
      stage: this.stage,
      code: this.code,
      ...(this.status === undefined ? {} : { status: this.status }),
    });
  }
}

export type ProviderAbortContext = Readonly<{
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
}>;

export function createProviderAbortContext(
  stage: ProviderStage,
  parentSignal: AbortSignal,
  timeoutMs: number,
): ProviderAbortContext {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ProviderError({
      stage,
      code: "PROVIDER_INVALID_INPUT",
    });
  }

  const controller = new AbortController();
  let timeoutTriggered = false;
  const forwardParentAbort = () => {
    controller.abort();
  };

  if (parentSignal.aborted) {
    controller.abort();
  } else {
    parentSignal.addEventListener("abort", forwardParentAbort, {
      once: true,
    });
  }

  const timeout = setTimeout(() => {
    timeoutTriggered = true;
    controller.abort();
  }, timeoutMs);
  timeout.unref();

  let disposed = false;
  return Object.freeze({
    signal: controller.signal,
    timedOut: () => timeoutTriggered,
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      clearTimeout(timeout);
      parentSignal.removeEventListener("abort", forwardParentAbort);
    },
  });
}

export function mapProviderFailure(input: {
  stage: ProviderStage;
  error: unknown;
  parentSignal: AbortSignal;
  abortContext: ProviderAbortContext;
}): ProviderError {
  if (input.abortContext.timedOut()) {
    return new ProviderError({
      stage: input.stage,
      code: "PROVIDER_TIMEOUT",
    });
  }
  if (input.parentSignal.aborted || input.abortContext.signal.aborted) {
    return new ProviderError({
      stage: input.stage,
      code: "PROVIDER_ABORTED",
    });
  }
  if (input.error instanceof ProviderError) {
    return input.error;
  }
  return new ProviderError({
    stage: input.stage,
    code: "PROVIDER_REQUEST_FAILED",
  });
}
