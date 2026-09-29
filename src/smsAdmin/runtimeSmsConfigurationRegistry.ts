import { randomInt } from "node:crypto";

import {
  createAlibabaCloudSmsTransport,
  type AlibabaSmsClientFactory,
} from "../auth/alibabaCloudSmsTransport.js";
import type {
  SmsDeliveryOutcome,
  SmsProvider,
  SmsSendRequest,
  SmsTransport,
} from "../auth/smsProvider.js";
import {
  allocateInternalId,
  generateInternalId,
  type InternalIdGenerator,
} from "../ids/internalId.js";
import type { SafeSmsConfiguration } from "./smsAdminTypes.js";
import {
  SmsAdministrationError,
  SmsAdministrationRepository,
} from "./smsAdministrationRepository.js";
import { SmsConfigurationCipher } from "./smsConfigurationCipher.js";

export type SafeSmsConfiguredSummary = Readonly<{
  id: string;
  configured: true;
  revision: number;
  templateCode: string;
  accessKeyIdSuffix: string;
  secretConfigured: true;
}>;

export type SafeSmsAdministrationStatus = Readonly<{
  active: SafeSmsConfiguredSummary | null;
  standby: SafeSmsConfiguredSummary | null;
  draft: Readonly<{
    id: string;
    revision: number;
    templateCode: string;
    accessKeyIdSuffix: string;
    secretConfigured: boolean;
    lastTestOutcome: "accepted" | "rejected" | "uncertain" | null;
  }> | null;
  transitionFallback: boolean;
}>;

export type SaveSmsDraft = Readonly<{
  expectedRevision: number | null;
  templateCode: string;
  accessKeyId: string;
  accessKeySecret: string;
}>;

export type TestSmsDraft = Readonly<{
  draftRevision: number;
  phone: string;
}>;

export type SmsDraftTestResult =
  | Readonly<{ status: "accepted"; draftRevision: number }>
  | Readonly<{ status: "rejected" | "uncertain" }>;

type ActiveSnapshot = Readonly<{
  transport: SmsTransport;
  safe: SafeSmsConfiguredSummary;
}>;

function suffix(accessKeyId: string): string {
  return accessKeyId.slice(-5);
}

function clearEncrypted(encrypted: Readonly<{
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}>): void {
  encrypted.nonce.fill(0);
  encrypted.ciphertext.fill(0);
  encrypted.tag.fill(0);
}

export class RuntimeSmsConfigurationRegistry implements SmsProvider {
  readonly #signName: string;
  readonly #endpoint: string;
  readonly #repository: SmsAdministrationRepository;
  readonly #cipher: SmsConfigurationCipher;
  readonly #clientFactory: AlibabaSmsClientFactory | undefined;
  readonly #staticFallback: SmsTransport | undefined;
  readonly #now: () => string;
  readonly #randomCode: () => string;
  readonly #internalId: InternalIdGenerator;
  #active: ActiveSnapshot | undefined;
  #standby: ActiveSnapshot | undefined;
  #draftSuffix: Readonly<{ revision: number; value: string }> | undefined;
  #disposed = false;

