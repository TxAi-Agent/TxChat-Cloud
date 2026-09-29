import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { FastifyInstance } from "fastify";

import { AdminAccountRepository } from "./admin/unified/adminAccountRepository.js";
import { AdminAuditRepository } from "./admin/unified/adminAuditRepository.js";
import { FeedbackAdminService } from "./admin/unified/feedbackAdminService.js";
import { ModelAdminAdapter } from "./admin/unified/modelAdminAdapter.js";
import { OfferAdminService } from "./admin/unified/offerAdminService.js";
import { OrderAdminService } from "./admin/unified/orderAdminService.js";
import { hashAdminPassword } from "./admin/unified/adminPassword.js";
import { AdminRateLimiter } from "./admin/unified/adminRateLimiter.js";
import { registerUnifiedAdminRoutes } from "./admin/unified/adminRoutes.js";
import { AdminSessionStore } from "./admin/unified/adminSession.js";
import { SmsAdminAdapter } from "./admin/unified/smsAdminAdapter.js";
import type { AdminPasswordHash } from "./admin/unified/adminTypes.js";
import { UserAdminService } from "./admin/unified/userAdminService.js";
import {
  buildApp,
  createReadinessController,
  type BuildAppOptions,
} from "./app.js";
import { createAuthenticationRuntime } from "./auth/authService.js";
import {
  createAlibabaCloudSmsTransport,
  type AlibabaSmsClientFactory,
} from "./auth/alibabaCloudSmsTransport.js";
import {
  loadVersionedKeyRing,
  type VersionedKeyRing,
} from "./auth/phoneIdentity.js";
import {
  FailClosedSmsProvider,
  ProductionSmsProvider,
  type SmsProvider,
  type SmsTransport,
} from "./auth/smsProvider.js";
import { SessionOperationRegistry } from "./auth/sessionService.js";
import {
  loadConfig,
  type AppConfig,
  type SecretFilePurpose,
} from "./config.js";
import { BillingCatalogRepository } from "./billing/billingCatalogRepository.js";
import { BillingEntitlementRepository } from "./billing/billingEntitlementRepository.js";
import { BillingOrderRepository } from "./billing/billingOrderRepository.js";
import { BillingService } from "./billing/billingService.js";
import {
  BillingUsageService,
} from "./billing/billingUsageService.js";
import {
  ProductionWeChatPartnerNativePaymentProvider,
  WeChatPaymentError,
  type WeChatOrderQueryResult,
  type WeChatPartnerIdentity,
  type WeChatPaymentProvider,
} from "./billing/wechatNativePayment.js";
import {
  ContentFreeMetrics,
  observeSpeechRecognitionProvider,
  observeTextRewriteProvider,
} from "./observability/metrics.js";
import {
  openDatabase,
  type ContentDatabase,
  type CoreDatabase,
} from "./db/database.js";
import { applyPublicSchema } from "./db/migrator.js";
import { initializeCommunityAdmin } from "./admin/unified/initializeCommunityAdmin.js";
import {
  ContentCipher,
  loadContentEncryptionKeyRing,
} from "./dictation/contentCipher.js";
import { DictationService } from "./dictation/dictationService.js";
import { DiagnosticReportService } from "./diagnostics/diagnosticReportService.js";
import { DiagnosticRetentionService } from "./diagnostics/diagnosticRetentionService.js";
import { ContentRetentionService } from "./dictation/retentionService.js";
import { cleanupStaleTemporaryAudio } from "./dictation/temporaryAudio.js";
import { BailianAsrProvider } from "./providers/bailianAsrProvider.js";
import { BailianRewriteProvider } from "./providers/bailianRewriteProvider.js";
import {
  UnavailableSpeechRecognitionProvider,
  UnavailableTextRewriteProvider,
} from "./providers/unavailableProviders.js";
import type {
  SpeechRecognitionProvider,
  TextRewriteProvider,
} from "./providers/providerTypes.js";
import { StreamingDictationService } from "./realtime/streamingDictationRoutes.js";
import {
  loadModelCredentialKeyRing,
  ModelCredentialCipher,
} from "./models/modelCredentialCipher.js";
import { ModelConfigurationRepository } from "./models/modelConfigurationRepository.js";
import {
  ProductionRealtimeProviderFactory,
  type RealtimeProviderFactory,
} from "./models/realtimeProviderFactory.js";
import { ObservedRealtimeProviderFactory } from "./models/observedRealtimeProviderFactory.js";
import { RuntimeModelRegistry } from "./models/runtimeModelRegistry.js";
import {
  loadSmsConfigurationKeyRing,
  SmsConfigurationCipher,
} from "./smsAdmin/smsConfigurationCipher.js";
import { SmsAdministrationRepository } from "./smsAdmin/smsAdministrationRepository.js";
import { RuntimeSmsConfigurationRegistry } from "./smsAdmin/runtimeSmsConfigurationRegistry.js";

