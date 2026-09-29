import { randomUUID } from "node:crypto";

import type {
  BailianAsrSocket,
  BailianWebSocketFactory,
} from "./bailianAsrProvider.js";
import { defaultBailianWebSocketFactory } from "./bailianAsrProvider.js";
import {
  classifyProviderRejectionCode,
  createProviderAbortContext,
  mapProviderFailure,
  ProviderError,
  type ProviderAbortContext,
} from "./providerTypes.js";
import type {
  StreamingASRProvider,
  StreamingProviderEvent,
  StreamingProviderSession,
} from "../realtime/streamingProvider.js";

export type BailianQwenRealtimeASRModel =
  | "qwen3-asr-flash-realtime"
  | "qwen3-asr-flash-realtime-2026-02-10";

export type BailianQwenRealtimeAsrProviderOptions = Readonly<{
  apiKey: string;
  url: string;
  model: BailianQwenRealtimeASRModel;
  timeoutMs: number;
  webSocketFactory?: BailianWebSocketFactory;
}>;

const MAX_AUDIO_FRAME_BYTES = 6_400;
const MAX_TEXT_CODE_POINTS = 20_000;
const MAX_PROVIDER_ID_LENGTH = 512;
const QWEN_REALTIME_MODELS: ReadonlySet<BailianQwenRealtimeASRModel> =
  new Set([
    "qwen3-asr-flash-realtime",
    "qwen3-asr-flash-realtime-2026-02-10",
  ]);

function providerError(
  code:
    | "PROVIDER_CONFIGURATION_REJECTED"
    | "PROVIDER_EMPTY_OUTPUT"
    | "PROVIDER_INVALID_INPUT"
    | "PROVIDER_PROTOCOL_ERROR"
    | "PROVIDER_REQUEST_FAILED",
): ProviderError {
  return new ProviderError({ stage: "asr", code });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PROVIDER_ID_LENGTH &&
    !/[\u0000-\u001F\u007F]/u.test(value)
  );
}

function validatedText(value: unknown, allowEmpty: boolean): string {
  if (
    typeof value !== "string" ||
    [...value].length > MAX_TEXT_CODE_POINTS ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value) ||
    (!allowEmpty && value.trim().length === 0)
  ) {
    throw providerError("PROVIDER_PROTOCOL_ERROR");
  }
  return value;
}

function parseEvent(message: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    throw providerError("PROVIDER_PROTOCOL_ERROR");
  }
  if (
    !isObject(parsed) ||
    !validIdentifier(parsed.event_id) ||
    typeof parsed.type !== "string"
  ) {
    throw providerError("PROVIDER_PROTOCOL_ERROR");
  }
  return parsed;
}

function validateSessionEvent(
  event: Record<string, unknown>,
  expectedType: "session.created" | "session.updated",
  expectedModel: BailianQwenRealtimeASRModel,
): void {
  if (
    event.type === "error" ||
    event.type === "conversation.item.input_audio_transcription.failed"
  ) {
    const upstreamCode = isObject(event.error)
      ? event.error.code
      : undefined;
    throw providerError(classifyProviderRejectionCode(upstreamCode));
  }
  if (
    event.type !== expectedType ||
    !isObject(event.session) ||
    event.session.model !== expectedModel
  ) {
    throw providerError("PROVIDER_PROTOCOL_ERROR");
  }
}

function eventId(): string {
  return `event-${randomUUID()}`;
}

function sessionUpdate(): string {
  return JSON.stringify({
    event_id: eventId(),
    type: "session.update",
    session: {
      input_audio_format: "pcm",
      sample_rate: 16_000,
      turn_detection: null,
    },
  });
}

function appendAudio(audio: Uint8Array): string {
  return JSON.stringify({
    event_id: eventId(),
    type: "input_audio_buffer.append",
    audio: Buffer.from(audio).toString("base64"),
  });
}

function simpleClientEvent(
  type: "input_audio_buffer.commit" | "session.finish",
): string {
  return JSON.stringify({ event_id: eventId(), type });
}

function qwenRealtimeURL(
  source: string,
  model: BailianQwenRealtimeASRModel,
): string {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw providerError("PROVIDER_INVALID_INPUT");
  }
  const secure = url.protocol === "wss:";
  const testLoopback =
    url.protocol === "ws:" && url.hostname === "127.0.0.1";
  const query = [...url.searchParams.entries()];
  const hasQueryDelimiter = source.includes("?");
  if (
    (!secure && !testLoopback) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    source.includes("#") ||
    url.hash.length > 0 ||
    (hasQueryDelimiter &&
      (query.length !== 1 || query[0]?.[0] !== "model")) ||
    (!hasQueryDelimiter && query.length !== 0)
  ) {
    throw providerError("PROVIDER_INVALID_INPUT");
  }
  url.search = "";
  url.searchParams.set("model", model);
  return url.toString();
}

