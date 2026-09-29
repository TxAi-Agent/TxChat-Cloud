import type {
  FastifyInstance,
  FastifyReply,
} from "fastify";

import {
  DiagnosticReportFailure,
  type DiagnosticReportFailureCode,
  type DiagnosticReportService,
} from "./diagnosticReportService.js";

const messages: Readonly<Record<DiagnosticReportFailureCode, string>> =
  Object.freeze({
    DIAGNOSTIC_INVALID: "诊断信息格式无效",
    REPORT_ID_CONFLICT: "诊断报告编号冲突",
    TOO_MANY_REQUESTS: "问题发送过于频繁，请稍后重试",
    SERVICE_UNAVAILABLE: "问题暂时无法发送，请稍后重试",
  });

function sendFailure(
  reply: FastifyReply,
  error: DiagnosticReportFailure,
): FastifyReply {
  if (error.retryAfterSeconds !== undefined) {
    reply.header("Retry-After", String(error.retryAfterSeconds));
  }
  return reply.code(error.statusCode).send({
    code: error.code,
    message: messages[error.code],
    ...(error.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: error.retryAfterSeconds }),
  });
}

export function registerDiagnosticReportRoutes(
  app: FastifyInstance,
  service: DiagnosticReportService,
): void {
  app.post(
    "/api/community/v1/diagnostic-reports",
    {
      bodyLimit: 65_536,
      errorHandler(error, _request, reply) {
        const statusCode =
          "code" in error && error.code === "FST_ERR_CTP_BODY_TOO_LARGE"
            ? 413
            : 400;
        return reply.code(statusCode).send({
          code: "DIAGNOSTIC_INVALID",
          message: messages.DIAGNOSTIC_INVALID,
        });
      },
    },
    async (request, reply) => {
      try {
        const result = service.submit({
          body: request.body,
          ipAddress: request.ip,
        });
        return reply.code(result.created ? 201 : 200).send({
          diagnosticNumber: result.diagnosticNumber,
          reportId: result.reportId,
          receivedAt: result.receivedAt,
        });
      } catch (error) {
        return sendFailure(
          reply,
          error instanceof DiagnosticReportFailure
            ? error
            : new DiagnosticReportFailure("SERVICE_UNAVAILABLE", 503),
        );
      }
    },
  );
}