export type ConfiguredApplication = Readonly<{
  dataApp: FastifyInstance;
  adminApp: FastifyInstance;
  database: CoreDatabase;
  contentDatabase: ContentDatabase;
  registry: RuntimeModelRegistry;
  metrics: ContentFreeMetrics;
  close(): Promise<void>;
}>;

type ShutdownSignalSource = Readonly<{
  once(
    event: "SIGINT" | "SIGTERM",
    listener: (signal: NodeJS.Signals) => void,
  ): unknown;
  removeListener(
    event: "SIGINT" | "SIGTERM",
    listener: (signal: NodeJS.Signals) => void,
  ): unknown;
}>;

export type ListenConfiguredApplicationOptions = Readonly<{
  dataPort?: number;
  adminPort?: number;
  signals?: ShutdownSignalSource;
}>;

type BillingUsageBoundary = Pick<
  BillingUsageService,
  "begin" | "settle" | "abandon"
> & Readonly<{
  dispose?: () => void;
}>;

export type CreateConfiguredApplicationOptions = Readonly<{
  config: AppConfig;
  smsTransport?: SmsTransport;
  alibabaSmsClientFactory?: AlibabaSmsClientFactory;
  speechRecognitionProvider?: SpeechRecognitionProvider;
  textRewriteProvider?: TextRewriteProvider;
  realtimeProviderFactory?: RealtimeProviderFactory;
  wechatPaymentProvider?: WeChatPaymentProvider & { dispose?: () => void };
  billingUsageService?: BillingUsageBoundary;
  logger?: BuildAppOptions["logger"];
}>;

function createStaticSmsTransport(
  config: AppConfig,
  transport: SmsTransport | undefined,
  alibabaSmsClientFactory: AlibabaSmsClientFactory | undefined,
): SmsTransport | undefined {
  if (config.auth.smsCredentialMode === "runtime-admin") return transport;
  let selectedTransport = transport;
  if (selectedTransport === undefined) {
    try {
      selectedTransport = config.withAlibabaSmsConfiguration(
        (configuration) =>
          createAlibabaCloudSmsTransport(
            configuration,
            alibabaSmsClientFactory,
          ),
      );
    } catch {
      throw new Error("SMS production transport is unavailable");
    }
  }
  return selectedTransport;
}

function clearAdminPasswordHash(hash: AdminPasswordHash | undefined): void {
  hash?.salt.fill(0);
  hash?.digest.fill(0);
}

function validateEffectiveKeySeparation(
  keys: Readonly<Record<string, VersionedKeyRing>>,
): void {
  const effectiveKeys: Buffer[] = [];
  for (const ring of Object.values(keys)) {
    for (const material of ring.versions.values()) {
      if (
        effectiveKeys.some(
          (existing) =>
            existing.length === material.length &&
            timingSafeEqual(existing, material),
        )
      ) {
        throw new Error("Duplicate effective application key material");
      }
      effectiveKeys.push(material);
    }
  }
}

function clearKeyRing(keys: VersionedKeyRing): void {
  for (const material of keys.versions.values()) {
    material.fill(0);
  }
}

