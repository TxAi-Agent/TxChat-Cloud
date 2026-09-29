import multipart from "@fastify/multipart";
import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RequestPayload,
} from "fastify";
import { Transform } from "node:stream";

import { AuthFailure } from "../auth/authService.js";
import {
  AUDIO_HTTP_BODY_MAX_BYTES,
  AudioValidationFailure,
} from "./audioValidation.js";
import {
  DictationFailure,
  type DictationService,
} from "./dictationService.js";

const failureMessages = {
  AUDIO_INVALID: "录音格式或时长无效",
  AUTH_REQUIRED: "请重新验证手机号",
  SESSION_REPLACED: "会话已在其他设备更新，请重新验证手机号",
  SESSION_EXPIRED: "会话已过期，请重新验证手机号",
  ACCOUNT_DISABLED: "账户当前不可用",
  TOO_MANY_REQUESTS: "请求过于频繁，请稍后再试",
  BILLING_QUOTA_EXHAUSTED: "默认云服务额度已用完",
  ASR_FAILED: "语音识别失败",
  REWRITE_FAILED: "文字整理失败",
  SERVICE_UNAVAILABLE: "服务暂时不可用",
} as const;

type SafeFailureCode = keyof typeof failureMessages;

type CompleteBodyObservation = Readonly<{
  completed: Promise<void>;
  tooLarge(): boolean;
}>;

const completeBodyObservations = new WeakMap<
  FastifyRequest["raw"],
  CompleteBodyObservation
>();

class CompleteBodyTooLargeFailure extends Error {
  constructor() {
    super("Complete request body exceeded limit");
    this.name = "CompleteBodyTooLargeFailure";
  }
}

function isMultipartRequest(request: FastifyRequest): boolean {
  const contentType = request.headers["content-type"];
  return (
    typeof contentType === "string" &&
    contentType.toLowerCase().startsWith("multipart/form-data")
  );
}

async function observeCompleteMultipartBody(
  request: FastifyRequest,
  _reply: FastifyReply,
  payload: RequestPayload,
): Promise<RequestPayload> {
  if (!isMultipartRequest(request)) {
    return payload;
  }

  let resolveCompleted!: () => void;
  let settled = false;
  let exceeded = false;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const settle = () => {
    if (settled) {
      return;
    }
    settled = true;
    resolveCompleted();
  };
  const declaredLength = Number(request.headers["content-length"]);
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > AUDIO_HTTP_BODY_MAX_BYTES
  ) {
    exceeded = true;
    settle();
  }
  completeBodyObservations.set(
    request.raw,
    Object.freeze({
      completed,
      tooLarge: () => exceeded,
    }),
  );
  if (exceeded) {
    return payload;
  }

  const raw = request.raw;
  const originalPipe = raw.pipe.bind(raw);
  let pipeConnected = false;
  raw.pipe = ((destination, options) => {
    if (pipeConnected) {
      return originalPipe(destination, options);
    }
    pipeConnected = true;
    let receivedBytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        receivedBytes += chunk.length;
        if (receivedBytes > AUDIO_HTTP_BODY_MAX_BYTES) {
          exceeded = true;
          done(new CompleteBodyTooLargeFailure());
          return;
        }
        done(null, chunk);
      },
    });
    counter.on("data", () => {
      // Keep counting after a parser stops at the closing boundary.
    });
    counter.once("end", settle);
    counter.once("error", (error) => {
      exceeded = true;
      settle();
      raw.unpipe(counter);
      raw.resume();
      const writableDestination = destination as unknown as {
        destroyed?: boolean;
        destroy(error?: Error): void;
      };
      if (writableDestination.destroyed !== true) {
        writableDestination.destroy(error);
      }
    });
    raw.once("aborted", settle);
    raw.once("close", settle);
    raw.once("error", settle);
    counter.pipe(destination, options);
    originalPipe(counter);
    return destination;
  }) as typeof raw.pipe;
  return payload;
}

function bearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  const match =
    typeof authorization === "string"
      ? /^Bearer ([^\s]+)$/.exec(authorization)
      : null;
  if (match?.[1] === undefined) {
    throw new AuthFailure("AUTH_REQUIRED", 401);
  }
  return match[1];
}

function safeFailure(error: unknown): {
  code: SafeFailureCode;
  statusCode: number;
  retryAfterSeconds?: number;
} {
  if (error instanceof DictationFailure) {
    return {
      code: error.code,
      statusCode: error.statusCode,
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: error.retryAfterSeconds }),
    };
  }
  if (
    error instanceof AuthFailure &&
    error.code in failureMessages &&
    error.code !== "PHONE_INVALID" &&
    error.code !== "VERIFICATION_CODE_INVALID_OR_EXPIRED" &&
    error.code !== "SMS_PROVIDER_UNAVAILABLE" &&
    error.code !== "INVALID_REQUEST" &&
    error.code !== "SESSION_REPLAYED"
  ) {
    return {
      code: error.code,
      statusCode: error.statusCode,
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: error.retryAfterSeconds }),
    };
  }
  return {
    code: "SERVICE_UNAVAILABLE",
    statusCode: 503,
  };
}