function validateOptions(
  options: BailianQwenRealtimeAsrProviderOptions,
): void {
  if (
    options.apiKey.length === 0 ||
    !QWEN_REALTIME_MODELS.has(options.model) ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    (options.webSocketFactory !== undefined &&
      typeof options.webSocketFactory !== "function")
  ) {
    throw providerError("PROVIDER_INVALID_INPUT");
  }
  qwenRealtimeURL(options.url, options.model);
}

class BailianQwenRealtimeSession implements StreamingProviderSession {
  readonly #completedTranscripts = new Map<string, string>();
  readonly #socket: BailianAsrSocket;
  readonly #parentSignal: AbortSignal;
  readonly #abortContext: ProviderAbortContext;
  readonly #operationController: AbortController;
  #finishSent = false;
  #eventsStarted = false;
  #cancelled = false;
  #terminal = false;
  #disposed = false;
  #currentItemId: string | undefined;

  constructor(
    socket: BailianAsrSocket,
    parentSignal: AbortSignal,
    abortContext: ProviderAbortContext,
    operationController: AbortController,
  ) {
    this.#socket = socket;
    this.#parentSignal = parentSignal;
    this.#abortContext = abortContext;
    this.#operationController = operationController;
  }

  async sendAudio(frame: Uint8Array): Promise<void> {
    if (
      this.#terminal ||
      this.#cancelled ||
      this.#finishSent ||
      !(frame instanceof Uint8Array) ||
      frame.byteLength === 0 ||
      frame.byteLength > MAX_AUDIO_FRAME_BYTES ||
      frame.byteLength % 2 !== 0
    ) {
      throw providerError("PROVIDER_INVALID_INPUT");
    }
    const ownedFrame = Uint8Array.from(frame);
    try {
      await this.#socket.sendText(appendAudio(ownedFrame));
    } catch (error) {
      this.fail();
      throw this.mapFailure(error);
    } finally {
      ownedFrame.fill(0);
    }
  }

  async finish(): Promise<void> {
    if (this.#terminal || this.#cancelled || this.#finishSent) {
      throw providerError("PROVIDER_INVALID_INPUT");
    }
    this.#finishSent = true;
    try {
      await this.#socket.sendText(
        simpleClientEvent("input_audio_buffer.commit"),
      );
      await this.#socket.sendText(simpleClientEvent("session.finish"));
    } catch (error) {
      this.fail();
      throw this.mapFailure(error);
    }
  }

  cancel(): void {
    if (this.#terminal || this.#cancelled) {
      return;
    }
    this.#cancelled = true;
    this.dispose();
  }

  async *events(): AsyncIterable<StreamingProviderEvent> {
    if (this.#eventsStarted) {
      throw providerError("PROVIDER_INVALID_INPUT");
    }
    this.#eventsStarted = true;

    try {
      while (!this.#terminal && !this.#cancelled) {
        const event = parseEvent(await this.#socket.nextMessage());
        if (
          event.type === "error" ||
          event.type ===
            "conversation.item.input_audio_transcription.failed"
        ) {
          const upstreamCode = isObject(event.error)
            ? event.error.code
            : undefined;
          throw providerError(
            classifyProviderRejectionCode(upstreamCode),
          );
        }
        if (event.type === "input_audio_buffer.committed") {
          continue;
        }
        if (event.type === "conversation.item.created") {
          if (!isObject(event.item)) {
            throw providerError("PROVIDER_PROTOCOL_ERROR");
          }
          this.#currentItemId = validIdentifier(event.item.id)
            ? event.item.id
            : (event.event_id as string);
          continue;
        }
        if (
          event.type ===
          "conversation.item.input_audio_transcription.text"
        ) {
          const itemId = validIdentifier(event.item_id)
            ? event.item_id
            : this.#currentItemId;
          if (itemId === undefined) {
            throw providerError("PROVIDER_PROTOCOL_ERROR");
          }
          const text = validatedText(event.text, true);
          const stash = validatedText(event.stash, true);
          const preview = `${text}${stash}`.trim();
          if (preview.length > 0) {
            if ([...preview].length > MAX_TEXT_CODE_POINTS) {
              throw providerError("PROVIDER_PROTOCOL_ERROR");
            }
            yield Object.freeze({ type: "partial" as const, text: preview });
          }
          continue;
        }
        if (
          event.type ===
          "conversation.item.input_audio_transcription.completed"
        ) {
          const itemId = validIdentifier(event.item_id)
            ? event.item_id
            : this.#currentItemId;
          if (
            itemId === undefined ||
            this.#completedTranscripts.has(itemId)
          ) {
            throw providerError("PROVIDER_PROTOCOL_ERROR");
          }
          this.#completedTranscripts.set(
            itemId,
            validatedText(event.transcript, true),
          );
          continue;
        }
        if (event.type === "session.finished") {
          if (!this.#finishSent) {
            throw providerError("PROVIDER_PROTOCOL_ERROR");
          }
          const finalText = [...this.#completedTranscripts.values()]
            .join("")
            .trim();
          if (finalText.length === 0) {
            throw providerError("PROVIDER_EMPTY_OUTPUT");
          }
          if ([...finalText].length > MAX_TEXT_CODE_POINTS) {
            throw providerError("PROVIDER_PROTOCOL_ERROR");
          }
          this.#terminal = true;
          yield Object.freeze({ type: "final" as const, text: finalText });
          return;
        }
        throw providerError("PROVIDER_PROTOCOL_ERROR");
      }
    } catch (error) {
      if (this.#cancelled || this.#parentSignal.aborted) {
        return;
      }
      this.#terminal = true;
      throw this.mapFailure(error);
    } finally {
      if (
        this.#terminal ||
        this.#cancelled ||
        this.#parentSignal.aborted
      ) {
        this.dispose();
      }
    }
  }

  private mapFailure(error: unknown): ProviderError {
    return mapProviderFailure({
      stage: "asr",
      error,
      parentSignal: this.#parentSignal,
      abortContext: this.#abortContext,
    });
  }

  private fail(): void {
    this.#terminal = true;
    this.dispose();
  }

  private dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    try {
      this.#operationController.abort();
    } catch {
      // Continue the remaining provider cleanup steps.
    }
    try {
      this.#socket.close();
    } catch {
      // A transport cleanup failure must not replace the primary failure.
    }
    try {
      this.#abortContext.dispose();
    } catch {
      // Cleanup is best effort after the primary provider outcome is known.
    }
  }
}

