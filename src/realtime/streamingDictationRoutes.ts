import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import type { RawData, WebSocket } from "ws";

import { AuthFailure, type AuthService } from "../auth/authService.js";
import {
  BILLING_USAGE_TICKET_LEASE_MS,
  type BillingUsageService,
  type BillingUsageTicket,
} from "../billing/billingUsageService.js";
import { BillingFailure } from "../billing/billingTypes.js";
import {
  type RegisteredSessionOperation,
  SessionOperationRegistry,
  SessionOperationRevoked,
  type SessionRevocationReason,
} from "../auth/sessionService.js";
import type { StreamingRouteSelector } from "./asrModelRouter.js";
import type { TextRewriteProvider } from "../providers/providerTypes.js";
import {
  encodeServerControl,
  parseClientControl,
  RealtimeProtocolError,
  type RealtimeFailureCode,
  type RealtimeFallbackReason,
  type ServerControl,
} from "./realtimeProtocol.js";
import { StreamingDictationSession } from "./streamingDictationSession.js";

type AuthenticatedIdentity = Awaited<
  ReturnType<AuthService["authenticateAccessToken"]>
>;

export type StreamingDictationServiceOptions = Readonly<{
  authService: Pick<AuthService, "authenticateAccessToken">;
  sessionOperations: SessionOperationRegistry;
  router: StreamingRouteSelector;
  textRewriteProvider: TextRewriteProvider;
  finalTimeoutMs: number;
  upstreamOpenTimeoutMs: number;
  requestId?: () => string;
  billingUsage?: Pick<BillingUsageService, "begin" | "settle" | "abandon">;
  observeTextOptimizationFallback?: (
    reason: RealtimeFallbackReason,
  ) => void;
}>;

type ConnectionInput = Readonly<{
  noSpeechCapability?: boolean;
  identity: AuthenticatedIdentity;
  signal: AbortSignal;
  emit(message: ServerControl): Promise<void>;
  closeDownstream(): void;
}>;

const BILLING_USAGE_LEASE_MARGIN_MS = 10 * 60_000;
export const BILLED_REALTIME_SESSION_LIFETIME_MS =
  BILLING_USAGE_TICKET_LEASE_MS - BILLING_USAGE_LEASE_MARGIN_MS;
export const REALTIME_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 1_000;

export type StreamingDictationConnection = Readonly<{
  receiveControl(message: Parameters<StreamingDictationSession["receiveControl"]>[0]): Promise<void>;
  receiveAudio(frame: Uint8Array): Promise<void>;
  terminate(code: RealtimeFailureCode): Promise<void>;
  disconnect(): Promise<void>;
  gracefulShutdown(): Promise<void>;
}>;

export class StreamingDictationConnectionFailure extends Error {
  constructor(
    readonly code:
      | "TOO_MANY_REQUESTS"
      | "BILLING_QUOTA_EXHAUSTED" = "TOO_MANY_REQUESTS",
  ) {
    super(code);
    this.name = "StreamingDictationConnectionFailure";
  }
}

function revocationCode(reason: SessionRevocationReason): RealtimeFailureCode {
  if (reason === "replaced") {
    return "SESSION_REPLACED";
  }
  if (reason === "disabled") {
    return "ACCOUNT_DISABLED";
  }
  return "SESSION_EXPIRED";
}

export class StreamingDictationService {
  readonly #options: StreamingDictationServiceOptions;
  readonly #activeAccounts = new Set<string>();
  readonly #connections = new Set<StreamingDictationConnection>();
  readonly #requestId: () => string;

  constructor(options: StreamingDictationServiceOptions) {
    this.#options = options;
    this.#requestId = options.requestId ?? randomUUID;
  }

  authenticateAccessToken(accessToken: string): Promise<AuthenticatedIdentity> {
    return this.#options.authService.authenticateAccessToken(accessToken);
  }