function sendFailure(reply: FastifyReply, error: unknown) {
  const failure = safeFailure(error);
  if (failure.retryAfterSeconds !== undefined) {
    reply.header("Retry-After", String(failure.retryAfterSeconds));
  }
  return reply.code(failure.statusCode).send({
    code: failure.code,
    message: failureMessages[failure.code],
    action:
      failure.code === "BILLING_QUOTA_EXHAUSTED"
        ? ("purchase_membership" as const)
        : ("record_again" as const),
    ...(failure.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: failure.retryAfterSeconds }),
  });
}

const successSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "requestId",
    "finalText",
    "asrMs",
    "rewriteMs",
    "totalMs",
  ],
  properties: {
    requestId: { type: "string", format: "uuid" },
    finalText: { type: "string", minLength: 1 },
    asrMs: { type: "integer", minimum: 0 },
    rewriteMs: { type: "integer", minimum: 0 },
    totalMs: { type: "integer", minimum: 0 },
  },
} as const;

export function registerDictationRoutes(
  app: FastifyInstance,
  service: DictationService,
): void {
  app.register(async (scope) => {
    await scope.register(multipart, {
      limits: {
        files: 1,
        fields: 0,
        parts: 1,
        fileSize: AUDIO_HTTP_BODY_MAX_BYTES,
      },
    });

    scope.post(
      "/api/community/v1/dictations",
      {
        bodyLimit: AUDIO_HTTP_BODY_MAX_BYTES,
        preParsing: observeCompleteMultipartBody,
        errorHandler: (
          _error: FastifyError,
          _request: FastifyRequest,
          reply: FastifyReply,
        ) => {
          sendFailure(
            reply,
            new DictationFailure("AUDIO_INVALID", 400),
          );
        },
        schema: {
          response: {
            200: successSchema,
          },
        },
      },
      async (request, reply) => {
        const disconnected = new AbortController();
        const abortOnDisconnect = () => {
          if (!reply.raw.writableEnded) {
            disconnected.abort();
          }
        };
        request.raw.once("aborted", abortOnDisconnect);
        reply.raw.once("close", abortOnDisconnect);
        try {
          const result = await service.process({
            accessToken: bearerToken(request),
            signal: disconnected.signal,
            openAudio: async (signal) => {
              const bodyObservation = completeBodyObservations.get(
                request.raw,
              );
              if (bodyObservation?.tooLarge() === true) {
                throw new AudioValidationFailure();
              }
              if (signal.aborted) {
                throw new AudioValidationFailure();
              }
              const abortBeforePart = () => {
                request.raw.destroy();
              };
              signal.addEventListener("abort", abortBeforePart, {
                once: true,
              });
              if (signal.aborted) {
                abortBeforePart();
                signal.removeEventListener("abort", abortBeforePart);
                throw new AudioValidationFailure();
              }
              const iterator = request.parts({
                limits: {
                  files: 1,
                  fields: 0,
                  parts: 1,
                  fileSize: AUDIO_HTTP_BODY_MAX_BYTES,
                },
              });
              const first = await iterator.next().finally(() => {
                signal.removeEventListener("abort", abortBeforePart);
              });
              if (first.done || first.value.type !== "file") {
                throw new AudioValidationFailure();
              }
              const part = first.value;
              return {
                fieldname: part.fieldname,
                filename: part.filename,
                mimetype: part.mimetype,
                stream: (async function* () {
                  const abortStream = () => {
                    part.file.destroy();
                  };
                  signal.addEventListener("abort", abortStream, {
                    once: true,
                  });
                  if (signal.aborted) {
                    abortStream();
                  }
                  try {
                    for await (const chunk of part.file) {
                      yield chunk;
                    }
                    if (part.file.truncated) {
                      throw new AudioValidationFailure();
                    }
                    const extra = await iterator.next();
                    if (!extra.done) {
                      throw new AudioValidationFailure();
                    }
                    await bodyObservation?.completed;
                    if (bodyObservation?.tooLarge() === true) {
                      throw new AudioValidationFailure();
                    }
                  } catch (error) {
                    if (signal.aborted) {
                      throw error;
                    }
                    throw new AudioValidationFailure();
                  } finally {
                    signal.removeEventListener("abort", abortStream);
                  }
                })(),
              };
            },
          });
          return reply.code(200).send(result);
        } catch (error) {
          return sendFailure(reply, error);
        } finally {
          request.raw.removeListener("aborted", abortOnDisconnect);
          reply.raw.removeListener("close", abortOnDisconnect);
        }
      },
    );
  });
}
