import fastify, {
  LogController,
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import websocket from "@fastify/websocket";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { registerAuthRoutes } from "./auth/authRoutes.js";
import type { AuthService } from "./auth/authService.js";
import { registerClosedBetaEnrollmentRoutes } from "./auth/closedBetaEnrollmentRoutes.js";
import type { ClosedBetaEnrollmentService } from "./auth/closedBetaEnrollmentService.js";
import {
  registerBillingRoutes,
  type BillingRoutesOptions,
} from "./billing/billingRoutes.js";
import { registerDictationRoutes } from "./dictation/dictationRoutes.js";
import type { DictationService } from "./dictation/dictationService.js";
import { registerDiagnosticReportRoutes } from "./diagnostics/diagnosticReportRoutes.js";
import type { DiagnosticReportService } from "./diagnostics/diagnosticReportService.js";
import {
  registerStreamingDictationRoutes,
  type StreamingDictationService,
} from "./realtime/streamingDictationRoutes.js";
import { sanitizeLogObject } from "./observability/redaction.js";
import { ContentFreeMetrics } from "./observability/metrics.js";

export type Readiness = {
  migrations: boolean;
  temporaryAudioCleanup: boolean;
  retentionCleanup: boolean;
  databases: boolean;
};

export type ReadinessController = Readonly<{
  snapshot(): Readiness;
  update(update: Partial<Readiness>): void;
}>;

type LoggerOptions = Exclude<
  NonNullable<FastifyServerOptions["logger"]>,
  boolean
>;

export type BuildAppOptions = Readonly<{
  readiness?: ReadinessController;
  configuredLoginReadiness?: () => boolean;
  logger?: boolean | LoggerOptions;
  authService?: AuthService;
  billing?: BillingRoutesOptions;
  smsAuthenticationEnabled?: boolean;
  closedBetaEnrollmentService?: ClosedBetaEnrollmentService;
  dictationService?: DictationService;
  diagnosticReportService?: DiagnosticReportService;
  streamingDictationService?: StreamingDictationService;
  metrics?: ContentFreeMetrics;
}>;

const notReady: Readiness = Object.freeze({
  migrations: false,
  temporaryAudioCleanup: false,
  retentionCleanup: false,
  databases: false,
});

function selectReadiness(
  candidate: Partial<Readiness>,
  fallback: Readiness = notReady,
): Readiness {
  return Object.freeze({
    migrations: candidate.migrations ?? fallback.migrations,
    temporaryAudioCleanup:
      candidate.temporaryAudioCleanup ?? fallback.temporaryAudioCleanup,
    retentionCleanup:
      candidate.retentionCleanup ?? fallback.retentionCleanup,
    databases: candidate.databases ?? fallback.databases,
  });
}

export function createReadinessController(
  initial: Partial<Readiness> = {},
): ReadinessController {
  let state = selectReadiness(initial);

  return Object.freeze({
    snapshot: () => state,
    update: (update: Partial<Readiness>) => {
      state = selectReadiness(update, state);
    },
  });
}

function requestMetadata(request: FastifyRequest) {
  return {
    requestId: request.id,
    method: request.method,
    path: request.url.split("?", 1)[0] ?? "/",
  };
}

function responseMetadata(response: { statusCode: number | string }) {
  return {
    statusCode: response.statusCode,
  };
}

function safeLoggerOptions(
  logger: BuildAppOptions["logger"],
): false | LoggerOptions {
  if (logger === undefined || logger === false) {
    return false;
  }

  const serializers = {
    req: requestMetadata,
    res: responseMetadata,
  };
  const suppliedLogFormatter =
    logger === true ? undefined : logger.formatters?.log;
  const formatters = {
    ...(logger === true ? {} : logger.formatters),
    log(object: Record<string, unknown>) {
      const formatted = suppliedLogFormatter?.(object) ?? object;
      return sanitizeLogObject(formatted);
    },
  };
  if (logger === true) {
    return {
      base: null,
      timestamp: false,
      serializers,
      formatters,
    };
  }

  return {
    ...logger,
    base: null,
    timestamp: false,
    formatters,
    serializers: {
      ...logger.serializers,
      ...serializers,
    },
  };
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const readiness = options.readiness ?? createReadinessController();
  const metrics = options.metrics ?? new ContentFreeMetrics();
  const requestStartedAt = new WeakMap<FastifyRequest, number>();
  const app = fastify({
    logger: safeLoggerOptions(options.logger),
    genReqId: () => randomUUID(),
    trustProxy: false,
    logController: new LogController({
      disableRequestLogging: true,
    }),
  });

  if (options.streamingDictationService !== undefined) {
    void app.register(websocket, {
      options: { maxPayload: 8_192 },
    });
  }

  app.addHook("onRequest", async (request) => {
    requestStartedAt.set(request, performance.now());
  });

  app.addHook("onResponse", async (request, reply) => {
    const durationMs = Math.max(
      0,
      Math.round(
        performance.now() - (requestStartedAt.get(request) ?? performance.now()),
      ),
    );
    requestStartedAt.delete(request);
    metrics.recordRequest({
      httpStatus: reply.statusCode,
      durationMs,
    });
    app.log.info(
      {
        requestId: request.id,
        status: reply.statusCode,
        durationMs,
        stage: "request",
        code: "HTTP_COMPLETED",
      },
      "request completed",
    );
  });

  app.get("/api/community/health/live", async () => ({ status: "ok" as const }));

  app.get("/api/community/health/ready", async (_request, reply) => {
    const snapshot = selectReadiness(readiness.snapshot());
    let configuredLogin = false;
    try {
      configuredLogin = options.configuredLoginReadiness?.() ?? true;
    } catch {
      configuredLogin = false;
    }
    metrics.updateHealth({
      databases: snapshot.databases,
      temporaryAudioCleanup: snapshot.temporaryAudioCleanup,
      retentionCleanup: snapshot.retentionCleanup,
    });
    const ready =
      snapshot.migrations &&
      snapshot.temporaryAudioCleanup &&
      snapshot.retentionCleanup &&
      snapshot.databases &&
      configuredLogin;

    if (ready) {
      return reply.code(200).send({
        status: "ok" as const,
        migrations: true,
        temporaryAudioCleanup: true,
        retentionCleanup: true,
        databases: true,
        configuredLogin: true,
      });
    }

    return reply.code(503).send({
      status: "not_ready" as const,
      migrations: snapshot.migrations,
      temporaryAudioCleanup: snapshot.temporaryAudioCleanup,
      retentionCleanup: snapshot.retentionCleanup,
      databases: snapshot.databases,
      configuredLogin,
    });
  });

  if (options.authService !== undefined) {
    registerAuthRoutes(app, options.authService, {
      smsAuthenticationEnabled:
        options.smsAuthenticationEnabled ?? true,
    });
  }
  if (options.billing !== undefined) {
    registerBillingRoutes(app, options.billing);
  }
  if (options.closedBetaEnrollmentService !== undefined) {
    registerClosedBetaEnrollmentRoutes(
      app,
      options.closedBetaEnrollmentService,
    );
  }
  if (options.dictationService !== undefined) {
    registerDictationRoutes(app, options.dictationService);
  }
  if (options.diagnosticReportService !== undefined) {
    registerDiagnosticReportRoutes(app, options.diagnosticReportService);
  }
  if (options.streamingDictationService !== undefined) {
    registerStreamingDictationRoutes(
      app,
      options.streamingDictationService,
    );
  }

  return app;
}
