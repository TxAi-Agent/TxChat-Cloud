import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";

import WebSocket, { type RawData } from "ws";

import {
  createProviderAbortContext,
  mapProviderFailure,
  ProviderError,
  type SpeechRecognitionProvider,
} from "./providerTypes.js";

const PCM_FRAME_BYTES = 3_200;
const PCM_FRAME_INTERVAL_MS = 100;

export interface BailianAsrSocket {
  sendText(message: string): Promise<void>;
  sendBinary(data: Uint8Array): Promise<void>;
  nextMessage(): Promise<string>;
  close(): void;
}

export type BailianWebSocketFactory = (input: Readonly<{
  url: string;
  headers: Readonly<Record<string, string>>;
  signal: AbortSignal;
}>) => Promise<BailianAsrSocket>;

export type BailianAsrProviderOptions = Readonly<{
  apiKey: string;
  url: string;
  model: "paraformer-realtime-v2";
  timeoutMs: number;
  webSocketFactory?: BailianWebSocketFactory;
}>;

type MessageReceiver = Readonly<{
  resolve(message: string): void;
  reject(error: Error): void;
}>;

class NodeBailianAsrSocket implements BailianAsrSocket {
  private readonly messages: string[] = [];
  private readonly receivers: MessageReceiver[] = [];
  private failure: Error | undefined;
  private closed = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly signal: AbortSignal,
  ) {
    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        this.fail(new Error("unexpected binary provider message"));
        return;
      }
      const message = data.toString();
      const receiver = this.receivers.shift();
      if (receiver === undefined) {
        this.messages.push(message);
      } else {
        receiver.resolve(message);
      }
    });
    socket.on("error", () => {
      this.fail(new Error("provider WebSocket failed"));
    });
    socket.on("close", () => {
      if (!this.closed) {
        this.fail(new Error("provider WebSocket closed"));
      }
    });
    signal.addEventListener("abort", this.handleAbort, { once: true });
  }

  async sendText(message: string): Promise<void> {
    await this.send(message);
  }

  async sendBinary(data: Uint8Array): Promise<void> {
    await this.send(data);
  }

  async nextMessage(): Promise<string> {
    const message = this.messages.shift();
    if (message !== undefined) {
      return message;
    }
    if (this.failure !== undefined) {
      throw this.failure;
    }
    return new Promise((resolve, reject) => {
      this.receivers.push({ resolve, reject });
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.signal.removeEventListener("abort", this.handleAbort);
    if (
      this.socket.readyState === WebSocket.CONNECTING ||
      this.socket.readyState === WebSocket.OPEN
    ) {
      this.socket.close();
    }
  }

  private readonly handleAbort = () => {
    this.fail(new Error("provider request aborted"));
    this.socket.terminate();
  };

  private async send(data: string | Uint8Array): Promise<void> {
    if (this.signal.aborted || this.failure !== undefined) {
      throw new Error("provider WebSocket unavailable");
    }
    await new Promise<void>((resolve, reject) => {
      this.socket.send(data, (error?: Error | null) => {
        if (error === undefined || error === null) {
          resolve();
        } else {
          reject(new Error("provider WebSocket send failed"));
        }
      });
    });
  }

  private fail(error: Error): void {
    if (this.failure !== undefined || this.closed) {
      return;
    }
    this.failure = error;
    for (const receiver of this.receivers.splice(0)) {
      receiver.reject(error);
    }
  }
}

export const defaultBailianWebSocketFactory: BailianWebSocketFactory = async ({
  url,
  headers,
  signal,
}) => {
  if (signal.aborted) {
    throw new Error("provider request aborted");
  }
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers,
      followRedirects: false,
    });
    let settled = false;

    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("close", onClose);
      socket.off("unexpected-response", onUnexpectedResponse);
    };
    const rejectConnection = (
      error: ProviderError,
      terminateSocket = true,
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (terminateSocket) {
        try {
          socket.terminate();
        } catch {
          // Preserve the stable primary connection classification.
        }
      }
      reject(error);
    };
    const onAbort = () => {
      rejectConnection(
        new ProviderError({ stage: "asr", code: "PROVIDER_ABORTED" }),
      );
    };
    const onError = () => {
      rejectConnection(
        new ProviderError({ stage: "asr", code: "PROVIDER_REQUEST_FAILED" }),
      );
    };
    const onClose = () => {
      rejectConnection(
        new ProviderError({ stage: "asr", code: "PROVIDER_REQUEST_FAILED" }),
      );
    };
    const onUnexpectedResponse = (
      _request: unknown,
      response: Readonly<{
        statusCode?: number;
        resume(): unknown;
        destroy(): unknown;
      }>,
    ) => {
      const statusCode = response.statusCode;
      const code =
        statusCode === 401 ||
        statusCode === 402 ||
        statusCode === 403 ||
        statusCode === 404
          ? "PROVIDER_CONFIGURATION_REJECTED"
          : "PROVIDER_REQUEST_FAILED";
      try {
        response.resume();
      } catch {
        // Never inspect or retain the upstream response body.
      }
      try {
        response.destroy();
      } catch {
        // Preserve the stable response classification.
      }
      rejectConnection(
        new ProviderError({ stage: "asr", code }),
        false,
      );
    };
    const onOpen = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(new NodeBailianAsrSocket(socket, signal));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.once("unexpected-response", onUnexpectedResponse);
  });
};

