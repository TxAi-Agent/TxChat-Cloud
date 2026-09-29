import {
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
  KeyObject,
} from "node:crypto";
import { isProxy } from "node:util/types";

import { parseStrictJson } from "./strictJson.js";
import {
  isWeChatPartnerMerchantId,
  isWeChatPartnerNotifyUrl,
} from "./wechatPartnerContract.js";

export type WeChatNativeOrder = {
  codeUrl: string;
  expiresAt: string;
};

export interface WeChatPartnerIdentity {
  readonly spMerchantId: string;
  readonly spAppId: string;
  readonly subMerchantId: string;
}

export interface VerifiedWeChatTransactionCore extends WeChatPartnerIdentity {
  readonly outTradeNo: string;
  readonly transactionId: string;
  readonly tradeState: string;
  readonly amountFen: number;
  readonly currency: string;
  readonly successAt: string;
}

export type VerifiedWeChatTransaction =
  VerifiedWeChatTransactionCore &
    (
      | Readonly<{
          source: "notification";
          notificationId: string;
        }>
      | Readonly<{
          source: "query";
          notificationId?: never;
        }>
    );

export type VerifiedWeChatQueryTransaction = Extract<
  VerifiedWeChatTransaction,
  { source: "query" }
>;

export type VerifiedWeChatNotificationTransaction = Extract<
  VerifiedWeChatTransaction,
  { source: "notification" }
>;

export type WeChatOrderQueryResult =
  | Readonly<{
      kind: "success";
      transaction: VerifiedWeChatQueryTransaction;
    }>
  | Readonly<{
      kind: "pending";
      outTradeNo: string;
      tradeState: "NOTPAY" | "USERPAYING";
    }>
  | Readonly<{
      kind: "exception";
      outTradeNo: string;
      tradeState: "CLOSED" | "REVOKED" | "PAYERROR" | "REFUND";
    }>;

export interface WeChatPaymentProvider {
  createNativeOrder(input: {
    outTradeNo: string;
    description: string;
    amountFen: number;
    expiresAt: string;
  }): Promise<WeChatNativeOrder>;
  verifyNotification(input: {
    headers: Record<string, string | undefined>;
    body: string;
  }): VerifiedWeChatNotificationTransaction;
  queryByOutTradeNo(
    outTradeNo: string,
  ): Promise<WeChatOrderQueryResult>;
  closeOrder(outTradeNo: string): Promise<void>;
}

export type WeChatHttpRequest = Readonly<{
  method: "GET" | "POST";
  url: string;
  headers: Readonly<Record<string, string>>;
  body: string;
  timeoutMs: 10_000;
  maxResponseBodyBytes: 65_536;
  redirect: "error";
}>;

export type WeChatHttpResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string | undefined>>;
  body: string;
}>;

export interface WeChatHttpTransport {
  request(input: WeChatHttpRequest): Promise<WeChatHttpResponse>;
}

type PaymentErrorCode =
  | "BODY_TOO_LARGE"
  | "CONFIGURATION_INVALID"
  | "HTTP_STATUS_INVALID"
  | "INPUT_INVALID"
  | "NOTIFICATION_DECRYPTION_FAILED"
  | "NOTIFICATION_INVALID"
  | "PLATFORM_KEY_ID_INVALID"
  | "REQUEST_FAILED"
  | "RESPONSE_INVALID"
  | "RESPONSE_SIGNATURE_INVALID"
  | "TIMESTAMP_INVALID"
  | "TRANSACTION_INVALID";

export class WeChatPaymentError extends Error {
  readonly code: PaymentErrorCode;

  constructor(code: PaymentErrorCode) {
    super(`WeChat payment failure: ${code}`);
    this.name = "WeChatPaymentError";
    this.code = code;
  }
}

type KeyMaterial = string | Buffer | KeyObject;

export type ProductionWeChatPartnerNativePaymentProviderOptions =
  WeChatPartnerIdentity &
    Readonly<{
      apiOrigin: string;
      spCertificateSerial: string;
      wechatPublicKeyId: string;
      notifyUrl: string;
      spPrivateKey: KeyMaterial;
      apiV3Key: string | Buffer;
      wechatPublicKey: KeyMaterial;
      transport?: WeChatHttpTransport;
      now?: () => number;
      nonce?: () => string;
    }>;

