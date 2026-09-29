import {
  encodeServerControl,
  type ClientControl,
  type RealtimeFallbackReason,
  type RealtimeFailureCode,
  type RealtimeSessionMode,
  type ServerControl,
} from "./realtimeProtocol.js";
import {
  ProviderError,
  type TextRewriteProvider,
} from "../providers/providerTypes.js";
import {
  classifyRuntimeProviderFailure,
  type RuntimeProviderFailure,
} from "../models/runtimeModelRegistry.js";
import type {
  SelectedASRRoute,
  StreamingRouteSelector,
} from "./asrModelRouter.js";
import type {
  StreamingProviderEvent,
  StreamingProviderSession,
} from "./streamingProvider.js";

type SessionState =
  | "connected"
  | "opening"
  | "streaming"
  | "finishing"
  | "organizing"
  | "terminal";

type QueuedAudio = Readonly<{
  bytes: Uint8Array;
}>;

export type StreamingDictationSessionOptions = Readonly<{
  noSpeechCapability?: boolean;
  requestId: string;
  identity: Readonly<{
    accountId: string;
    sessionId: string;
    deviceId: string;
  }>;
  router: StreamingRouteSelector;
  textRewriteProvider: TextRewriteProvider;
  emit(message: ServerControl): Promise<void>;
  finalTimeoutMs: number;
  upstreamOpenTimeoutMs: number;
  signal: AbortSignal;
  usage: Readonly<{
    settle(input: Readonly<{
      uploadedPcmBytes: number;
      outcome: "usable_text" | "user_cancelled";
    }>): void;
    abandon(): void;
  }>;
  monotonicNow?: () => number;
  observeTextOptimizationFallback?: (
    reason: RealtimeFallbackReason,
  ) => void;
}>;

const MAX_FRAME_BYTES = 6_400;
const MAX_AUDIO_BYTES = 9_600_000;
const MAX_UPSTREAM_QUEUE_BYTES = 32_000;
const MAX_UPSTREAM_QUEUE_AGE_MS = 1_000;

function cancelProviderSessionBestEffort(
  providerSession: StreamingProviderSession | undefined,
): void {
  if (providerSession === undefined) {
    return;
  }
  try {
    const cancel = providerSession.cancel as () => unknown;
    const result = Reflect.apply(cancel, providerSession, []);
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function")
    ) {
      void Promise.resolve(result).catch(() => {});
    }
  } catch {
    // Cancellation cannot replace an established session outcome.
  }
}

export class StreamingDictationSession {
  readonly #options: StreamingDictationSessionOptions;
  readonly #monotonicNow: () => number;
  readonly #queuedAudio: QueuedAudio[] = [];
  #operationChain = Promise.resolve();
  #state: SessionState = "connected";
  #pinned = false;
  #finishRequested = false;
  #providerSession: StreamingProviderSession | undefined;
  #openController: AbortController | undefined;
  #finalTimer: NodeJS.Timeout | undefined;
  #queueExpiryTimer: NodeJS.Timeout | undefined;
  #queuedBytes = 0;
  #totalBytes = 0;
  #queueStartedAt: number | undefined;
  #replacementAttempted = false;
  #mode: RealtimeSessionMode | undefined;
  #textOptimizationSystemPrompt: string | undefined;
  #rewriteController: AbortController | undefined;
  #providerFinalAccepted = false;
  #hadTranscript = false;
  #usageTerminal = false;