class DisabledWeChatPaymentProvider implements WeChatPaymentProvider {
  createNativeOrder(): Promise<never> {
    return Promise.reject(new WeChatPaymentError("CONFIGURATION_INVALID"));
  }

  verifyNotification(): never {
    throw new WeChatPaymentError("CONFIGURATION_INVALID");
  }

  queryByOutTradeNo(): Promise<WeChatOrderQueryResult> {
    return Promise.reject(new WeChatPaymentError("CONFIGURATION_INVALID"));
  }

  closeOrder(): Promise<never> {
    return Promise.reject(new WeChatPaymentError("CONFIGURATION_INVALID"));
  }
}

function disposePaymentProvider(provider: WeChatPaymentProvider): void {
  const candidate = provider as WeChatPaymentProvider & {
    dispose?: unknown;
  };
  if (typeof candidate.dispose === "function") {
    candidate.dispose.call(provider);
  }
}

function disposeBillingUsage(service: BillingUsageBoundary | undefined): void {
  if (typeof service?.dispose === "function") {
    service.dispose.call(service);
  }
}

async function runBestEffortCleanup(
  steps: readonly (() => void | Promise<void>)[],
  primaryError?: unknown,
): Promise<void> {
  let firstError = primaryError;
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) {
    throw firstError;
  }
}