const REQUEST_TIMEOUT_MS = 10_000 as const;
const MAX_BODY_BYTES = 65_536 as const;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_CODE_URL_LENGTH = 2_048;
const MAX_NOTIFICATION_SUMMARY_LENGTH = 64;
const MAX_ASSOCIATED_DATA_LENGTH = 16;
const MAX_AMOUNT_FEN = 100_000_000;
const MAX_TIMESTAMP_SKEW_SECONDS = 300;
const SAFE_IDENTIFIER = /^[A-Za-z0-9_-]+$/u;
const SAFE_OUT_TRADE_NO = /^[A-Za-z0-9_|*-]{6,32}$/u;
const OFFICIAL_PLATFORM_PUBLIC_KEY_ID = /^PUB_KEY_ID_[0-9]+$/u;
const PENDING_TRADE_STATES = new Set(["NOTPAY", "USERPAYING"] as const);
const EXCEPTION_TRADE_STATES = new Set([
  "CLOSED",
  "REVOKED",
  "PAYERROR",
  "REFUND",
] as const);

function paymentError(code: PaymentErrorCode): WeChatPaymentError {
  return new WeChatPaymentError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !isProxy(value) &&
    !Array.isArray(value)
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function dataProperty(
  value: Record<string, unknown>,
  key: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined
  ) {
    throw paymentError("RESPONSE_INVALID");
  }
  return descriptor.value;
}

function snapshotPublicInput(
  value: unknown,
  required: readonly string[],
  code: "INPUT_INVALID" | "NOTIFICATION_INVALID",
): Readonly<Record<string, unknown>> {
  try {
    if (!isPlainRecord(value)) {
      throw paymentError(code);
    }
    const allowed = new Set(required);
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || !allowed.has(key)) {
        throw paymentError(code);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw paymentError(code);
      }
      result[key] = descriptor.value;
    }
    if (!required.every((key) => Object.hasOwn(result, key))) {
      throw paymentError(code);
    }
    return Object.freeze(result);
  } catch {
    throw paymentError(code);
  }
}

function snapshotNotificationHeaders(
  value: unknown,
): Readonly<Record<string, string | undefined>> {
  try {
    if (!isPlainRecord(value)) {
      throw paymentError("NOTIFICATION_INVALID");
    }
    const result: Record<string, string | undefined> = Object.create(null) as
      Record<string, string | undefined>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw paymentError("NOTIFICATION_INVALID");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw paymentError("NOTIFICATION_INVALID");
      }
      const entry = descriptor.value;
      if (typeof entry !== "string" && entry !== undefined) {
        throw paymentError("NOTIFICATION_INVALID");
      }
      result[key] = entry;
    }
    return Object.freeze(result);
  } catch {
    throw paymentError("NOTIFICATION_INVALID");
  }
}

function snapshotResponseHeaders(
  value: unknown,
): Readonly<Record<string, string | undefined>> {
  if (!isPlainRecord(value)) {
    throw paymentError("RESPONSE_INVALID");
  }
  const result: Record<string, string | undefined> = Object.create(null) as
    Record<string, string | undefined>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw paymentError("RESPONSE_INVALID");
    }
    const entry = dataProperty(value, key);
    if (typeof entry !== "string" && entry !== undefined) {
      throw paymentError("RESPONSE_INVALID");
    }
    result[key] = entry;
  }
  return Object.freeze(result);
}

function snapshotHttpResponse(value: unknown): WeChatHttpResponse {
  try {
    if (!isPlainRecord(value)) {
      throw paymentError("RESPONSE_INVALID");
    }
    const status = dataProperty(value, "status");
    const headers = snapshotResponseHeaders(dataProperty(value, "headers"));
    const body = dataProperty(value, "body");
    if (
      typeof status !== "number" ||
      !Number.isInteger(status) ||
      status < 100 ||
      status > 599 ||
      typeof body !== "string"
    ) {
      throw paymentError("RESPONSE_INVALID");
    }
    if (utf8Bytes(body) > MAX_BODY_BYTES) {
      throw paymentError("BODY_TOO_LARGE");
    }
    return Object.freeze({ status, headers, body });
  } catch (error) {
    if (
      error instanceof WeChatPaymentError &&
      error.code === "BODY_TOO_LARGE"
    ) {
      throw error;
    }
    throw paymentError("RESPONSE_INVALID");
  }
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function validBoundedString(
  value: unknown,
  maximum = MAX_IDENTIFIER_LENGTH,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    utf8Bytes(value) <= maximum &&
    !/[\u0000-\u001f\u007f\r\n]/u.test(value)
  );
}

function validCodeUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.isWellFormed() &&
    utf8Bytes(value) >= 10 &&
    utf8Bytes(value) <= MAX_CODE_URL_LENGTH &&
    value.startsWith("weixin://") &&
    !/[\u0000-\u0020\u007f]/u.test(value)
  );
}