function asrRunTask(
  taskId: string,
  model: "paraformer-realtime-v2",
): string {
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

function asrFinishTask(taskId: string): string {
  return JSON.stringify({
    header: {
      action: "finish-task",
      task_id: taskId,
      streaming: "duplex",
    },
    payload: { input: {} },
  });
}

type AsrServerEvent = Readonly<{
  header: Readonly<{
    event: string;
    task_id: string;
    error_code?: string;
  }>;
  payload?: Readonly<{
    output?: Readonly<{
      sentence?: Readonly<{
        begin_time?: number;
        text?: string;
        heartbeat?: boolean;
        sentence_end?: boolean;
      }>;
    }>;
  }>;
}>;

function parseServerEvent(message: string, taskId: string): AsrServerEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    throw new ProviderError({
      stage: "asr",
      code: "PROVIDER_PROTOCOL_ERROR",
    });
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("header" in parsed) ||
    parsed.header === null ||
    typeof parsed.header !== "object"
  ) {
    throw new ProviderError({
      stage: "asr",
      code: "PROVIDER_PROTOCOL_ERROR",
    });
  }
  const event = parsed as AsrServerEvent;
  if (
    typeof event.header.event !== "string" ||
    event.header.task_id !== taskId
  ) {
    throw new ProviderError({
      stage: "asr",
      code: "PROVIDER_PROTOCOL_ERROR",
    });
  }
  return event;
}

function taskFailedError(): ProviderError {
  return new ProviderError({
    stage: "asr",
    code: "PROVIDER_REQUEST_FAILED",
    status: "task-failed",
  });
}

async function waitForTaskStarted(
  socket: BailianAsrSocket,
  taskId: string,
): Promise<void> {
  while (true) {
    const event = parseServerEvent(await socket.nextMessage(), taskId);
    if (event.header.event === "task-started") {
      return;
    }
    if (event.header.event === "task-failed") {
      throw taskFailedError();
    }
    throw new ProviderError({
      stage: "asr",
      code: "PROVIDER_PROTOCOL_ERROR",
    });
  }
}

function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new Error("provider request aborted"));
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error("provider request aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function sendPcmFrames(
  socket: BailianAsrSocket,
  input: {
    audioPath: string;
    pcmDataOffset: number;
    pcmDataLength: number;
    signal: AbortSignal;
  },
): Promise<void> {
  if (
    !Number.isSafeInteger(input.pcmDataOffset) ||
    input.pcmDataOffset < 0 ||
    !Number.isSafeInteger(input.pcmDataLength) ||
    input.pcmDataLength <= 0
  ) {
    throw new ProviderError({
      stage: "asr",
      code: "PROVIDER_INVALID_INPUT",
    });
  }

  const file = await open(input.audioPath, "r");
  try {
    let position = input.pcmDataOffset;
    let remaining = input.pcmDataLength;
    while (remaining > 0) {
      if (input.signal.aborted) {
        throw new Error("provider request aborted");
      }
      const frameLength = Math.min(PCM_FRAME_BYTES, remaining);
      const frame = Buffer.allocUnsafe(frameLength);
      try {
        let filled = 0;
        while (filled < frameLength) {
          const { bytesRead } = await file.read(
            frame,
            filled,
            frameLength - filled,
            position + filled,
          );
          if (bytesRead === 0) {
            throw new ProviderError({
              stage: "asr",
              code: "PROVIDER_INVALID_INPUT",
            });
          }
          filled += bytesRead;
        }
        await socket.sendBinary(frame);
      } finally {
        frame.fill(0);
      }
      position += frameLength;
      remaining -= frameLength;
      if (remaining > 0) {
        await abortableDelay(PCM_FRAME_INTERVAL_MS, input.signal);
      }
    }
  } finally {
    await file.close();
  }
}