export async function createConfiguredApplication(
  options: CreateConfiguredApplicationOptions,
): Promise<ConfiguredApplication> {
  const readiness = createReadinessController();
  const { keys, contentEncryptionKeys, modelCredentialCipher, smsConfigurationCipher } = (() => {
    const acquired: VersionedKeyRing[] = [];
    let modelKeys: VersionedKeyRing | undefined;
    let smsKeys: VersionedKeyRing | undefined;
    let modelCipher: ModelCredentialCipher | undefined;
    let smsCipher: SmsConfigurationCipher | undefined;
    const readRing = (purpose: SecretFilePurpose, load: (source: Buffer) => VersionedKeyRing): VersionedKeyRing => {
      const ring = options.config.withSecretFile(purpose, load);
      acquired.push(ring);
      return ring;
    };
    try {
      const keys = {
        jwtSigning: readRing("jwtSigning", loadVersionedKeyRing),
        phoneLookup: readRing("phoneLookup", loadVersionedKeyRing),
        phoneEncryption: readRing("phoneEncryption", loadVersionedKeyRing),
        otpVerification: readRing("otpVerification", loadVersionedKeyRing),
        ipLookup: readRing("ipLookup", loadVersionedKeyRing),
        refreshRecovery: readRing("refreshRecovery", loadVersionedKeyRing),
      };
      const contentEncryptionKeys = readRing("contentEncryption", loadContentEncryptionKeyRing);
      modelKeys = readRing("modelCredential", loadModelCredentialKeyRing);
      smsKeys = readRing("smsConfiguration", loadSmsConfigurationKeyRing);
      validateEffectiveKeySeparation({ ...keys, contentEncryption: contentEncryptionKeys, modelCredential: modelKeys, smsConfiguration: smsKeys });
      modelCipher = new ModelCredentialCipher(modelKeys);
      smsCipher = new SmsConfigurationCipher(smsKeys);
      return { keys, contentEncryptionKeys, modelCredentialCipher: modelCipher, smsConfigurationCipher: smsCipher };
    } catch (error) {
      modelCipher?.dispose();
      smsCipher?.dispose();
      for (const ring of acquired) clearKeyRing(ring);
      throw error;
    } finally {
      // The ciphers copy their keys; these transient loader copies never survive startup.
      if (modelKeys !== undefined) clearKeyRing(modelKeys);
      if (smsKeys !== undefined) clearKeyRing(smsKeys);
    }
  })();
  let database: CoreDatabase;
  try {
    database = openDatabase(options.config.paths.coreDatabase);
  } catch (error) {
    modelCredentialCipher.dispose();
    smsConfigurationCipher?.dispose();
    for (const keyRing of Object.values(keys)) clearKeyRing(keyRing);
    clearKeyRing(contentEncryptionKeys);
    throw error;
  }
  let contentDatabase: ContentDatabase | undefined;
  let dataApp: FastifyInstance | undefined;
  let adminApp: FastifyInstance | undefined;
  let runtimeModelRegistry: RuntimeModelRegistry | undefined;
  let runtimeSmsRegistry: RuntimeSmsConfigurationRegistry | undefined;
  let smsAdministrationRepository: SmsAdministrationRepository | undefined;
  let unifiedSmsAdmin: SmsAdminAdapter | undefined;
  let streamingDictationService: StreamingDictationService | undefined;
  let unifiedAdminSessions: AdminSessionStore | undefined;
  let unifiedAdminRateLimiter: AdminRateLimiter | undefined;
  let unifiedAdminSetupRateLimiter: AdminRateLimiter | undefined;
  let unifiedAdminFallbackPasswordHash: AdminPasswordHash | undefined;
  let billingPaymentProvider: WeChatPaymentProvider | undefined;
  let billingUsage: BillingUsageBoundary | undefined;
  try {
    contentDatabase = openDatabase(
      options.config.paths.contentDatabase,
    );
    const activeContentDatabase = contentDatabase;
    applyPublicSchema(database, "core");
    applyPublicSchema(activeContentDatabase, "content");
    const staticSmsTransport = createStaticSmsTransport(
      options.config,
      options.smsTransport,
      options.alibabaSmsClientFactory,
    );
    let smsProvider: SmsProvider = new FailClosedSmsProvider();
    if (
      options.config.auth.codeMode === "sms" &&
      smsConfigurationCipher !== undefined
    ) {
      const smsRepository = new SmsAdministrationRepository(database);
      smsAdministrationRepository = smsRepository;
      runtimeSmsRegistry = new RuntimeSmsConfigurationRegistry({
        repository: smsRepository,
        cipher: smsConfigurationCipher,
        ...(options.config.auth.smsSignName === undefined ? {} : { signName: options.config.auth.smsSignName }),
        ...(options.config.auth.smsEndpoint === undefined ? {} : { endpoint: options.config.auth.smsEndpoint }),
        ...(options.alibabaSmsClientFactory === undefined
          ? {}
          : { clientFactory: options.alibabaSmsClientFactory }),
        ...(staticSmsTransport === undefined
          ? {}
          : { staticFallback: staticSmsTransport }),
      });
      smsProvider = runtimeSmsRegistry;
    } else if (options.config.auth.codeMode === "sms") {
      if (staticSmsTransport === undefined) {
        throw new Error("SMS production transport is unavailable");
      }
      smsProvider = new ProductionSmsProvider({
        transport: staticSmsTransport,
      });
    }
    const contentRetention = new ContentRetentionService(
      activeContentDatabase,
    );
    const sessionOperations = new SessionOperationRegistry();
    const configuredLoginReadiness = (): boolean => runtimeSmsRegistry?.isConfigured() === true ||
      (runtimeSmsRegistry === undefined && staticSmsTransport !== undefined);
    const runtime = createAuthenticationRuntime({
      database,
      environment: options.config.environment,
      codeMode: options.config.auth.codeMode,
      matchesMockCode: options.config.auth.matchesMockCode,
      keys,
      smsProvider,
      now: () => new Date(),
      revocationSink: sessionOperations,
    });
    const billingCatalog = new BillingCatalogRepository(database);
    const billingEntitlements = new BillingEntitlementRepository(database);
    billingUsage = options.config.billing.enforcementMode === "enforce"
      ? options.billingUsageService ??
        new BillingUsageService(database, billingEntitlements)
      : undefined;
    let billingPartnerIdentity: WeChatPartnerIdentity = Object.freeze({
      spMerchantId: "billing-disabled",
      spAppId: "billing-disabled",
      subMerchantId: "billing-disabled",
    });
    if (options.config.billing.paymentMode === "partner-native") {
      const partnerNative =
        options.config.withWeChatPartnerNativeConfiguration(
          (configuration) => {
            const payment = options.wechatPaymentProvider ??
              new ProductionWeChatPartnerNativePaymentProvider(configuration);
            return Object.freeze({
              payment,
              spMerchantId: configuration.spMerchantId,
              spAppId: configuration.spAppId,
              subMerchantId: configuration.subMerchantId,
            });
          },
        );
      billingPaymentProvider = partnerNative.payment;
      billingPartnerIdentity = Object.freeze({
        spMerchantId: partnerNative.spMerchantId,
        spAppId: partnerNative.spAppId,
        subMerchantId: partnerNative.subMerchantId,
      });
    } else {
      billingPaymentProvider = new DisabledWeChatPaymentProvider();
    }
    const activeBillingPaymentProvider = billingPaymentProvider;
    const billingOrders = new BillingOrderRepository(
      database,
      billingCatalog,
      billingEntitlements,
      {
        ...billingPartnerIdentity,
      },
    );
    const billingService = new BillingService(
      billingOrders,
      activeBillingPaymentProvider,
    );
    const legacyBailian = options.config.legacyBailian;
    const legacyApiKey =
      legacyBailian === null
        ? undefined
        : options.config
            .withSecretFile("bailianApi", (source) =>
              source.toString("utf8"),
            )
            .trim();
    const metrics = new ContentFreeMetrics();
    const speechRecognitionProvider = observeSpeechRecognitionProvider(
      options.speechRecognitionProvider ??
        (legacyBailian === null || legacyApiKey === undefined
          ? new UnavailableSpeechRecognitionProvider()
          : new BailianAsrProvider({
              apiKey: legacyApiKey,
              url: legacyBailian.asrUrl,
              model: legacyBailian.asrModel,
              timeoutMs: legacyBailian.asrTimeoutMs,
            })),
      metrics,
    );
    const textRewriteProvider = observeTextRewriteProvider(
      options.textRewriteProvider ??
        (legacyBailian === null || legacyApiKey === undefined
          ? new UnavailableTextRewriteProvider()
          : new BailianRewriteProvider({
              apiKey: legacyApiKey,
              baseUrl: legacyBailian.textBaseUrl,
              model: legacyBailian.textModel,
              timeoutMs: legacyBailian.textTimeoutMs,
            })),
      metrics,
    );
    const modelRepository = new ModelConfigurationRepository(
      database,
      modelCredentialCipher,
    );
    const realtimeFactory = new ObservedRealtimeProviderFactory(
      options.realtimeProviderFactory ??
        new ProductionRealtimeProviderFactory({
          providerTimeoutMs:
            options.config.realtime.upstreamOpenTimeoutMs +
            options.config.realtime.finalTimeoutMs +
            300_000,
        }),
      metrics,
    );
    runtimeModelRegistry = new RuntimeModelRegistry({
      repository: modelRepository,
      cipher: modelCredentialCipher,
      factory: realtimeFactory,
      now: () => new Date(),
    });
    streamingDictationService = new StreamingDictationService({
      authService: runtime.authService,
      sessionOperations,
      router: runtimeModelRegistry,
      textRewriteProvider,
      finalTimeoutMs: options.config.realtime.finalTimeoutMs,
      upstreamOpenTimeoutMs:
        options.config.realtime.upstreamOpenTimeoutMs,
      observeTextOptimizationFallback: (reason) => {
        metrics.recordTextOptimizationFallback(reason);
      },
      ...(billingUsage === undefined ? {} : { billingUsage }),
    });
    const dictationService = new DictationService({
      authService: runtime.authService,
      coreDatabase: database,
      contentDatabase: activeContentDatabase,
      contentCipher: new ContentCipher(contentEncryptionKeys),
      speechRecognitionProvider,
      textRewriteProvider,
      temporaryAudioDirectory:
        options.config.paths.temporaryAudioDirectory,
      contentRetentionDays: options.config.contentRetentionDays,
      asrModel: legacyBailian?.asrModel ?? "unavailable",
      rewriteModel: legacyBailian?.textModel ?? "unavailable",
      sessionOperations,
      ...(billingUsage === undefined ? {} : { billingUsage }),
    });
    const diagnosticReportService = new DiagnosticReportService({
      database,
      ipLookupKeys: keys.ipLookup,
    });
    const diagnosticRetention = new DiagnosticRetentionService(database);
    const startupNow = new Date();
    let contentRetentionCleanup = false;
    try {
      contentRetention.purgeExpired(startupNow);
      contentRetentionCleanup = true;
    } catch {
      contentRetentionCleanup = false;
    }
    let authenticationRetentionCleanup = false;
    try {
      runtime.retentionService.purge(startupNow);
      authenticationRetentionCleanup = true;
    } catch {
      authenticationRetentionCleanup = false;
    }
    let diagnosticRetentionCleanup = false;
    try {
      diagnosticRetention.purge(startupNow);
      diagnosticRetentionCleanup = true;
    } catch {
      diagnosticRetentionCleanup = false;
    }
    const retentionCleanup =
      contentRetentionCleanup &&
      authenticationRetentionCleanup &&
      diagnosticRetentionCleanup;
    let temporaryAudioCleanup = false;
    try {
      await cleanupStaleTemporaryAudio(
        options.config.paths.temporaryAudioDirectory,
        startupNow,
      );
      temporaryAudioCleanup = true;
    } catch {
      temporaryAudioCleanup = false;
    }
    metrics.updateHealth({
      databases: true,
      retentionCleanup,
      temporaryAudioCleanup,
    });
    dataApp = buildApp({
      readiness,
      configuredLoginReadiness,
      metrics,
      authService: runtime.authService,
      billing: {
        authService: runtime.authService,
        catalog: billingCatalog,
        entitlements: billingEntitlements,
        billingService,
        payment: activeBillingPaymentProvider,
        salesAvailable: options.config.billing.salesAvailable,
      },
      smsAuthenticationEnabled: true,
      dictationService,
      diagnosticReportService,
      streamingDictationService,
      ...(options.logger === undefined
        ? {}
        : { logger: options.logger }),
    });
    adminApp = buildApp({
      readiness,
      configuredLoginReadiness,
      metrics,
      ...(options.logger === undefined
        ? {}
        : { logger: options.logger }),
    });
    {
      const accounts = new AdminAccountRepository(database);
      const audit = new AdminAuditRepository(database);
      initializeCommunityAdmin({ database, dataDirectory: options.config.paths.dataDirectory, origin: options.config.admin.origin });
      const rateLimitKey = keys.ipLookup.versions.get(
        keys.ipLookup.activeVersion,
      );
      if (rateLimitKey === undefined) {
        throw new Error("Unified administrator rate limit is unavailable");
      }
      unifiedAdminRateLimiter = new AdminRateLimiter({ key: rateLimitKey });
      const setupRateLimitKey = createHash("sha256")
        .update("TxChat unified administrator setup rate limit v1\0", "utf8")
        .update(rateLimitKey)
        .digest();
      try {
        unifiedAdminSetupRateLimiter = new AdminRateLimiter({
          key: setupRateLimitKey,
        });
      } finally {
        setupRateLimitKey.fill(0);
      }
      unifiedAdminSessions = new AdminSessionStore({
        origin: options.config.admin.origin,
        accountById: (accountId) => accounts.activeById(accountId),
      });
      unifiedAdminFallbackPasswordHash = await hashAdminPassword(
        randomBytes(32).toString("base64url"),
      );
      registerUnifiedAdminRoutes(adminApp, {
        accounts,
        audit,
        sessions: unifiedAdminSessions,
        rateLimiter: unifiedAdminRateLimiter,
        setupRateLimiter: unifiedAdminSetupRateLimiter,
        fallbackPasswordHash: unifiedAdminFallbackPasswordHash,
        origin: options.config.admin.origin,
        users: new UserAdminService({
          database,
          phoneLookupKeys: keys.phoneLookup,
          phoneEncryptionKeys: keys.phoneEncryption,
          audit,
          revocationSink: sessionOperations,
        }),
        feedback: new FeedbackAdminService(database),
        orders: new OrderAdminService({
          database,
          phoneEncryptionKeys: keys.phoneEncryption,
        }),
        offers: new OfferAdminService({ database, audit }),
        models: new ModelAdminAdapter({
          registry: runtimeModelRegistry,
          audit,
        }),
        ...(runtimeSmsRegistry === undefined || smsAdministrationRepository === undefined
          ? {}
          : (() => {
              const rateLimitKey = keys.ipLookup.versions.get(keys.ipLookup.activeVersion);
              if (rateLimitKey === undefined) {
                throw new Error("Unified SMS administrator rate limit is unavailable");
              }
              unifiedSmsAdmin = new SmsAdminAdapter({
                repository: smsAdministrationRepository,
                registry: runtimeSmsRegistry,
                audit,
                rateLimitKey,
              });
              return { sms: unifiedSmsAdmin };
            })()),
      });
    }
    readiness.update({
      migrations: true,
      databases: true,
      retentionCleanup,
      temporaryAudioCleanup,
    });
    if (!retentionCleanup) {
      dataApp.log.error(
        {
          retentionCleanup: false,
          contentRetentionCleanup,
          authenticationRetentionCleanup,
          diagnosticRetentionCleanup,
        },
        "startup retention cleanup failed",
      );
    }
    if (!temporaryAudioCleanup) {
      dataApp.log.error(
        { temporaryAudioCleanup: false },
        "startup temporary audio cleanup failed",
      );
    }
    const activeDataApp = dataApp;
    const activeAdminApp = adminApp;
    const activeRegistry = runtimeModelRegistry;
    const activeStreamingService = streamingDictationService;
    const activeUnifiedAdminSessions = unifiedAdminSessions;
    const activeUnifiedAdminRateLimiter = unifiedAdminRateLimiter;
    const activeUnifiedAdminSetupRateLimiter = unifiedAdminSetupRateLimiter;
    const activeUnifiedAdminFallbackPasswordHash =
      unifiedAdminFallbackPasswordHash;
    const activeSmsRegistry = runtimeSmsRegistry;
    const activeUnifiedSmsAdmin = unifiedSmsAdmin;
    const activeBillingPayment = activeBillingPaymentProvider;
    const activeBillingUsage = billingUsage;
    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closePromise ??= runBestEffortCleanup([
        () => activeDataApp.close(),
        () => activeAdminApp.close(),
        () => activeStreamingService.shutdown(),
        () => disposeBillingUsage(activeBillingUsage),
        () => activeUnifiedAdminSessions?.dispose(),
        () => activeUnifiedAdminRateLimiter?.dispose(),
        () => activeUnifiedAdminSetupRateLimiter?.dispose(),
        () => clearAdminPasswordHash(activeUnifiedAdminFallbackPasswordHash),
        () => activeRegistry.dispose(),
        () => activeSmsRegistry?.dispose(),
        () => activeUnifiedSmsAdmin?.dispose(),
        () => disposePaymentProvider(activeBillingPayment),
        () => modelCredentialCipher.dispose(),
        () => smsConfigurationCipher?.dispose(),
        () => {
          for (const keyRing of Object.values(keys)) clearKeyRing(keyRing);
          clearKeyRing(contentEncryptionKeys);
        },
        () => {
          if (activeContentDatabase.open) {
            activeContentDatabase.close();
          }
        },
        () => {
          if (database.open) {
            database.close();
          }
        },
      ]);
      return closePromise;
    };
    return Object.freeze({
      dataApp: activeDataApp,
      adminApp: activeAdminApp,
      database,
      contentDatabase: activeContentDatabase,
      registry: activeRegistry,
      metrics,
      close,
    });
  } catch (error) {
    await runBestEffortCleanup(
      [
        () => dataApp?.close(),
        () => adminApp?.close(),
        () => streamingDictationService?.shutdown(),
        () => disposeBillingUsage(billingUsage),
        () => unifiedAdminSessions?.dispose(),
        () => unifiedAdminRateLimiter?.dispose(),
        () => unifiedAdminSetupRateLimiter?.dispose(),
        () => clearAdminPasswordHash(unifiedAdminFallbackPasswordHash),
        () => runtimeModelRegistry?.dispose(),
        () => runtimeSmsRegistry?.dispose(),
        () => unifiedSmsAdmin?.dispose(),
        () => {
          if (billingPaymentProvider !== undefined) {
            disposePaymentProvider(billingPaymentProvider);
          }
        },
        () => modelCredentialCipher.dispose(),
        () => smsConfigurationCipher?.dispose(),
        () => {
          for (const keyRing of Object.values(keys)) clearKeyRing(keyRing);
          clearKeyRing(contentEncryptionKeys);
        },
        () => {
          if (contentDatabase?.open === true) {
            contentDatabase.close();
          }
        },
        () => {
          if (database.open) {
            database.close();
          }
        },
      ],
      error,
    );
    throw error;
  }
}