function validIdentifier(value: unknown): value is string {
  return (
    validBoundedString(value) &&
    SAFE_IDENTIFIER.test(value)
  );
}

function validOutTradeNo(value: unknown): value is string {
  return typeof value === "string" && SAFE_OUT_TRADE_NO.test(value);
}

function validDescription(value: unknown): value is string {
  if (typeof value !== "string" || /\p{Cc}/u.test(value)) {
    return false;
  }
  const codePoints = Array.from(value).length;
  return codePoints >= 1 && codePoints <= 127;
}

function validFen(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_AMOUNT_FEN
  );
}

function validDiscountedFen(value: unknown, total: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= total
  );
}

function validPlatformPublicKeyId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    OFFICIAL_PLATFORM_PUBLIC_KEY_ID.test(value)
  );
}

function validRfc3339(
  value: unknown,
  allowZulu: boolean,
): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|([+-])(\d{2}):(\d{2}))$/u.exec(
    value,
  );
  if (match === null || (!allowZulu && match[7] === "Z")) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 14 ||
    offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0)
  ) {
    return false;
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth && Number.isFinite(Date.parse(value));
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function validateNotifyUrl(value: string): string {
  if (!isWeChatPartnerNotifyUrl(value)) {
    throw paymentError("CONFIGURATION_INVALID");
  }
  return value;
}

function parsePrivateKey(material: KeyMaterial): KeyObject {
  try {
    if (isProxy(material)) {
      throw new Error("invalid key");
    }
    const key = material instanceof KeyObject
      ? material
      : createPrivateKey(material);
    if (
      key.type !== "private" ||
      key.asymmetricKeyType !== "rsa" ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2_048
    ) {
      throw new Error("invalid key");
    }
    return key;
  } catch {
    throw paymentError("CONFIGURATION_INVALID");
  }
}

function parsePublicKey(material: KeyMaterial): KeyObject {
  try {
    if (isProxy(material)) {
      throw new Error("invalid key");
    }
    const key = material instanceof KeyObject
      ? material
      : createPublicKey(material);
    if (
      key.type !== "public" ||
      key.asymmetricKeyType !== "rsa" ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2_048
    ) {
      throw new Error("invalid key");
    }
    return key;
  } catch {
    throw paymentError("CONFIGURATION_INVALID");
  }
}

function parseApiV3Key(material: string | Buffer): Buffer {
  if (isProxy(material)) {
    throw paymentError("CONFIGURATION_INVALID");
  }
  const key = Buffer.isBuffer(material)
    ? Buffer.from(material)
    : Buffer.from(material, "utf8");
  if (key.length !== 32) {
    key.fill(0);
    throw paymentError("CONFIGURATION_INVALID");
  }
  return key;
}

function safeJsonParse(body: string, code: PaymentErrorCode): unknown {
  try {
    return parseStrictJson(body);
  } catch {
    throw paymentError(code);
  }
}

function header(
  headers: Readonly<Record<string, string | undefined>>,
  target: string,
): string | undefined {
  const normalizedTarget = target.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === normalizedTarget) {
      return value;
    }
  }
  return undefined;
}

function strictBase64(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || value.length % 4 !== 0) {
    return undefined;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : undefined;
}

class FetchWeChatHttpTransport implements WeChatHttpTransport {
  async request(input: WeChatHttpRequest): Promise<WeChatHttpResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const response = await fetch(input.url, {
        method: input.method,
        headers: input.headers,
        ...(input.body === "" ? {} : { body: input.body }),
        redirect: input.redirect,
        signal: controller.signal,
      });
      if (response.body === null) {
        return {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: "",
        };
      }
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        const item = await reader.read();
        if (item.done) {
          break;
        }
        total += item.value.byteLength;
        if (total > input.maxResponseBodyBytes) {
          await reader.cancel();
          throw paymentError("BODY_TOO_LARGE");
        }
        chunks.push(Buffer.from(item.value));
      }
      let body: string;
      try {
        body = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(chunks, total),
        );
      } catch {
        throw paymentError("RESPONSE_INVALID");
      }
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function validateTransactionAmount(value: unknown): Readonly<{
  amountFen: number;
  currency: string;
}> {
  if (
    !isRecord(value) ||
    !validFen(value.total) ||
    typeof value.currency !== "string" ||
    !/^[A-Z]{3}$/u.test(value.currency)
  ) {
    throw paymentError("TRANSACTION_INVALID");
  }
  if (
    (value.payer_total !== undefined &&
      !validDiscountedFen(value.payer_total, value.total)) ||
    (value.payer_currency !== undefined &&
      value.payer_currency !== value.currency)
  ) {
    throw paymentError("TRANSACTION_INVALID");
  }
  return Object.freeze({ amountFen: value.total, currency: value.currency });
}

