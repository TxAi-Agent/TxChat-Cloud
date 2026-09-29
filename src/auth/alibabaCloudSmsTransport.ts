import * as CredentialSdk from "@alicloud/credentials";
import { Config as CredentialConfig } from "@alicloud/credentials";
import * as DysmsSdk from "@alicloud/dysmsapi20170525";
import { SendSmsRequest } from "@alicloud/dysmsapi20170525";
import { Config as OpenApiConfig } from "@alicloud/openapi-client";
import { RuntimeOptions } from "@alicloud/tea-util";

import type {
  SmsDeliveryOutcome,
  SmsTransport,
  SmsTransportRequest,
} from "./smsProvider.js";
import {
  type AlibabaSmsConfiguration,
} from "../config.js";


export const ALIBABA_SMS_RUNTIME = Object.freeze({
  autoretry: false,
  maxAttempts: 1,
  connectTimeout: 3_000,
  readTimeout: 10_000,
});

export type AlibabaSendSmsRequest = Readonly<{
  PhoneNumbers: string;
  SignName: string;
  TemplateCode: string;
  TemplateParam: string;
}>;

export type AlibabaSendSmsResponse = Readonly<{
  body?: Readonly<{
    Code?: unknown;
  }>;
}>;

export interface AlibabaSmsClient {
  sendSms(
    request: AlibabaSendSmsRequest,
    runtime: typeof ALIBABA_SMS_RUNTIME,
  ): Promise<unknown>;
}

export type AlibabaSmsClientConfiguration = Readonly<{
  credential: AlibabaSmsConfiguration["credential"];
  endpoint: string;
}>;

export type AlibabaSmsClientFactory = (
  configuration: AlibabaSmsClientConfiguration,
) => AlibabaSmsClient;

type DysmsSdkClient = Readonly<{
  sendSmsWithOptions(
    request: SendSmsRequest,
    runtime: RuntimeOptions,
  ): Promise<Readonly<{
    body?: Readonly<{ code?: string }>;
  }>>;
}>;

type DysmsClientConstructorType = new (
  configuration: OpenApiConfig,
) => DysmsSdkClient;

type CredentialConstructorType = new (
  configuration: CredentialConfig,
) => NonNullable<OpenApiConfig["credential"]>;

const dysmsDefaultExport = DysmsSdk.default as unknown;
const DysmsClientConstructor =
  (typeof dysmsDefaultExport === "function"
    ? dysmsDefaultExport
    : (dysmsDefaultExport as { default: unknown }).default) as
    DysmsClientConstructorType;

const credentialDefaultExport = CredentialSdk.default as unknown;
const CredentialConstructor =
  (typeof credentialDefaultExport === "function"
    ? credentialDefaultExport
    : (credentialDefaultExport as { default: unknown }).default) as
    CredentialConstructorType;

class AlibabaSdkClient implements AlibabaSmsClient {
  readonly #client: DysmsSdkClient;

  constructor(client: DysmsSdkClient) {
    this.#client = client;
  }

  async sendSms(
    request: AlibabaSendSmsRequest,
    runtime: typeof ALIBABA_SMS_RUNTIME,
  ): Promise<AlibabaSendSmsResponse> {
    const response = await this.#client.sendSmsWithOptions(
      new SendSmsRequest({
        phoneNumbers: request.PhoneNumbers,
        signName: request.SignName,
        templateCode: request.TemplateCode,
        templateParam: request.TemplateParam,
      }),
      new RuntimeOptions(runtime),
    );
    return response.body === undefined
      ? {}
      : { body: { Code: response.body.code } };
  }
}

export function createEcsRamRoleCredentialConfig(
  roleName: string,
): CredentialConfig {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(roleName)) {
    throw new Error("Invalid Alibaba SMS ECS RAM role");
  }
  return new CredentialConfig({
    type: "ecs_ram_role",
    roleName,
    disableIMDSv1: true,
  });
}

const createAlibabaSdkClient: AlibabaSmsClientFactory = (
  configuration,
) => {
  const sdkConfiguration =
    configuration.credential.kind === "access-key-file"
      ? new OpenApiConfig({
          accessKeyId: configuration.credential.accessKeyId,
          accessKeySecret: configuration.credential.accessKeySecret,
          endpoint: configuration.endpoint,
        })
      : new OpenApiConfig({
          credential: new CredentialConstructor(
            createEcsRamRoleCredentialConfig(
              configuration.credential.roleName,
            ),
          ),
          endpoint: configuration.endpoint,
        });
  return new AlibabaSdkClient(
    new DysmsClientConstructor(sdkConfiguration),
  );
};