export async function listenConfiguredApplication(
  configured: ConfiguredApplication,
  config: AppConfig,
  options: ListenConfiguredApplicationOptions = {},
): Promise<void> {
  const signals = options.signals ?? process;
  let removed = false;
  let dataClosed = false;
  let adminClosed = false;
  let shutdownStarted = false;
  const removeSignalHandlers = (): void => {
    if (removed) {
      return;
    }
    removed = true;
    signals.removeListener("SIGINT", onSignal);
    signals.removeListener("SIGTERM", onSignal);
  };
  const removeWhenBothAppsClosed = (): void => {
    if (dataClosed && adminClosed) {
      removeSignalHandlers();
    }
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;
    configured.dataApp.log.info({ signal }, "shutting down");
    void configured.close().then(
      () => removeSignalHandlers(),
      (error: unknown) => {
        removeSignalHandlers();
        configured.dataApp.log.error(
          { err: error },
          "failed to close cleanly",
        );
        process.exitCode = 1;
      },
    );
  };
  configured.dataApp.addHook("onClose", () => {
    dataClosed = true;
    removeWhenBothAppsClosed();
  });
  configured.adminApp.addHook("onClose", () => {
    adminClosed = true;
    removeWhenBothAppsClosed();
  });
  signals.once("SIGINT", onSignal);
  signals.once("SIGTERM", onSignal);

  try {
    await configured.dataApp.listen({
      host: config.host,
      port: options.dataPort ?? config.port,
    });
    await configured.adminApp.listen({
      host: config.admin.host,
      port: options.adminPort ?? config.admin.port,
    });
  } catch (error) {
    try {
      await configured.close();
    } catch (closeError) {
      configured.dataApp.log.error(
        { err: closeError },
        "failed to unwind startup",
      );
    } finally {
      removeSignalHandlers();
    }
    throw error;
  }
}

export async function startServer(
  config: AppConfig = loadConfig(),
  smsTransport?: SmsTransport,
): Promise<void> {
  const configured = await createConfiguredApplication({
    config,
    ...(smsTransport === undefined ? {} : { smsTransport }),
    logger: true,
  });

  try {
    await listenConfiguredApplication(configured, config);
  } catch (error) {
    configured.dataApp.log.fatal({ err: error }, "failed to start");
    process.exitCode = 1;
    try {
      await configured.close();
    } catch (closeError) {
      configured.dataApp.log.error(
        { err: closeError },
        "failed to close after startup failure",
      );
    }
  }
}

export function isMainModuleEntry(
  moduleUrl: string,
  entryPath: string | undefined,
): boolean {
  if (entryPath === undefined) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entryPath);
  } catch {
    return false;
  }
}

if (isMainModuleEntry(import.meta.url, process.argv[1])) {
  await startServer();
}