function validatePendingTransactionAmount(value: unknown): void {
  if (!isRecord(value)) {
    throw paymentError("TRANSACTION_INVALID");
  }
  const total = value.total;
  const payerTotal = value.payer_total;
  if (
    (total !== undefined && !validFen(total)) ||
    (payerTotal !== undefined &&
      (typeof payerTotal !== "number" ||
        !Number.isSafeInteger(payerTotal) ||
        payerTotal < 0 ||
        payerTotal > MAX_AMOUNT_FEN ||
        (typeof total === "number" && payerTotal > total))) ||
    (value.currency !== undefined && value.currency !== "CNY") ||
    (value.payer_currency !== undefined && value.payer_currency !== "CNY")
  ) {
    throw paymentError("TRANSACTION_INVALID");
  }
}

function normalizePartnerIdentity(
  value: Record<string, unknown>,
  expected: WeChatPartnerIdentity,
): WeChatPartnerIdentity {
  try {
    const spMerchantDescriptor = Object.getOwnPropertyDescriptor(
      value,
      "sp_mchid",
    );
    const spAppDescriptor = Object.getOwnPropertyDescriptor(value, "sp_appid");
    const subMerchantDescriptor = Object.getOwnPropertyDescriptor(
      value,
      "sub_mchid",
    );
    const subAppDescriptor = Object.getOwnPropertyDescriptor(value, "sub_appid");
    if (
      spMerchantDescriptor === undefined ||
      !("value" in spMerchantDescriptor) ||
      spAppDescriptor === undefined ||
      !("value" in spAppDescriptor) ||
      subMerchantDescriptor === undefined ||
      !("value" in subMerchantDescriptor) ||
      !validIdentifier(spMerchantDescriptor.value) ||
      !validIdentifier(spAppDescriptor.value) ||
      !validIdentifier(subMerchantDescriptor.value) ||
      spMerchantDescriptor.value !== expected.spMerchantId ||
      spAppDescriptor.value !== expected.spAppId ||
      subMerchantDescriptor.value !== expected.subMerchantId ||
      (subAppDescriptor !== undefined &&
        (!("value" in subAppDescriptor) ||
          !validIdentifier(subAppDescriptor.value)))
    ) {
      throw paymentError("TRANSACTION_INVALID");
    }
    return Object.freeze({
      spMerchantId: spMerchantDescriptor.value,
      spAppId: spAppDescriptor.value,
      subMerchantId: subMerchantDescriptor.value,
    });
  } catch {
    throw paymentError("TRANSACTION_INVALID");
  }
}

function normalizeTransactionCore(
  value: unknown,
  expected: WeChatPartnerIdentity,
): VerifiedWeChatTransactionCore {
  if (!isRecord(value) || !isRecord(value.amount)) {
    throw paymentError("TRANSACTION_INVALID");
  }
  if (
    !validIdentifier(value.trade_state) ||
    !validOutTradeNo(value.out_trade_no) ||
    !validIdentifier(value.transaction_id) ||
    !validRfc3339(value.success_time, true)
  ) {
    throw paymentError("TRANSACTION_INVALID");
  }
  const identity = normalizePartnerIdentity(value, expected);
  const amount = validateTransactionAmount(value.amount);
  return Object.freeze({
    ...identity,
    outTradeNo: value.out_trade_no,
    transactionId: value.transaction_id,
    tradeState: value.trade_state,
    amountFen: amount.amountFen,
    currency: amount.currency,
    successAt: new Date(value.success_time).toISOString(),
  });
}

function normalizeNotificationTransaction(
  value: unknown,
  expected: WeChatPartnerIdentity & Readonly<{ notificationId: string }>,
): VerifiedWeChatNotificationTransaction {
  if (
    !isRecord(value) ||
    value.trade_type !== "NATIVE" ||
    !validRfc3339(value.success_time, true)
  ) {
    throw paymentError("TRANSACTION_INVALID");
  }
  return Object.freeze({
    ...normalizeTransactionCore(value, expected),
    source: "notification" as const,
    notificationId: expected.notificationId,
  });
}

function normalizeQueryTransaction(
  value: unknown,
  expected: WeChatPartnerIdentity & Readonly<{ outTradeNo: string }>,
): VerifiedWeChatQueryTransaction {
  if (
    !isRecord(value) ||
    (value.trade_type !== undefined && value.trade_type !== "NATIVE") ||
    !validRfc3339(value.success_time, true) ||
    value.out_trade_no !== expected.outTradeNo
  ) {
    throw paymentError("TRANSACTION_INVALID");
  }
  return Object.freeze({
    ...normalizeTransactionCore(value, expected),
    source: "query" as const,
  });
}