  connect(input: ConnectionInput): StreamingDictationConnection {
    if (this.#activeAccounts.has(input.identity.accountId)) {
      throw new StreamingDictationConnectionFailure();
    }
    const requestId = this.#requestId();
    let usageTicket: BillingUsageTicket | undefined;
    try {
      usageTicket = this.#options.billingUsage?.begin({
        userId: input.identity.accountId,
        requestId,
      });
    } catch (error) {
      if (
        error instanceof BillingFailure &&
        error.code === "BILLING_QUOTA_EXHAUSTED"
      ) {
        throw new StreamingDictationConnectionFailure(
          "BILLING_QUOTA_EXHAUSTED",
        );
      }
      throw error;
    }
    let usageTerminal = false;
    const usage = Object.freeze({
      settle: (settlement: Readonly<{
        uploadedPcmBytes: number;
        outcome: "usable_text" | "user_cancelled";
      }>) => {
        if (usageTerminal) {
          return;
        }
        usageTerminal = true;
        if (
          this.#options.billingUsage !== undefined &&
          usageTicket !== undefined
        ) {
          this.#options.billingUsage.settle(usageTicket, settlement);
        }
      },
      abandon: () => {
        if (usageTerminal) {
          return;
        }
        usageTerminal = true;
        if (
          this.#options.billingUsage !== undefined &&
          usageTicket !== undefined
        ) {
          this.#options.billingUsage.abandon(usageTicket);
        }
      },
    });
    this.#activeAccounts.add(input.identity.accountId);
    let operation: RegisteredSessionOperation | undefined;
    let active = true;
    let connection!: StreamingDictationConnection;
    let session: StreamingDictationSession | undefined;
    let lifetimeTimer: NodeJS.Timeout | undefined;
    let downstreamClosed = false;
    let terminalDeliveryCompleted = false;
    let completeTerminalDelivery!: () => void;
    const terminalDelivery = new Promise<void>((resolve) => {
      completeTerminalDelivery = () => {
        if (terminalDeliveryCompleted) {
          return;
        }
        terminalDeliveryCompleted = true;
        resolve();
      };
    });

    const closeDownstream = () => {
      if (downstreamClosed) {
        return;
      }
      downstreamClosed = true;
      try {
        input.closeDownstream();
      } catch {
        // Logical closure and cleanup remain authoritative.
      }
    };

    const release = () => {
      if (!active) {
        return;
      }
      active = false;
      if (lifetimeTimer !== undefined) {
        clearTimeout(lifetimeTimer);
        lifetimeTimer = undefined;
      }
      operation?.signal.removeEventListener("abort", handleRevocation);
      input.signal.removeEventListener("abort", handleInputAbort);
      this.#activeAccounts.delete(input.identity.accountId);
      this.#connections.delete(connection);
      operation?.complete();
    };
    const emit = async (message: ServerControl) => {
      try {
        await input.emit(message);
        if (message.type === "session.ended") {
          release();
          completeTerminalDelivery();
        }
      } catch (error) {
        session?.interrupt();
        release();
        closeDownstream();
        completeTerminalDelivery();
        throw error;
      }
    };
    const terminate = async (code: RealtimeFailureCode) => {
      if (!active) {
        return;
      }
      const claimed = session?.interrupt() ?? false;
      release();
      if (!claimed) {
        return;
      }
      try {
        await input.emit({ type: "session.failed", code });
        await input.emit({ type: "session.ended" });
      } catch {
        // The downstream is already unusable; cleanup and closure still finish.
      } finally {
        closeDownstream();
        completeTerminalDelivery();
      }
    };
    const disconnect = async () => {
      if (!active) {
        return;
      }
      session?.interrupt();
      release();
      closeDownstream();
      completeTerminalDelivery();
    };
    const gracefulShutdown = async () => {
      if (active && session?.interrupt() === true) {
        release();
        closeDownstream();
        completeTerminalDelivery();
        return;
      }

      let fallbackTimer: NodeJS.Timeout | undefined;
      const boundedFallback = new Promise<false>((resolve) => {
        fallbackTimer = setTimeout(() => {
          resolve(false);
        }, REALTIME_GRACEFUL_SHUTDOWN_TIMEOUT_MS);
        fallbackTimer.unref();
      });
      const delivered = await Promise.race([
        terminalDelivery.then(() => true as const),
        boundedFallback,
      ]);
      if (fallbackTimer !== undefined) {
        clearTimeout(fallbackTimer);
      }
      if (!delivered) {
        release();
        completeTerminalDelivery();
      }
      closeDownstream();
    };
    const handleRevocation = () => {
      const reason = operation?.signal.reason;
      const code =
        reason instanceof SessionOperationRevoked
          ? revocationCode(reason.reason)
          : "SESSION_EXPIRED";
      void terminate(code);
    };
    const handleInputAbort = () => {
      void disconnect();
    };

    try {
      operation = this.#options.sessionOperations.register(
        input.identity.sessionId,
      );
      session = new StreamingDictationSession({
        noSpeechCapability: input.noSpeechCapability === true,
        requestId,
        identity: input.identity,
        router: this.#options.router,
        textRewriteProvider: this.#options.textRewriteProvider,
        emit,
        finalTimeoutMs: this.#options.finalTimeoutMs,
        upstreamOpenTimeoutMs: this.#options.upstreamOpenTimeoutMs,
        signal: input.signal,
        usage,
        ...(this.#options.observeTextOptimizationFallback === undefined
          ? {}
          : {
              observeTextOptimizationFallback:
                this.#options.observeTextOptimizationFallback,
            }),
      });
      const activeSession = session;
      connection = Object.freeze({
        receiveControl: (message) => activeSession.receiveControl(message),
        receiveAudio: (frame) => activeSession.receiveAudio(frame),
        terminate,
        disconnect,
        gracefulShutdown,
      });
      this.#connections.add(connection);
      operation.signal.addEventListener("abort", handleRevocation, {
        once: true,
      });
      input.signal.addEventListener("abort", handleInputAbort, {
        once: true,
      });
      if (this.#options.billingUsage !== undefined) {
        lifetimeTimer = setTimeout(() => {
          void terminate("UPSTREAM_UNAVAILABLE");
        }, BILLED_REALTIME_SESSION_LIFETIME_MS);
        lifetimeTimer.unref();
      }
      if (operation.signal.aborted) {
        handleRevocation();
      }
      if (input.signal.aborted) {
        handleInputAbort();
      }
      return connection;
    } catch (error) {
      session?.interrupt();
      try {
        usage.abandon();
      } catch {
        // Preserve the original construction/registration failure.
      }
      release();
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.#connections].map((connection) =>
        connection.gracefulShutdown(),
      ),
    );
  }
}

