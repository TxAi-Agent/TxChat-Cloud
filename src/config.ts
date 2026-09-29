import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { inspect } from "node:util";
import { z } from "zod";
import { BAILIAN_REWRITE_MODELS, type BailianRewriteModel } from "./providers/bailianRewriteModels.js";

export type AppEnvironment = "development" | "test" | "production";
export type AuthCodeMode = "sms";
export type RealtimeASRModel = "paraformer-realtime-v2" | "fun-asr-realtime" | "qwen3-asr-flash-realtime" | "qwen3-asr-flash-realtime-2026-02-10";
export type AlibabaSmsCredentials = Readonly<{ accessKeyId: string; accessKeySecret: string }>;
export type AlibabaSmsConfiguration = Readonly<{
  provider: "alibaba-cloud"; endpoint: string; signName: string; templateCode: string;
  credential: Readonly<{ kind: "access-key-file" } & AlibabaSmsCredentials> | Readonly<{ kind: "ecs-ram-role"; roleName: string }>;
}>;
export type WeChatPartnerNativeConfiguration = Readonly<{
  apiOrigin: string; spMerchantId: string; spAppId: string; subMerchantId: string; spCertificateSerial: string;
  wechatPublicKeyId: string; notifyUrl: string; spPrivateKey: Buffer; apiV3Key: Buffer; wechatPublicKey: Buffer;
}>;
export type LegacyBailianConfig = Readonly<{
  asrUrl: string; asrModel: "paraformer-realtime-v2"; asrTimeoutMs: 360_000;
  textBaseUrl: string; textModel: BailianRewriteModel; textTimeoutMs: 120_000;
}>;
export type AuthConfig = Readonly<{
  codeMode: AuthCodeMode; matchesMockCode(candidate: string): boolean;
  smsProvider: "alibaba-cloud"; smsSignName?: string; smsEndpoint?: string;
  smsTemplateCode?: string; smsCredentialMode?: "access-key-file" | "ecs-ram-role" | "runtime-admin";
  smsEcsRamRoleName?: string;
}>;
export type BillingConfig = Readonly<{ enforcementMode: "enforce"; paymentMode: "disabled" | "partner-native"; salesAvailable: boolean }>;
const keyPurposes = ["jwtSigning", "phoneLookup", "phoneEncryption", "otpVerification", "ipLookup", "refreshRecovery", "contentEncryption", "modelCredential", "smsConfiguration"] as const;
type KeyPurpose = typeof keyPurposes[number];
export type SecretFilePurpose = KeyPurpose | "smsProviderCredentials" | "bailianApi" | "wechatSpPrivateKey" | "wechatApiV3Key" | "wechatPublicKey";
export type SecretFilePaths = Readonly<Record<KeyPurpose, string> & Partial<Record<Exclude<SecretFilePurpose, KeyPurpose>, string>>>;
export type AppConfig = Readonly<{
  environment: AppEnvironment; host: string; port: number;
  admin: Readonly<{ host: string; port: number; origin: string }>;
  paths: Readonly<{ dataDirectory: string; coreDatabase: string; contentDatabase: string; temporaryAudioDirectory: string }>;
  secretFiles: SecretFilePaths; auth: AuthConfig; billing: BillingConfig;
  legacyBailian: LegacyBailianConfig | null;
  realtime: Readonly<{ upstreamOpenTimeoutMs: number; finalTimeoutMs: number }>;
  contentRetentionDays: number;
  withSecretFile<T>(purpose: SecretFilePurpose, consume: (source: Buffer) => T): T;
  withAlibabaSmsConfiguration<T>(consume: (configuration: AlibabaSmsConfiguration) => T): T;
  withWeChatPartnerNativeConfiguration<T>(consume: (configuration: WeChatPartnerNativeConfiguration) => T): T;
  toJSON(): Readonly<Record<string, unknown>>;
}>;