export class BailianQwenRealtimeAsrProvider
  implements StreamingASRProvider
{
  readonly #options: BailianQwenRealtimeAsrProviderOptions;
  readonly #webSocketFactory: BailianWebSocketFactory;

  constructor(options: BailianQwenRealtimeAsrProviderOptions) {
    validateOptions(options);
    this.#options = Object.freeze({
      ...options,
      url: qwenRealtimeURL(options.url, options.model),
    });
    this.#webSocketFactory =
      options.webSocketFactory ?? defaultBailianWebSocketFactory;
  }

  async open(input: {
    requestId: string;
    signal: AbortSignal;
  }): Promise<StreamingProviderSession> {
    if (
      input.requestId.length === 0 ||
      input.requestId.length > MAX_PROVIDER_ID_LENGTH
    ) {
      throw providerError("PROVIDER_INVALID_INPUT");
    }
    const abortContext = createProviderAbortContext(
      "asr",
      input.signal,
      this.#options.timeoutMs,
    );
    const operationController = new AbortController();
    const operationSignal = AbortSignal.any([
      abortContext.signal,
      operationController.signal,
    ]);
    let socket: BailianAsrSocket | undefined;
    try {
      socket = await this.#webSocketFactory({
        url: this.#options.url,
        headers: { Authorization: `Bearer ${this.#options.apiKey}` },
        signal: operationSignal,
      });
      validateSessionEvent(
        parseEvent(await socket.nextMessage()),
        "session.created",
        this.#options.model,
      );
      await socket.sendText(sessionUpdate());
      validateSessionEvent(
        parseEvent(await socket.nextMessage()),
        "session.updated",
        this.#options.model,
      );
      return new BailianQwenRealtimeSession(
        socket,
        input.signal,
        abortContext,
        operationController,
      );
    } catch (error) {
      const mapped = mapProviderFailure({
        stage: "asr",
        error,
        parentSignal: input.signal,
        abortContext,
      });
      try {
        operationController.abort();
      } catch {
        // Continue the remaining provider cleanup steps.
      }
      try {
        socket?.close();
      } catch {
        // Preserve the mapped primary provider failure.
      }
      try {
        abortContext.dispose();
      } catch {
        // Preserve the mapped primary provider failure.
      }
      throw mapped;
    }
  }
}