  constructor(options: Readonly<{
    repository: SmsAdministrationRepository;
    cipher: SmsConfigurationCipher;
    signName?: string;
    endpoint?: string;
    clientFactory?: AlibabaSmsClientFactory;
    staticFallback?: SmsTransport;
    now?: () => string;
    randomCode?: () => string;
    internalId?: InternalIdGenerator;
  }>) {
    this.#signName = options.signName ?? "";
    this.#endpoint = options.endpoint ?? "";
    this.#repository = options.repository;
    this.#cipher = options.cipher;
    this.#clientFactory = options.clientFactory;
    this.#staticFallback = options.staticFallback;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#randomCode = options.randomCode ?? (() =>
      String(randomInt(0, 1_000_000)).padStart(6, "0"));
    this.#internalId = options.internalId ?? generateInternalId;
    const active = this.#repository.activeCiphertext();
    if (active !== null) {
      try {
        this.#active = this.#snapshot(active);
      } catch {
        this.#active = undefined;
      } finally {
        clearEncrypted(active.encrypted);
      }
    }
    const draft = this.#repository.draftCiphertext();
    if (draft !== null) {
      try {
        this.#draftSuffix = Object.freeze({
          revision: draft.revision,
          value: this.#credentialSuffix(draft),
        });
      } catch {
        this.#draftSuffix = undefined;
      } finally {
        clearEncrypted(draft.encrypted);
      }
    }
    const standby = this.#repository.standbyCiphertext();
    if (standby !== null) {
      try {
        this.#standby = this.#snapshot(standby);
      } catch {
        this.#standby = undefined;
      } finally {
        clearEncrypted(standby.encrypted);
      }
    }
  }

  isConfigured(): boolean {
    return !this.#disposed &&
      (this.#active !== undefined || this.#staticFallback !== undefined);
  }

  safeStatus(): SafeSmsAdministrationStatus {
    const draft = this.#repository.safeDraft();
    const draftSuffix = draft === null || this.#draftSuffix?.revision !== draft.revision
      ? ""
      : this.#draftSuffix.value;
    return Object.freeze({
      active: this.#active?.safe ?? null,
      standby: this.#standby?.safe ?? null,
      draft: draft === null
        ? null
        : Object.freeze({
            id: draft.id,
            revision: draft.revision,
            templateCode: draft.templateCode,
            accessKeyIdSuffix: draftSuffix,
            secretConfigured: draftSuffix.length > 0,
            lastTestOutcome: draft.lastTestOutcome,
          }),
      transitionFallback: this.#active === undefined && this.#staticFallback !== undefined,
    });
  }

  saveDraft(input: SaveSmsDraft): SafeSmsConfiguration {
    this.#assertAvailable();
    if (!this.#signName || !this.#endpoint) {
      throw new Error("SMS provider is not configured");
    }
    const currentDraft = this.#repository.safeDraft();
    const highestRevision = this.#repository.listSafe().reduce(
      (maximum, configuration) => Math.max(maximum, configuration.revision), 0,
    );
    const desiredRevision = highestRevision + 1;
    const id = allocateInternalId(this.#internalId);
    const encrypted = this.#cipher.encrypt({
      configurationId: id,
      revision: desiredRevision,
      provider: "alibaba-cloud",
      signName: this.#signName,
      templateCode: input.templateCode,
      accessKeyId: input.accessKeyId,
      accessKeySecret: input.accessKeySecret,
    });
    try {
      const saved = this.#repository.replaceDraft({
        id,
        expectedRevision: input.expectedRevision,
        desiredRevision,
        templateCode: input.templateCode,
        encrypted,
        now: this.#timestamp(),
      });
      this.#draftSuffix = Object.freeze({
        revision: saved.revision,
        value: suffix(input.accessKeyId),
      });
      return saved;
    } finally {
      clearEncrypted(encrypted);
    }
  }

  async testDraft(input: TestSmsDraft): Promise<SmsDraftTestResult> {
    this.#assertAvailable();
    if (
      !Number.isSafeInteger(input.draftRevision) ||
      input.draftRevision < 1 ||
      !/^\+86(1[3-9][0-9]{9})$/.test(input.phone)
    ) {
      return Object.freeze({ status: "rejected" });
    }
    const code = this.#randomCode();
    if (!/^[0-9]{6}$/.test(code)) {
      return Object.freeze({ status: "rejected" });
    }
    const claimId = allocateInternalId(this.#internalId);
    const claimed = this.#repository.claimDraftTest({
      expectedRevision: input.draftRevision,
      claimId,
      now: this.#timestamp(),
    });
    let candidate: ActiveSnapshot | undefined;
    let outcome: SmsDeliveryOutcome;
    try {
      candidate = this.#snapshot(claimed);
      outcome = await candidate.transport.send({
        phone: input.phone,
        code,
        challengeId: allocateInternalId(this.#internalId),
      });
    } catch {
      outcome = { kind: "rejected", category: "configuration" };
    } finally {
      clearEncrypted(claimed.encrypted);
    }
    if (outcome.kind !== "accepted" || candidate === undefined) {
      const status = outcome.kind === "uncertain" ? "uncertain" : "rejected";
      this.#repository.releaseDraftTest({
        expectedRevision: input.draftRevision,
        claimId,
        outcome: status,
        now: this.#timestamp(),
      });
      return Object.freeze({ status });
    }
    this.#repository.releaseDraftTest({
      expectedRevision: input.draftRevision,
      claimId,
      outcome: "accepted",
      now: this.#timestamp(),
    });
    return Object.freeze({
      status: "accepted" as const,
      draftRevision: input.draftRevision,
    });
  }

  activateDraft(id: string, expectedRevision: number): SafeSmsAdministrationStatus {
    this.#assertAvailable();
    const draft = this.#repository.draftCiphertext();
    if (draft === null || draft.id !== id || draft.revision !== expectedRevision) {
      if (draft !== null) clearEncrypted(draft.encrypted);
      if (draft === null || draft.id !== id) {
        throw new SmsAdministrationError("NOT_INITIALIZED");
      }
      throw new SmsAdministrationError("REVISION_CONFLICT");
    }
    let candidate: ActiveSnapshot;
    try {
      candidate = this.#snapshot(draft);
    } finally {
      clearEncrypted(draft.encrypted);
    }
    this.#repository.activateTestedDraft({ id, expectedRevision, now: this.#timestamp() });
    this.#standby = this.#active;
    this.#active = candidate;
    this.#draftSuffix = undefined;
    return this.safeStatus();
  }

  rollback(): SafeSmsAdministrationStatus {
    this.#assertAvailable();
    const standby = this.#repository.standbyCiphertext();
    if (standby === null) throw new SmsAdministrationError("INVALID_STATE");
    let candidate: ActiveSnapshot;
    try {
      candidate = this.#snapshot(standby);
    } finally {
      clearEncrypted(standby.encrypted);
    }
    this.#repository.rollbackToStandby(this.#timestamp());
    const previous = this.#active;
    this.#active = candidate;
    this.#standby = previous;
    return this.safeStatus();
  }

  async testAndActivate(input: TestSmsDraft): Promise<Readonly<
    { status: "accepted"; activeRevision: number } |
    { status: "rejected" | "uncertain" }
  >> {
    const result = await this.testDraft(input);
    if (result.status !== "accepted") return result;
    const draft = this.#repository.safeDraft();
    if (draft === null) throw new Error("SMS draft is unavailable");
    this.activateDraft(draft.id, draft.revision);
    return Object.freeze({ status: "accepted" as const, activeRevision: draft.revision });
  }

  async send(request: SmsSendRequest): Promise<SmsDeliveryOutcome> {
    if (this.#disposed) return { kind: "rejected", category: "configuration" };
    const transport = this.#active?.transport ?? this.#staticFallback;
    if (transport === undefined) {
      return { kind: "rejected", category: "configuration" };
    }
    return transport.send(request);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#active = undefined;
    this.#standby = undefined;
    this.#draftSuffix = undefined;
  }

  #snapshot(configuration: Readonly<{
    id: string;
    revision: number;
    templateCode: string;
    encrypted: Parameters<SmsConfigurationCipher["decrypt"]>[0]["encrypted"];
  }>): ActiveSnapshot {
    const credentials = this.#cipher.decrypt({
      configurationId: configuration.id,
      revision: configuration.revision,
      provider: "alibaba-cloud",
      signName: this.#signName,
      templateCode: configuration.templateCode,
      encrypted: configuration.encrypted,
    });
    const transport = createAlibabaCloudSmsTransport({
      endpoint: this.#endpoint,
      provider: "alibaba-cloud",
      signName: this.#signName,
      templateCode: configuration.templateCode,
      credential: Object.freeze({
        kind: "access-key-file" as const,
        accessKeyId: credentials.accessKeyId,
        accessKeySecret: credentials.accessKeySecret,
      }),
    }, this.#clientFactory);
    return Object.freeze({
      transport,
      safe: Object.freeze({
        id: configuration.id,
        configured: true as const,
        revision: configuration.revision,
        templateCode: configuration.templateCode,
        accessKeyIdSuffix: suffix(credentials.accessKeyId),
        secretConfigured: true as const,
      }),
    });
  }

  #credentialSuffix(configuration: Readonly<{
    id: string;
    revision: number;
    templateCode: string;
    encrypted: Parameters<SmsConfigurationCipher["decrypt"]>[0]["encrypted"];
  }>): string {
    const credentials = this.#cipher.decrypt({
      configurationId: configuration.id,
      revision: configuration.revision,
      provider: "alibaba-cloud",
      signName: this.#signName,
      templateCode: configuration.templateCode,
      encrypted: configuration.encrypted,
    });
    return suffix(credentials.accessKeyId);
  }

  #timestamp(): string {
    const value = this.#now();
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
      throw new Error("SMS runtime clock is unavailable");
    }
    return value;
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new Error("SMS runtime registry is unavailable");
  }
}
