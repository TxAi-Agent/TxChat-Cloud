import { ProviderError } from "../providers/providerTypes.js";

export const REDACTED_VALUE = "[REDACTED]" as const;

function normalizedKey(key: string): string {
  return key
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]/gu, "");
}

const forbiddenKeys = new Set(
  [
    "authorization",
    "apiKey",
    "accessKeyId",
    "accessKeySecret",
    "privateKey",
    "apiV3Key",
    "wechatPublicKey",
    "merchantPrivateKey",
    "platformPublicKey",
    "wechatPrivateKey",
    "wechatPlatformPublicKey",
    "merchantCertificateSerial",
    "platformPublicKeyId",
    "ciphertext",
    "associatedData",
    "notificationBody",
    "wechatpaySignature",
    "WECHAT_PAY_SP_PRIVATE_KEY_FILE",
    "WECHAT_PAY_API_V3_KEY_FILE",
    "WECHAT_PAY_WECHAT_PUBLIC_KEY_FILE",
    "WECHAT_PAY_PRIVATE_KEY_FILE",
    "WECHAT_PAY_PLATFORM_PUBLIC_KEY_FILE",
    "WECHAT_PAY_MERCHANT_ID",
    "WECHAT_PAY_APP_ID",
    "WECHAT_PAY_MERCHANT_CERT_SERIAL",
    "WECHAT_PAY_PLATFORM_PUBLIC_KEY_ID",
    "WECHAT_PAY_SP_MERCHANT_ID",
    "WECHAT_PAY_SP_APP_ID",
    "WECHAT_PAY_SUB_MERCHANT_ID",
    "WECHAT_PAY_SP_CERT_SERIAL",
    "WECHAT_PAY_WECHAT_PUBLIC_KEY_ID",
    "spPrivateKey",
    "spMerchantId",
    "spAppId",
    "subMerchantId",
    "spCertificateSerial",
    "wechatPublicKeyId",
    "sp_mchid",
    "sp_appid",
    "sub_mchid",
    "notificationPlaintext",
    "headers",
    "body",
    "rawCallbackBody",
    "callbackHeaders",
    "codeUrl",
    "wechatCodeUrl",
    "qrCode",
    "outTradeNo",
    "transactionId",
    "notificationId",
    "payer",
    "payerOpenId",
    "merchantId",
    "appId",
    "wechatpayTimestamp",
    "wechatpayNonce",
    "wechatpaySerial",
    "timestamp",
    "nonce",
    "serial",
    "refundId",
    "wechatRefundId",
    "refundNote",
    "operatorNote",
    "notificationResource",
    "resource",
    "plaintext",
    "password",
    "inviteCode",
    "accessToken",
    "refreshToken",
    "phone",
    "phoneNumber",
    "verificationCode",
    "smsCode",
    "challengeCode",
    "audio",
    "rawTranscript",
    "finalText",
    "requestBody",
    "responseBody",
    "credential",
    "bootstrapToken",
    "bootstrapProof",
    "challengeId",
    "templateParam",
    "setupToken",
    "x-community-admin-challenge",
    "csrfToken",
    "endpoint",
    "cookie",
    "setCookie",
    "adminCookie",
    "adminSessionCookie",
    "adminSession",
    "sessionCookie",
    "set-cookie",
    "txchat_admin_session",
    "x-txchat-admin-csrf",
    "community_admin_session",
    "x-community-admin-bootstrap",
    "x-community-admin-bootstrap-proof",
    "x-community-admin-challenge-id",
    "x-community-admin-csrf",
    "x-txchat-sms-admin-setup",
    "x-txchat-sms-admin-csrf",
    "txchat_sms_admin_session",
  ].map(normalizedKey),
);

const allowedLogKeys = new Set(
  [
    "requestId",
    "accountId",
    "clientVersion",
    "contractVersion",
    "durationMs",
    "bytes",
    "modelId",
    "timings",
    "characterCount",
    "tokenUsage",
    "status",
    "stage",
    "code",
    "mockMode",
    "cleanupResult",
    "err",
    "error",
    "migrations",
    "temporaryAudioCleanup",
    "retentionCleanup",
    "databases",
    "consecutiveProviderFailures",
    "contentRetentionCleanup",
    "authenticationRetentionCleanup",
  ].map(normalizedKey),
);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function redact(
  value: unknown,
  seen: WeakSet<object>,
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return REDACTED_VALUE;
    }
    seen.add(value);
    return value.map((entry) => redact(entry, seen));
  }
  if (!isPlainObject(value)) {
    return REDACTED_VALUE;
  }
  if (seen.has(value)) {
    return REDACTED_VALUE;
  }
  seen.add(value);

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      forbiddenKeys.has(normalizedKey(key))
        ? REDACTED_VALUE
        : redact(entry, seen),
    ]),
  );
}

export function redactSensitiveFields(value: unknown): unknown {
  return redact(value, new WeakSet<object>());
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sanitizeNumberMap(
  value: unknown,
  allowedKey: (key: string) => boolean,
): unknown {
  if (!isPlainObject(value)) {
    return REDACTED_VALUE;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      allowedKey(key) && isFiniteNumber(entry)
        ? entry
        : REDACTED_VALUE,
    ]),
  );
}

function sanitizeAllowedValue(key: string, value: unknown): unknown {
  const normalized = normalizedKey(key);
  if (normalized === "err" || normalized === "error") {
    return safeErrorMetadata(value);
  }
  if (normalized === "timings") {
    return sanitizeNumberMap(value, (nestedKey) =>
      normalizedKey(nestedKey).endsWith("ms"),
    );
  }
  if (normalized === "tokenusage") {
    return sanitizeNumberMap(value, (nestedKey) =>
      ["input", "output", "total"].includes(normalizedKey(nestedKey)),
    );
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    isFiniteNumber(value)
  ) {
    return value;
  }
  return REDACTED_VALUE;
}

export function sanitizeLogObject(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        const normalized = normalizedKey(key);
        if (
          forbiddenKeys.has(normalized) ||
          !allowedLogKeys.has(normalized)
        ) {
          return [key, REDACTED_VALUE];
        }
        return [key, sanitizeAllowedValue(key, entry)];
      }),
    ),
  );
}

export type SafeErrorMetadata = Readonly<{
  stage: "asr" | "rewrite" | "internal";
  code: string;
  status?: number | string;
}>;

export function safeErrorMetadata(error: unknown): SafeErrorMetadata {
  if (error instanceof ProviderError) {
    return Object.freeze({
      stage: error.stage,
      code: error.code,
      ...(error.status === undefined ? {} : { status: error.status }),
    });
  }
  return Object.freeze({
    stage: "internal",
    code: "INTERNAL_ERROR",
  });
}
