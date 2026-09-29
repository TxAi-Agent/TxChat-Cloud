import { randomUUID } from "node:crypto";

import type {
  StreamingASRProvider,
  StreamingProviderEvent,
  StreamingProviderSession,
} from "../realtime/streamingProvider.js";
import {
  type BailianAsrSocket,
  type BailianWebSocketFactory,
  defaultBailianWebSocketFactory,
} from "./bailianAsrProvider.js";
import {
  classifyProviderRejectionCode,
  createProviderAbortContext,
  mapProviderFailure,
  ProviderError,
  type ProviderAbortContext,
} from "./providerTypes.js";

export type BailianStreamingASRModel =
  | "fun-asr-realtime"
  | "paraformer-realtime-v2";

export type BailianStreamingAsrProviderOptions = Readonly<{
  apiKey: string;
  url: string;
  model: BailianStreamingASRModel;
  timeoutMs: number;
  webSocketFactory?: BailianWebSocketFactory;
}>;

type ServerEvent = Readonly<{
  header: Readonly<{
    event: string;
    task_id: string;
    error_code?: unknown;
    attributes?: Readonly<{ request_id?: unknown }>;
  }>;
  payload?: Readonly<{
    output?: Readonly<{
      sentence?: Readonly<{
        begin_time?: unknown;
        text?: unknown;
        heartbeat?: unknown;
        sentence_end?: unknown;
      }>;
    }>;
  }>;
}>;

const ALLOWED_MODELS = new Set<BailianStreamingASRModel>([
  "fun-asr-realtime",
  "paraformer-realtime-v2",
]);
const MAX_AUDIO_FRAME_BYTES = 6_400;
const MAX_TEXT_CODE_POINTS = 20_000;
const MAX_PROVIDER_REQUEST_ID_LENGTH = 512;

function providerError(
  code:
    | "PROVIDER_CONFIGURATION_REJECTED"
    | "PROVIDER_EMPTY_OUTPUT"
    | "PROVIDER_INVALID_INPUT"
    | "PROVIDER_PROTOCOL_ERROR"
    | "PROVIDER_REQUEST_FAILED",
  status?: "task-failed",
): ProviderError {
  return new ProviderError({
    stage: "asr",
    code,
    ...(status === undefined ? {} : { status }),
  });
}

function validateOptions(options: BailianStreamingAsrProviderOptions): void {
  if (
    options.apiKey.length === 0 ||
    options.url.length === 0 ||
    !ALLOWED_MODELS.has(options.model) ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    (options.webSocketFactory !== undefined &&
      typeof options.webSocketFactory !== "function")
  ) {
    throw providerError("PROVIDER_INVALID_INPUT");
  }
}

function runTask(taskId: string, model: BailianStreamingASRModel): string {
  return JSON.stringify({
    header: {
      action: "run-task",
      task_id: taskId,
      streaming: "duplex",
    },
    payload: {
      task_group: "audio",
      task: "asr",
      function: "recognition",
      model,
      parameters: {
        format: "pcm",
        sample_rate: 16_000,
        disfluency_removal_enabled: false,
      },
      input: {},
    },
  });
}

function finishTask(taskId: string): string {
  return JSON.stringify({
    header: {
      action: "finish-task",
      task_id: taskId,
      streaming: "duplex",
    },
    payload: { input: {} },
  });
}

function parseEvent(message: string, taskId: string): ServerEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    throw providerError("PROVIDER_PROTOCOL_ERROR");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("header" in parsed) ||
    parsed.header === null ||
    typeof parsed.header !== "object"
  ) {
    throw providerError("PROVIDER_PROTOCOL_ERROR");
  }
  const event = parsed as ServerEvent;
  if (
    typeof event.header.event !== "string" ||
    event.header.task_id !== taskId
  ) {
    throw providerError("PROVIDER_PROTOCOL_ERROR");
  }
  return event;
}

function validateText(value: unknown): string {
  if (
    typeof value !== "string" ||
    [...value].length > MAX_TEXT_CODE_POINTS ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)
  ) {
    throw providerError("PROVIDER_PROTOCOL_ERROR");
  }
  return value;
}

function providerRequestId(event: ServerEvent): string | undefined {
  const value = event.header.attributes?.request_id;
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PROVIDER_REQUEST_ID_LENGTH ||
    /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    throw providerError("PROVIDER_PROTOCOL_ERROR");
  }
  return value;
}

