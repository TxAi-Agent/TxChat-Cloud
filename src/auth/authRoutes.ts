import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";

import {
  AuthFailure,
  type AuthFailureCode,
  type AuthService,
} from "./authService.js";
import { isInternalId } from "../ids/internalId.js";

export {
  registerClosedBetaEnrollmentRoutes,
} from "./closedBetaEnrollmentRoutes.js";

const errorMessages: Readonly<Record<AuthFailureCode, string>> =
  Object.freeze({
    PHONE_INVALID: "请输入有效的中国大陆手机号",
    VERIFICATION_CODE_INVALID_OR_EXPIRED: "验证码无效或已过期",
    TOO_MANY_REQUESTS: "请求过于频繁，请稍后重试",
    SMS_PROVIDER_UNAVAILABLE: "验证码暂时无法发送，请稍后重试",
    INVALID_REQUEST: "请求格式无效",
    AUTH_REQUIRED: "请重新验证手机号",
    SESSION_REPLACED: "会话已在其他设备更新，请重新验证手机号",
    SESSION_EXPIRED: "会话已过期，请重新验证手机号",
    ACCOUNT_DISABLED: "账户当前不可用",
    SESSION_REPLAYED: "会话已失效，请重新验证手机号",
    SERVICE_UNAVAILABLE: "服务暂时不可用，请稍后再试",
  });

function isObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every(
      (key) => required.includes(key) || optional.includes(key),
    )
  );
}

function requestId(request: FastifyRequest): string {
  return request.id;
}

function bearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (
    typeof authorization !== "string" ||
    !authorization.startsWith("Bearer ") ||
    authorization.length === "Bearer ".length
  ) {
    throw new AuthFailure("AUTH_REQUIRED", 401);
  }
  return authorization.slice("Bearer ".length);
}

function sendFailure(reply: FastifyReply, error: unknown): FastifyReply {
  const failure =
    error instanceof AuthFailure
      ? error
      : new AuthFailure("SERVICE_UNAVAILABLE", 503);
  if (failure.retryAfterSeconds !== undefined) {
    reply.header("Retry-After", String(failure.retryAfterSeconds));
  }
  return reply.code(failure.statusCode).send({
    code: failure.code,
    message: errorMessages[failure.code],
    ...(failure.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: failure.retryAfterSeconds }),
    ...(failure.details.reason === undefined
      ? {}
      : { reason: failure.details.reason }),
    ...(failure.details.attemptsRemaining === undefined
      ? {}
      : { attemptsRemaining: failure.details.attemptsRemaining }),
  });
}

function requestErrorHandler(
  code: Extract<
    AuthFailureCode,
    | "PHONE_INVALID"
    | "VERIFICATION_CODE_INVALID_OR_EXPIRED"
    | "INVALID_REQUEST"
  >,
): {
  errorHandler(
    error: Error,
    request: FastifyRequest,
    reply: FastifyReply,
  ): FastifyReply;
} {
  return {
    errorHandler: (_error, _request, reply) =>
      sendFailure(reply, new AuthFailure(code, 400)),
  };
}

export function registerAuthRoutes(
  app: FastifyInstance,
  authService: AuthService,
  options: Readonly<{ smsAuthenticationEnabled?: boolean }> = {},
): void {
  if (options.smsAuthenticationEnabled !== false) {
    app.post(
      "/api/community/v1/auth/sms/send",
      requestErrorHandler("PHONE_INVALID"),
      async (request, reply) => {
        try {
          if (
            !isObject(request.body) ||
            !exactKeys(request.body, ["phone"]) ||
            typeof request.body.phone !== "string"
          ) {
            throw new AuthFailure("PHONE_INVALID", 400);
          }
          return await authService.sendSms({
            phone: request.body.phone,
            ipAddress: request.ip,
            requestId: requestId(request),
          });
        } catch (error) {
          return sendFailure(reply, error);
        }
      },
    );

    app.post(
      "/api/community/v1/auth/sms/verify",
      requestErrorHandler("VERIFICATION_CODE_INVALID_OR_EXPIRED"),
      async (request, reply) => {
        try {
          if (
            !isObject(request.body) ||
            !exactKeys(
              request.body,
              ["challengeId", "verificationCode"],
              ["inviteCode"],
            ) ||
            typeof request.body.challengeId !== "string" ||
            typeof request.body.verificationCode !== "string" ||
            ("inviteCode" in request.body &&
              typeof request.body.inviteCode !== "string")
          ) {
            throw new AuthFailure(
              "VERIFICATION_CODE_INVALID_OR_EXPIRED",
              400,
            );
          }
          return await authService.verifySms({
            challengeId: request.body.challengeId,
            verificationCode: request.body.verificationCode,
            ipAddress: request.ip,
            requestId: requestId(request),
            ...(typeof request.body.inviteCode === "string"
              ? { inviteCode: request.body.inviteCode }
              : {}),
          });
        } catch (error) {
          return sendFailure(reply, error);
        }
      },
    );
  }

  app.post(
    "/api/community/v1/auth/refresh",
    requestErrorHandler("INVALID_REQUEST"),
    async (request, reply) => {
      try {
        if (
          !isObject(request.body) ||
          !exactKeys(request.body, [
            "refreshToken",
            "refreshRequestId",
          ]) ||
          typeof request.body.refreshToken !== "string" ||
          typeof request.body.refreshRequestId !== "string"
        ) {
          throw new AuthFailure("INVALID_REQUEST", 400);
        }
        return await authService.refresh({
          refreshToken: request.body.refreshToken,
          refreshRequestId: request.body.refreshRequestId,
          ipAddress: request.ip,
          requestId: requestId(request),
        });
      } catch (error) {
        return sendFailure(reply, error);
      }
    },
  );

  app.post("/api/community/v1/auth/logout", async (request, reply) => {
    try {
      await authService.logout({
        accessToken: bearerToken(request),
        ipAddress: request.ip,
        requestId: requestId(request),
      });
      return reply.code(204).send();
    } catch (error) {
      return sendFailure(reply, error);
    }
  });

  app.get("/api/community/v1/auth/account-context", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const identity = await authService.authenticateAccessToken(bearerToken(request));
      // This endpoint never accepts another account's identifier from a client.
      if (!isObject(request.query) || Object.keys(request.query).length !== 0) {
        throw new AuthFailure("INVALID_REQUEST", 400);
      }
      if (!isInternalId(identity.accountId)) throw new AuthFailure("SERVICE_UNAVAILABLE", 503);
      return { accountId: identity.accountId };
    } catch (error) {
      return sendFailure(reply, error);
    }
  });

  app.get("/api/community/v1/auth/me", async (request, reply) => {
    try {
      const identity = await authService.authenticateAccessToken(
        bearerToken(request),
      );
      return identity.account;
    } catch (error) {
      return sendFailure(reply, error);
    }
  });
}