const environmentSchema = z.object({
  APP_ENV: z.enum(["development", "test", "production"]).default("development"),
  COMMUNITY_DATA_DIRECTORY: z.string().min(1).default(".local-data"),
  COMMUNITY_KEYS_FILE: z.string().min(1).optional(),
  COMMUNITY_HOST: z.string().min(1).default("localhost"),
  COMMUNITY_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  COMMUNITY_ADMIN_HOST: z.string().min(1).default("localhost"),
  COMMUNITY_ADMIN_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  COMMUNITY_ADMIN_ORIGIN: z.string().optional(),
  CONTENT_RETENTION_DAYS: z.coerce.number().int().min(1).max(180).default(7),
  SMS_SIGN_NAME: z.string().trim().min(1).max(128).optional(),
  SMS_ENDPOINT: z.string().trim().min(1).max(253).optional(),
  SMS_TEMPLATE_CODE: z.string().trim().min(1).max(128).optional(),
  SMS_CREDENTIALS_FILE: z.string().min(1).optional(),
  SMS_ECS_RAM_ROLE_NAME: z.string().trim().min(1).max(128).optional(),
  BAILIAN_API_KEY_FILE: z.string().min(1).optional(),
  BAILIAN_ASR_URL: z.string().optional(), BAILIAN_TEXT_BASE_URL: z.string().optional(),
  BAILIAN_TEXT_MODEL: z.enum(BAILIAN_REWRITE_MODELS).optional(),
  WECHAT_PAY_SP_MERCHANT_ID: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).optional(),
  WECHAT_PAY_SP_APP_ID: z.string().regex(/^wx[A-Za-z0-9]{16}$/).optional(),
  WECHAT_PAY_SUB_MERCHANT_ID: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).optional(),
  WECHAT_PAY_SP_CERT_SERIAL: z.string().regex(/^[A-Fa-f0-9]{1,128}$/).optional(),
  WECHAT_PAY_WECHAT_PUBLIC_KEY_ID: z.string().regex(/^PUB_KEY_ID_[0-9]+$/).optional(),
  WECHAT_PAY_NOTIFY_URL: z.string().optional(),
  WECHAT_PAY_API_ORIGIN: z.string().optional(),
  WECHAT_PAY_SP_PRIVATE_KEY_FILE: z.string().min(1).optional(),
  WECHAT_PAY_API_V3_KEY_FILE: z.string().min(1).optional(),
  WECHAT_PAY_WECHAT_PUBLIC_KEY_FILE: z.string().min(1).optional(),
});

function configurationError(): Error { return new Error("Community configuration is invalid or unavailable"); }
export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
      (process.platform !== "win32" && ((metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid?.()))) {
    throw configurationError();
  }
}
function readSecret(path: string): Buffer {
  let descriptor: number | undefined;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink()) throw configurationError();
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(descriptor);
    const current = lstatSync(path);
    if (current.isSymbolicLink() || before.dev !== info.dev || before.ino !== info.ino ||
        current.dev !== info.dev || current.ino !== info.ino) throw configurationError();
    if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > 1048576 ||
        (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) throw configurationError();
    return readFileSync(descriptor);
  } catch { throw configurationError(); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}