const authenticatedIdentities = new WeakMap<object, AuthenticatedIdentity>();

function bearerToken(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  const match =
    typeof authorization === "string"
      ? /^Bearer ([^\s]+)$/.exec(authorization)
      : null;
  return match?.[1];
}

function safeAuthFailure(error: unknown): Readonly<{
  code: RealtimeFailureCode;
  statusCode: number;
}> {
  if (error instanceof AuthFailure) {
    if (
      error.code === "SESSION_REPLACED" ||
      error.code === "SESSION_EXPIRED" ||
      error.code === "ACCOUNT_DISABLED" ||
      error.code === "TOO_MANY_REQUESTS"
    ) {
      return Object.freeze({ code: error.code, statusCode: error.statusCode });
    }
  }
  return Object.freeze({ code: "AUTH_REQUIRED", statusCode: 401 });
}

function sendUpgradeFailure(
  reply: FastifyReply,
  failure: Readonly<{ code: RealtimeFailureCode; statusCode: number }>,
): void {
  void reply.code(failure.statusCode).send({ code: failure.code });
}

function sendSocketControl(
  socket: WebSocket,
  message: ServerControl,
): Promise<void> {
  if (socket.readyState !== socket.OPEN) {
    return Promise.resolve();
  }
  const encoded = encodeServerControl(message);
  return new Promise((resolve) => {
    socket.send(encoded, () => resolve());
  });
}

function binaryFrame(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function closeNormally(socket: WebSocket): void {
  if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
    socket.close(1000);
  }
}

export function registerStreamingDictationRoutes(
  app: FastifyInstance,
  service: StreamingDictationService,
): void {
  app.register(async (scope) => {
    scope.get(
      "/api/community/v2/realtime-dictations",
      {
        websocket: true,
        preValidation: async (request, reply) => {
          const token = bearerToken(request);
          if (token === undefined) {
            sendUpgradeFailure(reply, {
              code: "AUTH_REQUIRED",
              statusCode: 401,
            });
            return;
          }
          try {
            const identity = await service.authenticateAccessToken(token);
            authenticatedIdentities.set(request.raw, identity);
          } catch (error) {
            sendUpgradeFailure(reply, safeAuthFailure(error));
          }
        },
      },
      (socket, request) => {
        const identity = authenticatedIdentities.get(request.raw);
        authenticatedIdentities.delete(request.raw);
        const disconnected = new AbortController();
        let connectionPromise!: Promise<
          StreamingDictationConnection | undefined
        >;
        let inbound = Promise.resolve();

        const onDisconnect = () => {
          disconnected.abort();
          void connectionPromise.then((connection) =>
            connection?.disconnect(),
          );
        };
        socket.once("close", onDisconnect);
        socket.once("error", onDisconnect);
        socket.on("message", (data, isBinary) => {
          inbound = inbound
            .then(async () => {
              const connection = await connectionPromise;
              if (connection === undefined) {
                return;
              }
              if (isBinary) {
                await connection.receiveAudio(binaryFrame(data));
                return;
              }
              try {
                await connection.receiveControl(
                  parseClientControl(data.toString()),
                );
              } catch (error) {
                if (error instanceof RealtimeProtocolError) {
                  await connection.terminate("PROTOCOL_ERROR");
                  return;
                }
                await connection.terminate("UPSTREAM_UNAVAILABLE");
              }
            })
            .catch(() => {});
        });

        connectionPromise = (async () => {
          if (identity === undefined) {
            await sendSocketControl(socket, {
              type: "session.failed",
              code: "AUTH_REQUIRED",
            });
            await sendSocketControl(socket, { type: "session.ended" });
            closeNormally(socket);
            return undefined;
          }
          try {
            return service.connect({
              noSpeechCapability: request.headers["x-community-realtime-capabilities"] === "no-speech-v1",
              identity,
              signal: disconnected.signal,
              emit: async (message) => {
                await sendSocketControl(socket, message);
                if (message.type === "session.ended") {
                  closeNormally(socket);
                }
              },
              closeDownstream: () => closeNormally(socket),
            });
          } catch (error) {
            const code =
              error instanceof StreamingDictationConnectionFailure
                ? error.code
                : "UPSTREAM_UNAVAILABLE";
            await sendSocketControl(socket, { type: "session.failed", code });
            await sendSocketControl(socket, { type: "session.ended" });
            closeNormally(socket);
            return undefined;
          }
        })();
      },
    );
  });
}
