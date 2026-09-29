import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";

import {
  ClosedBetaEnrollmentFailure,
  type ClosedBetaEnrollmentFailureCode,
  type ClosedBetaEnrollmentService,
} from "./closedBetaEnrollmentService.js";

const errorMessages: Readonly<
  Record<ClosedBetaEnrollmentFailureCode, string>
> = Object.freeze({
  ENROLLMENT_INVALID_OR_EXPIRED: "注册凭证无效或已过期",
  PHONE_NOT_ALLOWED: "此手机号无法使用",
  TOO_MANY_REQUESTS: "请求过于频繁，请稍后重试",
  SERVICE_UNAVAILABLE: "服务暂时不可用，请稍后再试",
});

function exactRequestBody(
  value: unknown,
): value is { phone: string; enrollmentCredential: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  return (
    keys.length === 2 &&
    Object.hasOwn(body, "phone") &&
    Object.hasOwn(body, "enrollmentCredential") &&
    typeof body.phone === "string" &&
    typeof body.enrollmentCredential === "string"
  );
}

function exactCodeRequestBody(value: unknown): value is { phone: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  return (
    keys.length === 1 &&
    Object.hasOwn(body, "phone") &&
    typeof body.phone === "string"
  );
}

function sendFailure(reply: FastifyReply, error: unknown): FastifyReply {
  const failure =
    error instanceof ClosedBetaEnrollmentFailure
      ? error
      : new ClosedBetaEnrollmentFailure("SERVICE_UNAVAILABLE", 503);
  if (failure.retryAfterSeconds !== undefined) {
    reply.header("Retry-After", String(failure.retryAfterSeconds));
  }
  return reply.code(failure.statusCode).send({
    code: failure.code,
    message: errorMessages[failure.code],
    ...(failure.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: failure.retryAfterSeconds }),
  });
}

const requestShapeErrorHandler = {
  errorHandler(
    error: Error,
    _request: FastifyRequest,
    reply: FastifyReply,
  ): FastifyReply {
    const statusCode = (error as Error & { statusCode?: unknown })
      .statusCode;
    if (
      typeof statusCode !== "number" ||
      statusCode < 400 ||
      statusCode >= 500
    ) {
      return sendFailure(reply, error);
    }
    return sendFailure(
      reply,
      new ClosedBetaEnrollmentFailure(
        "ENROLLMENT_INVALID_OR_EXPIRED",
        400,
      ),
    );
  },
};

export function registerClosedBetaEnrollmentRoutes(
  app: FastifyInstance,
  service: ClosedBetaEnrollmentService,
): void {
  app.post(
    "/api/community/v1/auth/enrollment/code",
    {
      errorHandler(
        error: Error,
        _request: FastifyRequest,
        reply: FastifyReply,
      ): FastifyReply {
        const statusCode = (error as Error & { statusCode?: unknown })
          .statusCode;
        if (
          typeof statusCode !== "number" ||
          statusCode < 400 ||
          statusCode >= 500
        ) {
          return sendFailure(reply, error);
        }
        return sendFailure(
          reply,
          new ClosedBetaEnrollmentFailure("PHONE_NOT_ALLOWED", 400),
        );
      },
    },
    async (request, reply) => {
      try {
        if (!exactCodeRequestBody(request.body)) {
          throw new ClosedBetaEnrollmentFailure("PHONE_NOT_ALLOWED", 400);
        }
        return await service.requestCode({
          phone: request.body.phone,
          ipAddress: request.ip,
          requestId: request.id,
        });
      } catch (error) {
        return sendFailure(reply, error);
      }
    },
  );
  app.post(
    "/api/community/v1/auth/enrollment/verify",
    requestShapeErrorHandler,
    async (request, reply) => {
      try {
        if (!exactRequestBody(request.body)) {
          throw new ClosedBetaEnrollmentFailure(
            "ENROLLMENT_INVALID_OR_EXPIRED",
            400,
          );
        }
        return await service.verify({
          phone: request.body.phone,
          enrollmentCredential: request.body.enrollmentCredential,
          ipAddress: request.ip,
          requestId: request.id,
        });
      } catch (error) {
        return sendFailure(reply, error);
      }
    },
  );
}