function validatePendingTransaction(
  value: Record<string, unknown>,
  expected: WeChatPartnerIdentity & Readonly<{
    outTradeNo: string;
  }>,
): void {
  if (
    typeof value.trade_state !== "string" ||
    (!PENDING_TRADE_STATES.has(value.trade_state as never) &&
      !EXCEPTION_TRADE_STATES.has(value.trade_state as never)) ||
    value.out_trade_no !== expected.outTradeNo
  ) {
    throw paymentError("TRANSACTION_INVALID");
  }
  normalizePartnerIdentity(value, expected);
  if (value.amount !== undefined) {
    validatePendingTransactionAmount(value.amount);
  }
}

export class ProductionWeChatPartnerNativePaymentProvider
  implements WeChatPaymentProvider
{
  readonly #spMerchantId: string;
  readonly #spAppId: string;
  readonly #subMerchantId: string;
  readonly #spCertificateSerial: string;
  readonly #wechatPublicKeyId: string;
  readonly #notifyUrl: string;
  readonly #apiOrigin: string;
  #spPrivateKey: KeyObject | undefined;
  readonly #apiV3Key: Buffer;
  #wechatPublicKey: KeyObject | undefined;
  readonly #transport: WeChatHttpTransport;
  readonly #now: () => number;
  readonly #nonce: () => string;
  #disposed = false;

  constructor(options: ProductionWeChatPartnerNativePaymentProviderOptions) {
    let internalApiV3Key: Buffer | undefined;
    try {
      if (isProxy(options)) {
        throw paymentError("CONFIGURATION_INVALID");
      }
      const snapshot = {
        apiOrigin: options.apiOrigin,
        spMerchantId: options.spMerchantId,
        spAppId: options.spAppId,
        subMerchantId: options.subMerchantId,
        spCertificateSerial: options.spCertificateSerial,
        wechatPublicKeyId: options.wechatPublicKeyId,
        notifyUrl: options.notifyUrl,
        spPrivateKey: options.spPrivateKey,
        apiV3Key: options.apiV3Key,
        wechatPublicKey: options.wechatPublicKey,
        transport: options.transport,
        now: options.now,
        nonce: options.nonce,
      };
      const transportSource = snapshot.transport;
      const transport = transportSource === undefined
        ? new FetchWeChatHttpTransport()
        : (() => {
            if (isProxy(transportSource)) {
              throw paymentError("CONFIGURATION_INVALID");
            }
            const request = transportSource.request;
            if (typeof request !== "function" || isProxy(request)) {
              throw paymentError("CONFIGURATION_INVALID");
            }
            return Object.freeze({
              request: request.bind(transportSource),
            });
          })();
      if (
        !isWeChatPartnerMerchantId(snapshot.spMerchantId) ||
        !validIdentifier(snapshot.spAppId) ||
        !isWeChatPartnerMerchantId(snapshot.subMerchantId) ||
        !validIdentifier(snapshot.spCertificateSerial) ||
        !validPlatformPublicKeyId(snapshot.wechatPublicKeyId) ||
        (snapshot.now !== undefined &&
          (typeof snapshot.now !== "function" || isProxy(snapshot.now))) ||
        (snapshot.nonce !== undefined &&
          (typeof snapshot.nonce !== "function" || isProxy(snapshot.nonce)))
      ) {
        throw paymentError("CONFIGURATION_INVALID");
      }
      const notifyUrl = validateNotifyUrl(snapshot.notifyUrl);
      if (!isWeChatPartnerNotifyUrl(snapshot.apiOrigin)) throw paymentError("CONFIGURATION_INVALID");
      const apiOrigin = new URL(snapshot.apiOrigin);
      if (apiOrigin.pathname !== "/" || apiOrigin.search !== "") throw paymentError("CONFIGURATION_INVALID");
      this.#apiOrigin = apiOrigin.origin;
      const spPrivateKey = parsePrivateKey(snapshot.spPrivateKey);
      const wechatPublicKey = parsePublicKey(snapshot.wechatPublicKey);

      // Copy the caller-owned API key only after every other fallible option
      // validation and key parse has completed.
      internalApiV3Key = parseApiV3Key(snapshot.apiV3Key);
      this.#spMerchantId = snapshot.spMerchantId;
      this.#spAppId = snapshot.spAppId;
      this.#subMerchantId = snapshot.subMerchantId;
      this.#spCertificateSerial = snapshot.spCertificateSerial;
      this.#wechatPublicKeyId = snapshot.wechatPublicKeyId;
      this.#notifyUrl = notifyUrl;
      this.#spPrivateKey = spPrivateKey;
      this.#wechatPublicKey = wechatPublicKey;
      this.#apiV3Key = internalApiV3Key;
      this.#transport = transport;
      this.#now = snapshot.now ?? Date.now;
      this.#nonce = snapshot.nonce ?? (() => randomBytes(16).toString("hex"));
    } catch (error) {
      internalApiV3Key?.fill(0);
      if (error instanceof WeChatPaymentError) {
        throw error;
      }
      throw paymentError("CONFIGURATION_INVALID");
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#apiV3Key.fill(0);
    this.#spPrivateKey = undefined;
    this.#wechatPublicKey = undefined;
  }

  async createNativeOrder(input: {
    outTradeNo: string;
    description: string;
    amountFen: number;
    expiresAt: string;
  }): Promise<WeChatNativeOrder> {
    this.#assertAvailable();
    const snapshot = snapshotPublicInput(
      input,
      ["outTradeNo", "description", "amountFen", "expiresAt"],
      "INPUT_INVALID",
    );
    if (
      !validOutTradeNo(snapshot.outTradeNo) ||
      !validDescription(snapshot.description) ||
      !validFen(snapshot.amountFen) ||
      !validRfc3339(snapshot.expiresAt, false) ||
      !snapshot.expiresAt.endsWith("+08:00")
    ) {
      throw paymentError("INPUT_INVALID");
    }
    const body = JSON.stringify({
      sp_appid: this.#spAppId,
      sp_mchid: this.#spMerchantId,
      sub_mchid: this.#subMerchantId,
      out_trade_no: snapshot.outTradeNo,
      description: snapshot.description,
      notify_url: this.#notifyUrl,
      amount: { total: snapshot.amountFen, currency: "CNY" },
      time_expire: snapshot.expiresAt,
    });
    const response = await this.#request(
      "POST",
      "/v3/pay/partner/transactions/native",
      body,
    );
    const parsed = safeJsonParse(response.body, "RESPONSE_INVALID");
    if (
      !isRecord(parsed) ||
      !validCodeUrl(parsed.code_url)
    ) {
      throw paymentError("RESPONSE_INVALID");
    }
    return Object.freeze({
      codeUrl: parsed.code_url,
      expiresAt: snapshot.expiresAt,
    });
  }

  verifyNotification(input: {
    headers: Record<string, string | undefined>;
    body: string;
  }): VerifiedWeChatNotificationTransaction {
    this.#assertAvailable();
    const snapshot = snapshotPublicInput(
      input,
      ["headers", "body"],
      "NOTIFICATION_INVALID",
    );
    const headers = snapshotNotificationHeaders(snapshot.headers);
    if (typeof snapshot.body !== "string") {
      throw paymentError("NOTIFICATION_INVALID");
    }
    if (utf8Bytes(snapshot.body) > MAX_BODY_BYTES) {
      throw paymentError("BODY_TOO_LARGE");
    }
    this.#verifySignature(headers, snapshot.body);
    const envelope = safeJsonParse(snapshot.body, "NOTIFICATION_INVALID");
    if (
      !isRecord(envelope) ||
      !hasExactKeys(envelope, [
        "id",
        "create_time",
        "event_type",
        "resource_type",
        "resource",
        "summary",
      ]) ||
      !validIdentifier(envelope.id) ||
      !validRfc3339(envelope.create_time, true) ||
      !validBoundedString(
        envelope.summary,
        MAX_NOTIFICATION_SUMMARY_LENGTH,
      ) ||
      envelope.event_type !== "TRANSACTION.SUCCESS" ||
      envelope.resource_type !== "encrypt-resource" ||
      !isRecord(envelope.resource)
    ) {
      throw paymentError("NOTIFICATION_INVALID");
    }
    const resource = envelope.resource;
    if (
      !hasExactKeys(
        resource,
        ["algorithm", "ciphertext", "nonce", "original_type"],
        ["associated_data"],
      ) ||
      resource.algorithm !== "AEAD_AES_256_GCM" ||
      resource.original_type !== "transaction" ||
      !validBoundedString(resource.nonce) ||
      utf8Bytes(resource.nonce) > 16 ||
      (resource.associated_data !== undefined &&
        (typeof resource.associated_data !== "string" ||
          utf8Bytes(resource.associated_data) >
            MAX_ASSOCIATED_DATA_LENGTH)) ||
      typeof resource.ciphertext !== "string" ||
      utf8Bytes(resource.ciphertext) > MAX_BODY_BYTES
    ) {
      throw paymentError("NOTIFICATION_INVALID");
    }
    const encrypted = strictBase64(resource.ciphertext);
    if (encrypted === undefined || encrypted.length <= 16) {
      throw paymentError("NOTIFICATION_INVALID");
    }
    const plaintext = this.#decryptNotificationResource(
      encrypted,
      resource.nonce,
      resource.associated_data ?? "",
    );
    const transaction = safeJsonParse(
      plaintext,
      "NOTIFICATION_DECRYPTION_FAILED",
    );
    return normalizeNotificationTransaction(transaction, {
      spMerchantId: this.#spMerchantId,
      spAppId: this.#spAppId,
      subMerchantId: this.#subMerchantId,
      notificationId: envelope.id,
    });
  }

  async queryByOutTradeNo(
    outTradeNo: string,
  ): Promise<WeChatOrderQueryResult> {
    this.#assertAvailable();
    if (!validOutTradeNo(outTradeNo)) {
      throw paymentError("INPUT_INVALID");
    }
    const path =
      `/v3/pay/partner/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}` +
      `?sp_mchid=${encodeURIComponent(this.#spMerchantId)}` +
      `&sub_mchid=${encodeURIComponent(this.#subMerchantId)}`;
    const response = await this.#request("GET", path, "");
    const parsed = safeJsonParse(response.body, "RESPONSE_INVALID");
    if (!isRecord(parsed)) {
      throw paymentError("RESPONSE_INVALID");
    }
    if (parsed.trade_state !== "SUCCESS") {
      validatePendingTransaction(parsed, {
        spMerchantId: this.#spMerchantId,
        spAppId: this.#spAppId,
        subMerchantId: this.#subMerchantId,
        outTradeNo,
      });
      const tradeState = parsed.trade_state;
      if (
        tradeState === "NOTPAY" ||
        tradeState === "USERPAYING"
      ) {
        return Object.freeze({
          kind: "pending" as const,
          outTradeNo,
          tradeState,
        });
      }
      return Object.freeze({
        kind: "exception" as const,
        outTradeNo,
        tradeState: tradeState as
          | "CLOSED"
          | "REVOKED"
          | "PAYERROR"
          | "REFUND",
      });
    }
    return Object.freeze({
      kind: "success" as const,
      transaction: normalizeQueryTransaction(parsed, {
        spMerchantId: this.#spMerchantId,
        spAppId: this.#spAppId,
        subMerchantId: this.#subMerchantId,
        outTradeNo,
      }),
    });
  }

  async closeOrder(outTradeNo: string): Promise<void> {
    this.#assertAvailable();
    if (!validOutTradeNo(outTradeNo)) {
      throw paymentError("INPUT_INVALID");
    }
    const path =
      `/v3/pay/partner/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}/close`;
    const body = JSON.stringify({
      sp_mchid: this.#spMerchantId,
      sub_mchid: this.#subMerchantId,
    });
    await this.#request("POST", path, body);
  }

  async #request(
    method: "GET" | "POST",
    canonicalPathAndQuery: string,
    body: string,
  ): Promise<WeChatHttpResponse> {
    this.#assertAvailable();
    const spPrivateKey = this.#spPrivateKey;
    if (spPrivateKey === undefined) {
      throw paymentError("CONFIGURATION_INVALID");
    }
    if (
      !canonicalPathAndQuery.startsWith("/v3/") ||
      /[\r\n]/u.test(canonicalPathAndQuery) ||
      utf8Bytes(body) > MAX_BODY_BYTES
    ) {
      throw paymentError("INPUT_INVALID");
    }
    const timestamp = Math.floor(this.#now() / 1_000);
    const nonce = this.#nonce();
    if (!Number.isSafeInteger(timestamp) || !validIdentifier(nonce)) {
      throw paymentError("CONFIGURATION_INVALID");
    }
    const canonical = Buffer.from(
      `${method}\n${canonicalPathAndQuery}\n${timestamp}\n${nonce}\n${body}\n`,
    );
    let requestSignatureBuffer: Buffer | undefined;
    let requestSignature: string;
    try {
      requestSignatureBuffer = sign(
        "RSA-SHA256",
        canonical,
        spPrivateKey,
      );
      requestSignature = requestSignatureBuffer.toString("base64");
    } catch {
      throw paymentError("REQUEST_FAILED");
    } finally {
      requestSignatureBuffer?.fill(0);
      canonical.fill(0);
    }
    const authorization =
      "WECHATPAY2-SHA256-RSA2048 " +
      `mchid="${this.#spMerchantId}",` +
      `nonce_str="${nonce}",` +
      `signature="${requestSignature}",` +
      `timestamp="${timestamp}",` +
      `serial_no="${this.#spCertificateSerial}"`;
    let rawResponse: unknown;
    try {
      rawResponse = await this.#transport.request(Object.freeze({
        method,
        url: `${this.#apiOrigin}${canonicalPathAndQuery}`,
        headers: Object.freeze({
          Accept: "application/json",
          Authorization: authorization,
          "Wechatpay-Serial": this.#wechatPublicKeyId,
          ...(body === "" ? {} : { "Content-Type": "application/json" }),
        }),
        body,
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxResponseBodyBytes: MAX_BODY_BYTES,
        redirect: "error" as const,
      }));
    } catch (error) {
      if (error instanceof WeChatPaymentError) {
        throw error;
      }
      throw paymentError("REQUEST_FAILED");
    }
    const response = snapshotHttpResponse(rawResponse);
    this.#verifySignature(response.headers, response.body);
    if (response.status < 200 || response.status >= 300) {
      throw paymentError("HTTP_STATUS_INVALID");
    }
    return response;
  }

  #assertAvailable(): void {
    if (
      this.#disposed ||
      this.#spPrivateKey === undefined ||
      this.#wechatPublicKey === undefined
    ) {
      throw paymentError("CONFIGURATION_INVALID");
    }
  }

  #verifySignature(
    headers: Readonly<Record<string, string | undefined>>,
    body: string,
  ): void {
    this.#assertAvailable();
    const wechatPublicKey = this.#wechatPublicKey;
    if (wechatPublicKey === undefined) {
      throw paymentError("CONFIGURATION_INVALID");
    }
    const keyId = header(headers, "Wechatpay-Serial");
    if (keyId !== this.#wechatPublicKeyId) {
      throw paymentError("PLATFORM_KEY_ID_INVALID");
    }
    const timestampSource = header(headers, "Wechatpay-Timestamp");
    const nonce = header(headers, "Wechatpay-Nonce");
    const signatureSource = header(headers, "Wechatpay-Signature");
    if (
      timestampSource === undefined ||
      !/^\d{1,12}$/u.test(timestampSource) ||
      !validIdentifier(nonce) ||
      typeof signatureSource !== "string" ||
      signatureSource.length > MAX_CODE_URL_LENGTH
    ) {
      throw paymentError("RESPONSE_SIGNATURE_INVALID");
    }
    const timestamp = Number(timestampSource);
    const nowSeconds = Math.floor(this.#now() / 1_000);
    if (
      !Number.isSafeInteger(timestamp) ||
      !Number.isSafeInteger(nowSeconds) ||
      Math.abs(nowSeconds - timestamp) > MAX_TIMESTAMP_SKEW_SECONDS
    ) {
      throw paymentError("TIMESTAMP_INVALID");
    }
    const signature = strictBase64(signatureSource);
    if (signature === undefined) {
      throw paymentError("RESPONSE_SIGNATURE_INVALID");
    }
    const verificationCanonical = Buffer.from(
      `${timestampSource}\n${nonce}\n${body}\n`,
    );
    let accepted = false;
    try {
      accepted = verify(
        "RSA-SHA256",
        verificationCanonical,
        wechatPublicKey,
        signature,
      );
    } catch {
      accepted = false;
    } finally {
      verificationCanonical.fill(0);
      signature.fill(0);
    }
    if (!accepted) {
      throw paymentError("RESPONSE_SIGNATURE_INVALID");
    }
  }

  #decryptNotificationResource(
    encrypted: Buffer,
    nonce: string,
    associatedData: string,
  ): string {
    const ciphertext = encrypted.subarray(0, encrypted.length - 16);
    const authenticationTag = encrypted.subarray(encrypted.length - 16);
    let aad: Buffer | undefined;
    let updated: Buffer | undefined;
    let finalChunk: Buffer | undefined;
    let plaintext: Buffer | undefined;
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.#apiV3Key,
        nonce,
      );
      aad = Buffer.from(associatedData);
      decipher.setAAD(aad);
      decipher.setAuthTag(authenticationTag);
      updated = decipher.update(ciphertext);
      finalChunk = decipher.final();
      plaintext = Buffer.concat([updated, finalChunk]);
      if (plaintext.length === 0 || plaintext.length > MAX_BODY_BYTES) {
        throw new Error("invalid plaintext size");
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    } catch {
      throw paymentError("NOTIFICATION_DECRYPTION_FAILED");
    } finally {
      aad?.fill(0);
      updated?.fill(0);
      finalChunk?.fill(0);
      plaintext?.fill(0);
      encrypted.fill(0);
    }
  }
}