  constructor(options: StreamingDictationSessionOptions) {
    if (
      !Number.isSafeInteger(options.finalTimeoutMs) ||
      options.finalTimeoutMs <= 0 ||
      !Number.isSafeInteger(options.upstreamOpenTimeoutMs) ||
      options.upstreamOpenTimeoutMs <= 0 ||
      options.upstreamOpenTimeoutMs > MAX_UPSTREAM_QUEUE_AGE_MS
    ) {
      throw new TypeError("Invalid realtime session timing configuration");
    }
    this.#options = options;
    this.#monotonicNow =
      options.monotonicNow ?? (() => performance.now());
    options.signal.addEventListener("abort", this.#handleAbort, {
      once: true,
    });
    if (options.signal.aborted) {
      void this.disconnect();
    }
  }

  receiveControl(message: ClientControl): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#state === "terminal") {
        return;
      }
      if (message.type === "session.start") {
        if (this.#state !== "connected") {
          await this.#fail("PROTOCOL_ERROR");
          return;
        }
        await this.#start(message);
        return;
      }
      if (message.type === "session.finish") {
        if (
          this.#state !== "opening" &&
          this.#state !== "streaming"
        ) {
          await this.#fail("PROTOCOL_ERROR");
          return;
        }
        this.#finishRequested = true;
        this.#state = "finishing";
        if (this.#providerSession !== undefined) {
          this.#beginProviderFinish(this.#providerSession);
        }
        return;
      }
      if (this.#state === "connected") {
        await this.#fail("PROTOCOL_ERROR");
        return;
      }
      await this.#cancelFromClient();
    });
  }

  receiveAudio(frame: Uint8Array): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#state === "terminal") {
        return;
      }
      if (
        (this.#state !== "opening" && this.#state !== "streaming") ||
        !(frame instanceof Uint8Array) ||
        frame.byteLength === 0 ||
        frame.byteLength > MAX_FRAME_BYTES ||
        frame.byteLength % 2 !== 0
      ) {
        await this.#fail("PROTOCOL_ERROR");
        return;
      }
      if (this.#totalBytes + frame.byteLength > MAX_AUDIO_BYTES) {
        await this.#fail("AUDIO_LIMIT_EXCEEDED");
        return;
      }

      const ownedFrame = Uint8Array.from(frame);
      this.#totalBytes += ownedFrame.byteLength;
      if (this.#state === "opening") {
        const now = this.#monotonicNow();
        if (this.#queueStartedAt === undefined) {
          this.#queueStartedAt = now;
          this.#queueExpiryTimer = setTimeout(() => {
            void this.#enqueue(() => this.#expireQueuedAudio());
          }, MAX_UPSTREAM_QUEUE_AGE_MS);
          this.#queueExpiryTimer.unref();
        }
        if (
          this.#queuedBytes + ownedFrame.byteLength >
            MAX_UPSTREAM_QUEUE_BYTES ||
          this.#queuedAudioExpired(now)
        ) {
          ownedFrame.fill(0);
          await this.#fail("UPSTREAM_UNAVAILABLE");
          return;
        }
        this.#queuedAudio.push(Object.freeze({ bytes: ownedFrame }));
        this.#queuedBytes += ownedFrame.byteLength;
        return;
      }

      const providerSession = this.#providerSession;
      if (providerSession === undefined) {
        ownedFrame.fill(0);
        await this.#fail("UPSTREAM_UNAVAILABLE");
        return;
      }
      try {
        await providerSession.sendAudio(ownedFrame);
      } catch (error) {
        await this.#fail(
          "UPSTREAM_UNAVAILABLE",
          classifyRuntimeProviderFailure(error),
        );
      } finally {
        ownedFrame.fill(0);
      }
    });
  }

  disconnect(): Promise<void> {
    this.interrupt();
    return Promise.resolve();
  }

  interrupt(): boolean {
    return this.#claimTerminal();
  }

  #claimTerminal(): boolean {
    if (this.#state === "terminal") {
      return false;
    }
    this.#state = "terminal";
    this.#releaseResources();
    return true;
  }

  async #start(
    message: Extract<ClientControl, { type: "session.start" }>,
  ): Promise<void> {
    let provider: SelectedASRRoute["provider"];
    try {
      const selected = this.#options.router.select({
        accountId: this.#options.identity.accountId,
        requestId: this.#options.requestId,
      });
      this.#pinned = true;
      provider = selected.provider;
    } catch {
      await this.#fail("UPSTREAM_UNAVAILABLE");
      return;
    }

    this.#mode = message.mode;
    this.#textOptimizationSystemPrompt =
      message.textOptimization?.prompt.content;
    this.#state = "opening";
    await this.#options.emit({
      type: "session.started",
      requestId: this.#options.requestId,
    });
    void this.#openUpstream(provider);
  }

  async #openUpstream(
    provider: SelectedASRRoute["provider"],
  ): Promise<void> {
    const controller = new AbortController();
    this.#openController = controller;
    const signal = AbortSignal.any([
      this.#options.signal,
      controller.signal,
    ]);
    let timeout: NodeJS.Timeout | undefined;
    let timedOut = false;
    const providerOpen = Promise.resolve().then(() =>
      provider.open({
        requestId: this.#options.requestId,
        signal,
      }),
    );
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error("upstream open timed out"));
      }, this.#options.upstreamOpenTimeoutMs);
      timeout.unref();
    });

    try {
      const providerSession = await Promise.race([
        providerOpen,
        timeoutPromise,
      ]);
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      await this.#enqueue(() => this.#attachProvider(providerSession));
    } catch (error) {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      controller.abort();
      if (timedOut) {
        void providerOpen.then(
          (lateSession) => {
            cancelProviderSessionBestEffort(lateSession);
          },
          () => {},
        );
      }
      await this.#enqueue(() => this.#handleOpenFailure(error));
    }
  }

  async #handleOpenFailure(error: unknown): Promise<void> {
    if (this.#state === "terminal") {
      return;
    }
    this.#openController = undefined;
    if (!this.#replacementAttempted) {
      this.#replacementAttempted = true;
      let replacement: SelectedASRRoute | undefined;
      try {
        replacement = this.#options.router.replaceAfterOpenFailure({
          accountId: this.#options.identity.accountId,
          requestId: this.#options.requestId,
          error,
        });
      } catch {
        replacement = undefined;
      }
      if (replacement !== undefined) {
        void this.#openUpstream(replacement.provider);
        return;
      }
    }
    this.#reportFailure(classifyRuntimeProviderFailure(error));
    await this.#fail("UPSTREAM_UNAVAILABLE");
  }

  async #attachProvider(
    providerSession: StreamingProviderSession,
  ): Promise<void> {
    if (this.#state === "terminal") {
      cancelProviderSessionBestEffort(providerSession);
      return;
    }
    this.#providerSession = providerSession;
    this.#openController = undefined;
    try {
      this.#options.router.reportReady(this.#options.requestId);
    } catch {
      // Provider readiness is established even if health bookkeeping fails.
    }
    if (
      this.#queuedAudio.length > 0 &&
      this.#queuedAudioExpired(this.#monotonicNow())
    ) {
      await this.#fail("UPSTREAM_UNAVAILABLE");
      return;
    }
    void this.#pumpProviderEvents(providerSession);

    while (this.#queuedAudio.length > 0 && !this.#isTerminal()) {
      if (this.#queuedAudioExpired(this.#monotonicNow())) {
        await this.#fail("UPSTREAM_UNAVAILABLE");
        return;
      }
      const queued = this.#queuedAudio.shift()!;
      this.#queuedBytes -= queued.bytes.byteLength;
      try {
        await providerSession.sendAudio(queued.bytes);
      } catch (error) {
        await this.#fail(
          "UPSTREAM_UNAVAILABLE",
          classifyRuntimeProviderFailure(error),
        );
      } finally {
        queued.bytes.fill(0);
      }
    }
    this.#clearQueueTiming();
    if (this.#isTerminal()) {
      return;
    }
    if (this.#finishRequested) {
      this.#state = "finishing";
      this.#beginProviderFinish(providerSession);
    } else {
      this.#state = "streaming";
    }
  }

  #beginProviderFinish(providerSession: StreamingProviderSession): void {
    if (this.#finalTimer !== undefined || this.#state === "terminal") {
      return;
    }
    this.#finalTimer = setTimeout(() => {
      void this.#enqueue(() =>
        this.#fail("FINAL_TIMEOUT", { kind: "final_timeout" }),
      );
    }, this.#options.finalTimeoutMs);
    this.#finalTimer.unref();
    void providerSession.finish().catch((error: unknown) =>
      this.#enqueue(() =>
        this.#fail(
          "UPSTREAM_UNAVAILABLE",
          classifyRuntimeProviderFailure(error),
        ),
      ),
    );
  }

  async #pumpProviderEvents(
    providerSession: StreamingProviderSession,
  ): Promise<void> {
    try {
      for await (const event of providerSession.events()) {
        await this.#enqueue(() => this.#acceptProviderEvent(event));
        if (this.#state === "terminal") {
          return;
        }
      }
      await this.#enqueue(async () => {
        if (this.#state !== "terminal" && !this.#providerFinalAccepted) {
          await this.#fail("UPSTREAM_UNAVAILABLE", {
            kind: "upstream_unavailable",
          });
        }
      });
    } catch (error) {
      await this.#enqueue(async () => {
        if (this.#state !== "terminal" && !this.#providerFinalAccepted) {
          await this.#fail(
            "UPSTREAM_UNAVAILABLE",
            classifyRuntimeProviderFailure(error),
          );
        }
      });
    }
  }

  async #acceptProviderEvent(event: StreamingProviderEvent): Promise<void> {
    if (this.#state === "terminal") {
      return;
    }
    if (event.type === "partial") {
      if (this.#state === "connected") {
        await this.#fail("UPSTREAM_UNAVAILABLE", {
          kind: "invalid_configuration",
        });
        return;
      }
      if (!this.#validTranscript("transcript.partial", event.text)) {
        await this.#fail("UPSTREAM_UNAVAILABLE", {
          kind: "invalid_configuration",
        });
        return;
      }
      this.#hadTranscript = true;
      await this.#options.emit({
        type: "transcript.partial",
        text: event.text,
      });
      return;
    }

    if (
      this.#state !== "finishing" ||
      !this.#validTranscript("transcript.final", event.text)
    ) {
      await this.#fail("UPSTREAM_UNAVAILABLE", {
        kind: "invalid_configuration",
      });
      return;
    }
    if (this.#finalTimer !== undefined) {
      clearTimeout(this.#finalTimer);
      this.#finalTimer = undefined;
    }
    this.#providerFinalAccepted = true;
    if (this.#mode === "smart") {
      this.#state = "organizing";
      await this.#options.emit({ type: "transcript.organizing" });
      this.#beginSmartRewrite(event.text);
      return;
    }
    if (!this.#settleUsage("usable_text")) {
      await this.#fail("UPSTREAM_UNAVAILABLE");
      return;
    }
    if (!this.#claimTerminal()) {
      return;
    }
    try {
      await this.#options.emit({
        type: "transcript.final",
        text: event.text,
        ...(this.#mode === "verbatim"
          ? { resultMode: "verbatim" as const }
          : {}),
      });
    } finally {
      await this.#options.emit({ type: "session.ended" });
    }
  }

  #beginSmartRewrite(rawTranscript: string): void {
    const controller = new AbortController();
    this.#rewriteController = controller;
    const signal = AbortSignal.any([
      this.#options.signal,
      controller.signal,
    ]);
    void this.#options.textRewriteProvider
      .rewrite({
        rawTranscript,
        signal,
        ...(this.#textOptimizationSystemPrompt === undefined
          ? {}
          : { systemPrompt: this.#textOptimizationSystemPrompt }),
      })
      .then(
        (result) => {
          const finalText = result.finalText.trim();
          if (finalText.length === 0) {
            return {
              text: rawTranscript,
              resultMode: "verbatim_fallback" as const,
              fallbackReason:
                "text_optimization_empty_result" as const,
            };
          }
          if (!this.#validTranscript("transcript.final", finalText)) {
            return {
              text: rawTranscript,
              resultMode: "verbatim_fallback" as const,
              fallbackReason:
                "text_optimization_provider_failed" as const,
            };
          }
          return {
            text: finalText,
            resultMode: "smart" as const,
          };
        },
        (error: unknown) => ({
          text: rawTranscript,
          resultMode: "verbatim_fallback" as const,
          fallbackReason: this.#rewriteFallbackReason(error),
        }),
      )
      .catch((error: unknown) => ({
        text: rawTranscript,
        resultMode: "verbatim_fallback" as const,
        fallbackReason: this.#rewriteFallbackReason(error),
      }))
      .then((result) =>
        this.#enqueue(async () => {
          if (
            this.#state !== "organizing" ||
            this.#rewriteController !== controller ||
            signal.aborted
          ) {
            return;
          }
          this.#rewriteController = undefined;
          if (result.resultMode === "verbatim_fallback") {
            try {
              this.#options.observeTextOptimizationFallback?.(
                result.fallbackReason,
              );
            } catch {
              // Observability cannot replace the content-preserving fallback.
            }
          }
          if (!this.#settleUsage("usable_text")) {
            await this.#fail("UPSTREAM_UNAVAILABLE");
            return;
          }
          if (!this.#claimTerminal()) {
            return;
          }
          try {
            if (result.resultMode === "verbatim_fallback") {
              await this.#options.emit({
                type: "transcript.final",
                text: result.text,
                resultMode: result.resultMode,
                fallbackReason: result.fallbackReason,
              });
            } else {
              await this.#options.emit({
                type: "transcript.final",
                text: result.text,
                resultMode: result.resultMode,
              });
            }
          } finally {
            await this.#options.emit({ type: "session.ended" });
          }
        }),
      );
  }

  #rewriteFallbackReason(error: unknown): RealtimeFallbackReason {
    if (error instanceof ProviderError) {
      if (error.code === "PROVIDER_TIMEOUT") {
        return "text_optimization_timeout";
      }
      if (error.code === "PROVIDER_EMPTY_OUTPUT") {
        return "text_optimization_empty_result";
      }
    }
    return "text_optimization_provider_failed";
  }

  #validTranscript(
    type: "transcript.partial" | "transcript.final",
    text: string,
  ): boolean {
    try {
      encodeServerControl(
        type === "transcript.partial"
          ? { type: "transcript.partial", text }
          : { type: "transcript.final", text },
      );
      return true;
    } catch {
      return false;
    }
  }

  #isTerminal(): boolean {
    return this.#state === "terminal";
  }

  async #cancelFromClient(): Promise<void> {
    if (!this.#settleUsage("user_cancelled")) {
      await this.#fail("UPSTREAM_UNAVAILABLE");
      return;
    }
    if (!this.#claimTerminal()) {
      return;
    }
    await this.#options.emit({ type: "session.ended" });
  }

  async #fail(
    code: RealtimeFailureCode,
    providerFailure?: RuntimeProviderFailure,
  ): Promise<void> {
    if (this.#state === "terminal") {
      return;
    }
    // Only explicit empty ASR output after finish can be neutral. Legacy
    // clients keep the existing code; faults and partial text are not hidden.
    if (code === "UPSTREAM_UNAVAILABLE" && providerFailure?.kind === "no_speech" &&
        this.#options.noSpeechCapability === true && this.#finishRequested &&
        !this.#hadTranscript && !this.#providerFinalAccepted) {
      code = "NO_SPEECH";
    }
    if (providerFailure !== undefined) {
      this.#reportFailure(providerFailure);
    }
    if (!this.#claimTerminal()) {
      return;
    }
    try {
      await this.#options.emit({ type: "session.failed", code });
    } finally {
      await this.#options.emit({ type: "session.ended" });
    }
  }

  #reportFailure(failure: RuntimeProviderFailure): void {
    if (!this.#pinned) {
      return;
    }
    try {
      this.#options.router.reportFailure(
        this.#options.requestId,
        failure,
      );
    } catch {
      // Health bookkeeping must never expose internal provider details.
    }
  }

  #queuedAudioExpired(now: number): boolean {
    return (
      this.#queueStartedAt !== undefined &&
      now - this.#queueStartedAt >= MAX_UPSTREAM_QUEUE_AGE_MS
    );
  }

  async #expireQueuedAudio(): Promise<void> {
    this.#queueExpiryTimer = undefined;
    if (this.#state === "terminal" || this.#queuedAudio.length === 0) {
      return;
    }
    await this.#fail("UPSTREAM_UNAVAILABLE");
  }

  #clearQueueTiming(): void {
    if (this.#queueExpiryTimer !== undefined) {
      clearTimeout(this.#queueExpiryTimer);
      this.#queueExpiryTimer = undefined;
    }
    this.#queueStartedAt = undefined;
  }

  #settleUsage(outcome: "usable_text" | "user_cancelled"): boolean {
    if (this.#usageTerminal) {
      return false;
    }
    this.#usageTerminal = true;
    try {
      this.#options.usage.settle({
        uploadedPcmBytes: this.#totalBytes,
        outcome,
      });
      return true;
    } catch {
      return false;
    }
  }

  #releaseResources(): void {
    if (!this.#usageTerminal) {
      this.#usageTerminal = true;
      try {
        this.#options.usage.abandon();
      } catch {
        // Accounting release is best-effort and cannot block resource cleanup.
      }
    }
    if (this.#finalTimer !== undefined) {
      clearTimeout(this.#finalTimer);
      this.#finalTimer = undefined;
    }
    try {
      this.#openController?.abort();
    } catch {
      // Continue independent cleanup after a faulty abort listener.
    }
    this.#openController = undefined;
    try {
      this.#rewriteController?.abort();
    } catch {
      // Continue cleanup after a faulty abort listener.
    }
    this.#rewriteController = undefined;
    this.#textOptimizationSystemPrompt = undefined;
    const providerSession = this.#providerSession;
    this.#providerSession = undefined;
    cancelProviderSessionBestEffort(providerSession);
    for (const queued of this.#queuedAudio.splice(0)) {
      try {
        queued.bytes.fill(0);
      } catch {
        // Owned queue entries are discarded even if one buffer is faulty.
      }
    }
    this.#queuedBytes = 0;
    this.#clearQueueTiming();
    if (this.#pinned) {
      this.#pinned = false;
      try {
        this.#options.router.release(this.#options.requestId);
      } catch {
        // The route pin is already logically terminal; do not expose router details.
      }
    }
    try {
      this.#options.signal.removeEventListener("abort", this.#handleAbort);
    } catch {
      // Terminal state is authoritative even for a non-standard signal.
    }
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const scheduled = this.#operationChain.then(operation);
    const guarded = scheduled.catch(async () => {
      if (this.#state !== "terminal") {
        try {
          await this.#fail("UPSTREAM_UNAVAILABLE");
        } catch {
          // A closed downstream cannot receive a terminal control message.
        }
      }
    });
    this.#operationChain = guarded;
    return guarded;
  }

  readonly #handleAbort = () => {
    void this.disconnect();
  };
}