async function collectFinalTranscript(
  socket: BailianAsrSocket,
  taskId: string,
): Promise<{ text: string }> {
  const finalSentences = new Map<number, string>();

  while (true) {
    const event = parseServerEvent(await socket.nextMessage(), taskId);

    if (event.header.event === "task-failed") {
      throw taskFailedError();
    }
    if (event.header.event === "result-generated") {
      const sentence = event.payload?.output?.sentence;
      if (sentence === undefined) {
        throw new ProviderError({
          stage: "asr",
          code: "PROVIDER_PROTOCOL_ERROR",
        });
      }
      if (sentence.heartbeat === true) {
        continue;
      }
      if (typeof sentence.sentence_end !== "boolean") {
        throw new ProviderError({
          stage: "asr",
          code: "PROVIDER_PROTOCOL_ERROR",
        });
      }
      if (sentence.sentence_end === false) {
        continue;
      }
      if (
        typeof sentence.begin_time !== "number" ||
        !Number.isSafeInteger(sentence.begin_time) ||
        sentence.begin_time < 0 ||
        typeof sentence.text !== "string"
      ) {
        throw new ProviderError({
          stage: "asr",
          code: "PROVIDER_PROTOCOL_ERROR",
        });
      }
      finalSentences.set(sentence.begin_time, sentence.text);
      continue;
    }
    if (event.header.event !== "task-finished") {
      throw new ProviderError({
        stage: "asr",
        code: "PROVIDER_PROTOCOL_ERROR",
      });
    }

    const text = [...finalSentences.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, sentence]) => sentence)
      .join("")
      .trim();
    if (text.length === 0) {
      throw new ProviderError({
        stage: "asr",
        code: "PROVIDER_EMPTY_OUTPUT",
      });
    }
    return { text };
  }
}

export class BailianAsrProvider implements SpeechRecognitionProvider {
  private readonly webSocketFactory: BailianWebSocketFactory;

  constructor(private readonly options: BailianAsrProviderOptions) {
    this.webSocketFactory =
      options.webSocketFactory ?? defaultBailianWebSocketFactory;
  }

  async recognize(input: {
    audioPath: string;
    pcmDataOffset: number;
    pcmDataLength: number;
    durationMs: number;
    signal: AbortSignal;
  }): Promise<{ text: string; providerRequestId?: string }> {
    if (
      !Number.isFinite(input.durationMs) ||
      input.durationMs <= 0
    ) {
      throw new ProviderError({
        stage: "asr",
        code: "PROVIDER_INVALID_INPUT",
      });
    }

    const abortContext = createProviderAbortContext(
      "asr",
      input.signal,
      this.options.timeoutMs,
    );
    const operationController = new AbortController();
    const operationSignal = AbortSignal.any([
      abortContext.signal,
      operationController.signal,
    ]);
    let socket: BailianAsrSocket | undefined;
    let completed = false;
    try {
      if (operationSignal.aborted) {
        throw new Error("provider request aborted");
      }
      socket = await this.webSocketFactory({
        url: this.options.url,
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
        },
        signal: operationSignal,
      });
      const taskId = randomUUID();
      await socket.sendText(asrRunTask(taskId, this.options.model));
      await waitForTaskStarted(socket, taskId);
      const transcriptPromise = collectFinalTranscript(socket, taskId).catch(
        (error: unknown) => {
          operationController.abort();
          throw error;
        },
      );
      const streamingPromise = (async () => {
        await sendPcmFrames(socket, {
          audioPath: input.audioPath,
          pcmDataOffset: input.pcmDataOffset,
          pcmDataLength: input.pcmDataLength,
          signal: operationSignal,
        });
        await socket.sendText(asrFinishTask(taskId));
      })();
      const [, transcript] = await Promise.all([
        streamingPromise,
        transcriptPromise,
      ]);
      completed = true;
      return transcript;
    } catch (error) {
      throw mapProviderFailure({
        stage: "asr",
        error,
        parentSignal: input.signal,
        abortContext,
      });
    } finally {
      if (completed) {
        socket?.close();
        operationController.abort();
      } else {
        operationController.abort();
        socket?.close();
      }
      abortContext.dispose();
    }
  }
}