function isMissing(path: string): boolean {
  try { lstatSync(path); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw configurationError(); }
}
function prepareKeys(path: string, mayCreate: boolean): void {
  if (!isMissing(path)) return;
  if (!mayCreate) throw new Error("Application keys are missing; preserve the existing keys when reusing a data directory");
  const keys = Object.fromEntries(keyPurposes.map((purpose) => [purpose, {
    activeVersion: "v1", priorVersions: [], keys: { v1: randomBytes(32).toString("base64") },
  }]));
  try { writeFileSync(path, JSON.stringify(keys), { encoding: "utf8", mode: 0o600, flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw configurationError(); }
}
function secureUrl(value: string, schemes: readonly string[]): string {
  let url: URL;
  try { url = new URL(value); } catch { throw configurationError(); }
  if (!schemes.includes(url.protocol) || url.username || url.password || url.hash) throw configurationError();
  return url.toString();
}
function allOrNone(values: readonly unknown[]): boolean {
  const present = values.filter((value) => value !== undefined).length;
  if (present !== 0 && present !== values.length) throw configurationError();
  return present > 0;
}
function synchronous<T>(result: T): T {
  if (result && typeof result === "object" && "then" in result) throw configurationError();
  return result;
}

export function loadConfig(input: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = environmentSchema.safeParse(input);
  if (!parsed.success) throw configurationError();
  const e = parsed.data;
  if (e.COMMUNITY_PORT === e.COMMUNITY_ADMIN_PORT) throw configurationError();
  let originUrl: URL;
  try { originUrl = new URL(e.COMMUNITY_ADMIN_ORIGIN ?? `http://localhost:${e.COMMUNITY_ADMIN_PORT}`); }
  catch { throw configurationError(); }
  if (originUrl.username || originUrl.password || originUrl.pathname !== "/" || originUrl.search || originUrl.hash ||
      (originUrl.protocol !== "https:" && !(originUrl.protocol === "http:" && ["localhost"].includes(originUrl.hostname)))) throw configurationError();
  const paths = Object.freeze({
    dataDirectory: resolve(e.COMMUNITY_DATA_DIRECTORY),
    coreDatabase: resolve(e.COMMUNITY_DATA_DIRECTORY, "core.sqlite"),
    contentDatabase: resolve(e.COMMUNITY_DATA_DIRECTORY, "content.sqlite"),
    temporaryAudioDirectory: resolve(e.COMMUNITY_DATA_DIRECTORY, "temporary-audio"),
  });
  ensurePrivateDirectory(paths.dataDirectory);
  ensurePrivateDirectory(paths.temporaryAudioDirectory);
  const keyFile = e.COMMUNITY_KEYS_FILE === undefined ? join(paths.dataDirectory, "application-keys.json") : resolve(e.COMMUNITY_KEYS_FILE);
  prepareKeys(keyFile, e.COMMUNITY_KEYS_FILE === undefined && isMissing(paths.coreDatabase) && isMissing(paths.contentDatabase));
  const secretFiles = Object.freeze({
    ...Object.fromEntries(keyPurposes.map((purpose) => [purpose, keyFile])) as Record<KeyPurpose, string>,
    ...(e.SMS_CREDENTIALS_FILE === undefined ? {} : { smsProviderCredentials: resolve(e.SMS_CREDENTIALS_FILE) }),
    ...(e.BAILIAN_API_KEY_FILE === undefined ? {} : { bailianApi: resolve(e.BAILIAN_API_KEY_FILE) }),
    ...(e.WECHAT_PAY_SP_PRIVATE_KEY_FILE === undefined ? {} : { wechatSpPrivateKey: resolve(e.WECHAT_PAY_SP_PRIVATE_KEY_FILE) }),
    ...(e.WECHAT_PAY_API_V3_KEY_FILE === undefined ? {} : { wechatApiV3Key: resolve(e.WECHAT_PAY_API_V3_KEY_FILE) }),
    ...(e.WECHAT_PAY_WECHAT_PUBLIC_KEY_FILE === undefined ? {} : { wechatPublicKey: resolve(e.WECHAT_PAY_WECHAT_PUBLIC_KEY_FILE) }),
  });
  const withSecretFile: AppConfig["withSecretFile"] = (purpose, consume) => {
    const path = secretFiles[purpose];
    if (path === undefined) throw configurationError();
    const source = readSecret(path);
    let selected: Buffer | undefined;
    try {
      if ((keyPurposes as readonly string[]).includes(purpose)) {
        const bundle: unknown = JSON.parse(source.toString("utf8"));
        if (!bundle || typeof bundle !== "object" || !Object.hasOwn(bundle, purpose)) throw configurationError();
        selected = Buffer.from(JSON.stringify((bundle as Record<string, unknown>)[purpose]), "utf8");
      }
      return synchronous(consume(selected ?? source));
    } catch { throw configurationError(); }
    finally { selected?.fill(0); source.fill(0); }
  };
  if (e.SMS_ENDPOINT !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(e.SMS_ENDPOINT)) throw configurationError();
  if (e.SMS_CREDENTIALS_FILE !== undefined && e.SMS_ECS_RAM_ROLE_NAME !== undefined) throw configurationError();
  const staticSms = e.SMS_CREDENTIALS_FILE !== undefined || e.SMS_ECS_RAM_ROLE_NAME !== undefined;
  if (staticSms && (!e.SMS_ENDPOINT || !e.SMS_SIGN_NAME || !e.SMS_TEMPLATE_CODE)) throw configurationError();
  const auth: AuthConfig = Object.freeze({
    codeMode: "sms", matchesMockCode: () => false, smsProvider: "alibaba-cloud",
    smsCredentialMode: e.SMS_CREDENTIALS_FILE !== undefined ? "access-key-file" : e.SMS_ECS_RAM_ROLE_NAME !== undefined ? "ecs-ram-role" : "runtime-admin",
    ...(e.SMS_SIGN_NAME === undefined ? {} : { smsSignName: e.SMS_SIGN_NAME }),
    ...(e.SMS_ENDPOINT === undefined ? {} : { smsEndpoint: e.SMS_ENDPOINT }),
    ...(e.SMS_TEMPLATE_CODE === undefined ? {} : { smsTemplateCode: e.SMS_TEMPLATE_CODE }),
    ...(e.SMS_ECS_RAM_ROLE_NAME === undefined ? {} : { smsEcsRamRoleName: e.SMS_ECS_RAM_ROLE_NAME }),
  });
  const hasModels = allOrNone([e.BAILIAN_API_KEY_FILE, e.BAILIAN_ASR_URL, e.BAILIAN_TEXT_BASE_URL, e.BAILIAN_TEXT_MODEL]);
  const legacyBailian: LegacyBailianConfig | null = hasModels ? Object.freeze({
    asrUrl: secureUrl(e.BAILIAN_ASR_URL!, ["wss:"]), asrModel: "paraformer-realtime-v2", asrTimeoutMs: 360_000,
    textBaseUrl: secureUrl(e.BAILIAN_TEXT_BASE_URL!, ["https:"]), textModel: e.BAILIAN_TEXT_MODEL!, textTimeoutMs: 120_000,
  }) : null;
  const hasPayment = allOrNone([e.WECHAT_PAY_API_ORIGIN, e.WECHAT_PAY_SP_MERCHANT_ID, e.WECHAT_PAY_SP_APP_ID, e.WECHAT_PAY_SUB_MERCHANT_ID, e.WECHAT_PAY_SP_CERT_SERIAL,
    e.WECHAT_PAY_WECHAT_PUBLIC_KEY_ID, e.WECHAT_PAY_NOTIFY_URL, e.WECHAT_PAY_SP_PRIVATE_KEY_FILE, e.WECHAT_PAY_API_V3_KEY_FILE, e.WECHAT_PAY_WECHAT_PUBLIC_KEY_FILE]);
  if (hasPayment) { secureUrl(e.WECHAT_PAY_NOTIFY_URL!, ["https:"]); secureUrl(e.WECHAT_PAY_API_ORIGIN!, ["https:"]); }
  const billing: BillingConfig = Object.freeze({ enforcementMode: "enforce", paymentMode: hasPayment ? "partner-native" : "disabled", salesAvailable: hasPayment });
  const safeView = Object.freeze({ environment: e.APP_ENV, smsConfigured: staticSms, modelsConfigured: hasModels, paymentConfigured: hasPayment });
  const config: AppConfig = Object.freeze({
    environment: e.APP_ENV, host: e.COMMUNITY_HOST, port: e.COMMUNITY_PORT,
    admin: Object.freeze({ host: e.COMMUNITY_ADMIN_HOST, port: e.COMMUNITY_ADMIN_PORT, origin: originUrl.origin }),
    paths, secretFiles, auth, billing, legacyBailian,
    realtime: Object.freeze({ upstreamOpenTimeoutMs: 1000, finalTimeoutMs: 2000 }),
    contentRetentionDays: e.CONTENT_RETENTION_DAYS, withSecretFile,
    withAlibabaSmsConfiguration: <T>(consume: (configuration: AlibabaSmsConfiguration) => T): T => {
      if (!staticSms) throw configurationError();
      const base = { provider: "alibaba-cloud" as const, endpoint: e.SMS_ENDPOINT!, signName: e.SMS_SIGN_NAME!, templateCode: e.SMS_TEMPLATE_CODE! };
      if (e.SMS_ECS_RAM_ROLE_NAME !== undefined) return synchronous(consume({ ...base, credential: { kind: "ecs-ram-role", roleName: e.SMS_ECS_RAM_ROLE_NAME } }));
      return withSecretFile("smsProviderCredentials", (source) => {
        const credentials = z.object({ accessKeyId: z.string().min(1), accessKeySecret: z.string().min(1) }).strict().safeParse(JSON.parse(source.toString("utf8")));
        if (!credentials.success) throw configurationError();
        return synchronous(consume({ ...base, credential: { kind: "access-key-file", ...credentials.data } }));
      });
    },
    withWeChatPartnerNativeConfiguration: <T>(consume: (configuration: WeChatPartnerNativeConfiguration) => T): T => {
      if (!hasPayment) throw configurationError();
      return withSecretFile("wechatSpPrivateKey", (spPrivateKey) => withSecretFile("wechatApiV3Key", (apiV3Key) => withSecretFile("wechatPublicKey", (wechatPublicKey) => synchronous(consume({
        apiOrigin: e.WECHAT_PAY_API_ORIGIN!, spMerchantId: e.WECHAT_PAY_SP_MERCHANT_ID!, spAppId: e.WECHAT_PAY_SP_APP_ID!, subMerchantId: e.WECHAT_PAY_SUB_MERCHANT_ID!,
        spCertificateSerial: e.WECHAT_PAY_SP_CERT_SERIAL!, wechatPublicKeyId: e.WECHAT_PAY_WECHAT_PUBLIC_KEY_ID!, notifyUrl: e.WECHAT_PAY_NOTIFY_URL!,
        spPrivateKey, apiV3Key, wechatPublicKey,
      })))));
    },
    toJSON: () => safeView,
    [inspect.custom]: () => safeView,
  });
  return config;
}