function normalizedSmsPhone(phone: string): string | undefined {
  const match = /^\+86(1[3-9]\d{9})$/.exec(phone);
  return match?.[1];
}

function responseCode(response: unknown): string | undefined {
  if (
    response === null ||
    typeof response !== "object" ||
    !("body" in response) ||
    response.body === null ||
    typeof response.body !== "object" ||
    !("Code" in response.body) ||
    typeof response.body.Code !== "string" ||
    response.body.Code.trim().length === 0
  ) {
    return undefined;
  }
  return response.body.Code;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function exceptionStatus(error: unknown): number | undefined {
  const record = objectRecord(error);
  const candidate = record?.statusCode ?? record?.status;
  return typeof candidate === "number" && Number.isInteger(candidate)
    ? candidate
    : undefined;
}

function exceptionCode(error: unknown): string | undefined {
  const record = objectRecord(error);
  const data = objectRecord(record?.data);
  const body = objectRecord(record?.body);
  return (
    nonBlankString(data?.Code) ??
    nonBlankString(data?.code) ??
    nonBlankString(body?.Code) ??
    nonBlankString(body?.code) ??
    nonBlankString(record?.code)
  );
}

const ambiguousTransportCodes = new Set([
  "ABORT_ERR",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "RequestTimeout",
  "ServiceUnavailable",
  "InternalError",
  "SYSTEM_ERROR",
]);

function classifySdkException(error: unknown): SmsDeliveryOutcome {
  const status = exceptionStatus(error);
  const code = exceptionCode(error);

  if (
    status === 408 ||
    (code !== undefined && ambiguousTransportCodes.has(code))
  ) {
    return { kind: "uncertain", category: "transport_after_dispatch" };
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return {
      kind: "rejected",
      category: code?.startsWith("isv.")
        ? "provider_business"
        : "unknown_business",
    };
  }
  if (status !== undefined && status >= 500) {
    return { kind: "uncertain", category: "transport_after_dispatch" };
  }
  if (code !== undefined) {
    return {
      kind: "rejected",
      category: code.startsWith("isv.")
        ? "provider_business"
        : "unknown_business",
    };
  }
  return { kind: "uncertain", category: "transport_after_dispatch" };
}

export class AlibabaCloudSmsTransport implements SmsTransport {
  readonly #client: AlibabaSmsClient;
  readonly #signName: string;
  readonly #templateCode: string;

  constructor(options: Readonly<{
    client: AlibabaSmsClient;
    signName: string;
    templateCode: string;
  }>) {
    if (
      options.signName.trim().length === 0 ||
      options.templateCode.trim().length === 0
    ) {
      throw new Error("Invalid Alibaba SMS configuration");
    }
    this.#client = options.client;
    this.#signName = options.signName;
    this.#templateCode = options.templateCode;
  }

  async send(request: SmsTransportRequest): Promise<SmsDeliveryOutcome> {
    const phone = normalizedSmsPhone(request.phone);
    if (phone === undefined || !/^\d{6}$/.test(request.code)) {
      return { kind: "rejected", category: "invalid_request" };
    }

    let response: unknown;
    try {
      response = await this.#client.sendSms(
        Object.freeze({
          PhoneNumbers: phone,
          SignName: this.#signName,
          TemplateCode: this.#templateCode,
          TemplateParam: JSON.stringify({ code: request.code }),
        }),
        ALIBABA_SMS_RUNTIME,
      );
    } catch (error) {
      return classifySdkException(error);
    }

    const code = responseCode(response);
    if (code === undefined) {
      return { kind: "uncertain", category: "malformed_response" };
    }
    if (code === "OK") {
      return { kind: "accepted" };
    }
    return {
      kind: "rejected",
      category: code.startsWith("isv.")
        ? "provider_business"
        : "unknown_business",
    };
  }
}

export function createAlibabaCloudSmsTransport(
  configuration: AlibabaSmsConfiguration,
  clientFactory: AlibabaSmsClientFactory = createAlibabaSdkClient,
): AlibabaCloudSmsTransport {
  if (typeof configuration.endpoint !== "string" ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u.test(configuration.endpoint)) {
    throw new Error("SMS endpoint is not configured");
  }
  const client = clientFactory({
    credential: configuration.credential,
    endpoint: configuration.endpoint,
  });
  return new AlibabaCloudSmsTransport({
    client,
    signName: configuration.signName,
    templateCode: configuration.templateCode,
  });
}