async function waitForTaskStarted(
  socket: BailianAsrSocket,
  taskId: string,
): Promise<void> {
  const event = parseEvent(await socket.nextMessage(), taskId);
  if (event.header.event === "task-started") {
    return;
  }
  if (event.header.event === "task-failed") {
    throw providerError(
      classifyProviderRejectionCode(event.header.error_code),
      "task-failed",
    );
  }
  throw providerError("PROVIDER_PROTOCOL_ERROR");
}

class BailianStreamingSession implements StreamingProviderSession {
  readonly #finalSentences = new Map<number, string>();
  readonly #socket: BailianAsrSocket;
  readonly #taskId: string;
  readonly #parentSignal: AbortSignal;
  readonly #abortContext: ProviderAbortContext;
  readonly #operationController: AbortController;
  #finishSent = false;
  #eventsStarted = false;
  #cancelled = false;
  #terminal = false;
  #disposed = false;

  constructor(
    socket: BailianAsrSocket,
    taskId: string,
    parentSignal: AbortSignal,
    abortContext: ProviderAbortContext,
    operationController: AbortController,
  ) {
    this.#socket = socket;
    this.#taskId = taskId;
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
      await this.#socket.sendBinary(ownedFrame);
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
      await this.#socket.sendText(finishTask(this.#taskId));
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
        const event = parseEvent(
          await this.#socket.nextMessage(),
          this.#taskId,
        );
        if (event.header.event === "task-failed") {
          throw providerError(
            classifyProviderRejectionCode(event.header.error_code),
            "task-failed",
          );
        }
        if (event.header.event === "result-generated") {
          const output = this.acceptSentence(event);
          if (output !== undefined) {
            yield output;
          }
          continue;
        }
        if (event.header.event !== "task-finished" || !this.#finishSent) {
          throw providerError("PROVIDER_PROTOCOL_ERROR");
        }

        const text = [...this.#finalSentences.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, sentenceText]) => sentenceText)
          .join("")
          .trim();
        if (text.length === 0) {
          throw providerError("PROVIDER_EMPTY_OUTPUT");
        }
        if ([...text].length > MAX_TEXT_CODE_POINTS) {
          throw providerError("PROVIDER_PROTOCOL_ERROR");
        }

        const requestId = providerRequestId(event);
        this.#terminal = true;
        yield Object.freeze({
          type: "final" as const,
          text,
          ...(requestId === undefined
            ? {}
            : { providerRequestId: requestId }),
        });
      }
    } catch (error) {
      if (this.#cancelled || this.#parentSignal.aborted) {
        return;
      }
      this.#terminal = true;
      throw this.mapFailure(error);
    } finally {
      if (this.#terminal || this.#cancelled || this.#parentSignal.aborted) {
        this.dispose();
      }
    }
  }

  private acceptSentence(
    event: ServerEvent,
  ): StreamingProviderEvent | undefined {
    const sentence = event.payload?.output?.sentence;
    if (sentence === undefined) {
      throw providerError("PROVIDER_PROTOCOL_ERROR");
    }
    if (sentence.heartbeat === true) {
      return undefined;
    }
    if (
      typeof sentence.begin_time !== "number" ||
      !Number.isSafeInteger(sentence.begin_time) ||
      sentence.begin_time < 0 ||
      typeof sentence.sentence_end !== "boolean"
    ) {
      throw providerError("PROVIDER_PROTOCOL_ERROR");
    }
    const text = validateText(sentence.text);
    if (sentence.sentence_end) {
      this.#finalSentences.set(sentence.begin_time, text);
      return undefined;
    }
    const partial = text.trim();
    if (partial.length === 0) {
      return undefined;
    }
    return Object.freeze({ type: "partial" as const, text: partial });
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

export class BailianStreamingAsrProvider implements StreamingASRProvider {
  readonly #options: BailianStreamingAsrProviderOptions;
  readonly #webSocketFactory: BailianWebSocketFactory;

  constructor(options: BailianStreamingAsrProviderOptions) {
    validateOptions(options);
    this.#options = Object.freeze({ ...options });
    this.#webSocketFactory =
      options.webSocketFactory ?? defaultBailianWebSocketFactory;
  }

  async open(input: {
    requestId: string;
    signal: AbortSignal;
  }): Promise<StreamingProviderSession> {
    if (
      input.requestId.length === 0 ||
      input.requestId.length > MAX_PROVIDER_REQUEST_ID_LENGTH
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
      const taskId = randomUUID();
      await socket.sendText(runTask(taskId, this.#options.model));
      await waitForTaskStarted(socket, taskId);
      return new BailianStreamingSession(
        socket,
        taskId,
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
