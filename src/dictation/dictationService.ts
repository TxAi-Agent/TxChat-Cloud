import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import {
  AuthFailure,
  type AuthService,
} from "../auth/authService.js";
import {
  SessionOperationRegistry,
  SessionOperationRevoked,
} from "../auth/sessionService.js";
import type {
  BillingUsageService,
  BillingUsageTicket,
} from "../billing/billingUsageService.js";
import { BillingFailure } from "../billing/billingTypes.js";
import type {
  ContentDatabase,
  CoreDatabase,
} from "../db/database.js";
import type { InternalIdGenerator } from "../ids/internalId.js";
import { allocateRuntimeEntityId } from "../ids/runtimeEntityId.js";
import {
  ProviderError,
  type SpeechRecognitionProvider,
  type TextRewriteProvider,
} from "../providers/providerTypes.js";
import {
  ContentCipher,
  storeEncryptedContentPair,
} from "./contentCipher.js";
import {
  FinalizationQueue,
  type FinalizationLease,
} from "./finalizationQueue.js";
import { validateFinalText } from "./finalTextValidation.js";
import {
  AudioValidationFailure,
  validateWaveFile,
} from "./audioValidation.js";
import {
  TemporaryAudioAborted,
  TemporaryAudioCleanupFailure,
  withTemporaryAudio,
} from "./temporaryAudio.js";

export type DictationFailureCode =
  | "AUDIO_INVALID"
  | "AUTH_REQUIRED"
  | "SESSION_REPLACED"
  | "SESSION_EXPIRED"
  | "ACCOUNT_DISABLED"
  | "TOO_MANY_REQUESTS"
  | "BILLING_QUOTA_EXHAUSTED"
  | "ASR_FAILED"
  | "REWRITE_FAILED"
  | "SERVICE_UNAVAILABLE";

export class DictationFailure extends Error {
  constructor(
    readonly code: DictationFailureCode,
    readonly statusCode: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = "DictationFailure";
  }
}

type AuthenticatedIdentity = Awaited<
  ReturnType<AuthService["authenticateAccessToken"]>
>;

export type DictationAudioUpload = Readonly<{
  fieldname: string;
  filename: string;
  mimetype: string;
  stream: AsyncIterable<Uint8Array>;
}>;

export type DictationResult = Readonly<{
  requestId: string;
  finalText: string;
  asrMs: number;
  rewriteMs: number;
  totalMs: number;
}>;

export type DictationServiceOptions = Readonly<{
  authService: Pick<AuthService, "authenticateAccessToken">;
  coreDatabase: CoreDatabase;
  contentDatabase: ContentDatabase;
  contentCipher: ContentCipher;
  speechRecognitionProvider: SpeechRecognitionProvider;
  textRewriteProvider: TextRewriteProvider;
  temporaryAudioDirectory: string;
  contentRetentionDays: number;
  asrModel: string;
  rewriteModel: string;
  sessionOperations: SessionOperationRegistry;
  billingUsage?: Pick<BillingUsageService, "begin" | "settle" | "abandon">;
  now?: () => Date;
  monotonicNow?: () => number;
  internalId?: InternalIdGenerator;
}>;

type ErrorStage =
  | "upload"
  | "audio_validation"
  | "asr"
  | "rewrite"
  | "response"
  | "cancel";

type PreparedDictation = Readonly<{
  finalText: string;
  asrMs: number;
  rewriteMs: number;
  rawCharacterCount: number;
  finalCharacterCount: number;
  inputTokens: number;
  outputTokens: number;
  pcmDataLength: number;
  completedAt: Date;
}>;

type FinalizationState = {
  lease: FinalizationLease | undefined;
  contentTransactionOwned: boolean;
  coreTransactionOwned: boolean;
};

/** Bounded before storage or forwarding to another provider. */
export const RAW_TRANSCRIPT_MAX_CODE_POINTS = 20_000;
export { FINAL_TEXT_MAX_CODE_POINTS } from "./finalTextValidation.js";

const acceptedWaveMimeTypes = new Set([
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
]);

function milliseconds(start: number, end: number): number {
  return Math.max(0, Math.round(end - start));
}

function isDisallowedControl(codePoint: number): boolean {
  return (
    (codePoint < 0x20 &&
      codePoint !== 0x09 &&
      codePoint !== 0x0a &&
      codePoint !== 0x0d) ||
    (codePoint >= 0x7f && codePoint <= 0x9f)
  );
}

function boundedProviderText(
  value: unknown,
  maximumCodePoints: number,
): string {
  if (typeof value !== "string") {
    throw new Error("Provider returned invalid text");
  }

  let codePoints = 0;
  for (const character of value) {
    codePoints += 1;
    if (
      codePoints > maximumCodePoints ||
      isDisallowedControl(character.codePointAt(0) ?? 0)
    ) {
      throw new Error("Provider returned invalid text");
    }
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error("Provider returned invalid text");
  }
  return normalized;
}

function validRawTranscript(value: unknown): string {
  return boundedProviderText(
    value,
    RAW_TRANSCRIPT_MAX_CODE_POINTS,
  );
}

function sameIdentity(
  first: AuthenticatedIdentity,
  second: AuthenticatedIdentity,
): boolean {
  return (
    first.accountId === second.accountId &&
    first.sessionId === second.sessionId &&
    first.deviceId === second.deviceId
  );
}

export class DictationService {
  readonly #activeAccounts = new Set<string>();
  readonly #finalizationQueue = new FinalizationQueue();
  readonly #now: () => Date;
  readonly #monotonicNow: () => number;
  readonly #phaseOneSchema: boolean;

  constructor(private readonly options: DictationServiceOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.#phaseOneSchema = (
      options.coreDatabase.prepare("PRAGMA table_info(dictation_requests)").all() as Array<{
        name: string;
      }>
    ).some(({ name }) => name === "request_ref");
  }

  async process(input: {
    accessToken: string;
    openAudio(signal: AbortSignal): Promise<DictationAudioUpload>;
    signal?: AbortSignal;
  }): Promise<DictationResult> {
    const identity = await this.options.authService.authenticateAccessToken(
      input.accessToken,
    );
    if (this.#activeAccounts.has(identity.accountId)) {
      throw new DictationFailure("TOO_MANY_REQUESTS", 429, 1);
    }
    this.#activeAccounts.add(identity.accountId);
    const sessionOperation = this.options.sessionOperations.register(
      identity.sessionId,
    );
    const signal =
      input.signal === undefined
        ? sessionOperation.signal
        : AbortSignal.any([sessionOperation.signal, input.signal]);
    let requestRef: string | undefined;
    let internalRequestId: string | undefined;
    let metadataCreated = false;
    let usageTicket: BillingUsageTicket | undefined;
    let usageTerminal = false;
    const finalization: FinalizationState = {
      lease: undefined,
      contentTransactionOwned: false,
      coreTransactionOwned: false,
    };
    const state: { errorStage: ErrorStage } = {
      errorStage: "upload",
    };
    let cleanupResult:
      | "pending"
      | "succeeded"
      | "failed"
      | "not_required" = "not_required";
    const totalStarted = this.#monotonicNow();

    try {
      this.#finalizationQueue.assertHealthy();
      this.throwIfCancelled(
        sessionOperation.signal,
        input.signal,
      );
      const confirmed =
        await this.options.authService.authenticateAccessToken(
          input.accessToken,
        );
      if (!sameIdentity(identity, confirmed)) {
        throw new DictationFailure("AUTH_REQUIRED", 401);
      }
      this.throwIfCancelled(
        sessionOperation.signal,
        input.signal,
      );

      requestRef = randomUUID();
      internalRequestId = this.#phaseOneSchema
        ? allocateRuntimeEntityId(true, this.options.internalId)
        : requestRef;
      const activeRequestId = internalRequestId;
      const activeRequestRef = requestRef;
      const createdAt = this.#now();
      this.options.coreDatabase
        .prepare(
          `INSERT INTO dictation_requests (
            id, ${this.#phaseOneSchema ? "request_ref," : ""}
            user_id, session_id, status,
            asr_model, rewrite_model, temporary_cleanup_result, created_at
          ) VALUES (?, ${this.#phaseOneSchema ? "?," : ""}
            ?, ?, 'processing', ?, ?, 'not_required', ?)`,
        )
        .run(
          activeRequestId,
          ...(this.#phaseOneSchema ? [activeRequestRef] : []),
          identity.accountId,
          identity.sessionId,
          this.options.asrModel,
          this.options.rewriteModel,
          createdAt.toISOString(),
        );
      metadataCreated = true;

      if (this.options.billingUsage !== undefined) {
        usageTicket = this.options.billingUsage.begin({
          userId: identity.accountId,
          requestId: activeRequestRef,
        });
      }

      let upload: DictationAudioUpload;
      try {
        upload = await input.openAudio(signal);
      } catch (error) {
        throw error instanceof DictationFailure
          ? error
          : new DictationFailure("AUDIO_INVALID", 400);
      }
      if (
        upload.fieldname !== "audio" ||
        !acceptedWaveMimeTypes.has(upload.mimetype.toLowerCase())
      ) {
        throw new DictationFailure("AUDIO_INVALID", 400);
      }

      const result = await withTemporaryAudio(
        {
          directory: this.options.temporaryAudioDirectory,
          source: upload.stream,
          signal,
          onCreated: () => {
            cleanupResult = "pending";
            this.updateCleanupResult(activeRequestId, cleanupResult);
          },
          onCleanup: (outcome) => {
            cleanupResult = outcome;
            this.updateCleanupResult(activeRequestId, cleanupResult);
          },
        },
        async (temporaryAudio) => {
          this.throwIfCancelled(
            sessionOperation.signal,
            input.signal,
          );
          state.errorStage = "audio_validation";
          const audio = await validateWaveFile(temporaryAudio.path);
          this.options.coreDatabase
            .prepare(
              `UPDATE dictation_requests
               SET duration_ms = ?, audio_bytes = ?
               WHERE id = ? AND status = 'processing'`,
            )
            .run(
              Math.ceil(audio.durationMs),
              audio.audioBytes,
              activeRequestId,
            );

          this.throwIfCancelled(
            sessionOperation.signal,
            input.signal,
          );
          state.errorStage = "asr";
          const asrStarted = this.#monotonicNow();
          let recognized;
          try {
            recognized =
              await this.options.speechRecognitionProvider.recognize({
                audioPath: temporaryAudio.path,
                pcmDataOffset: audio.pcmDataOffset,
                pcmDataLength: audio.pcmDataLength,
                durationMs: audio.durationMs,
                signal,
              });
          } catch (error) {
            this.throwIfCancelled(
              sessionOperation.signal,
              input.signal,
            );
            throw error;
          }
          const asrMs = milliseconds(
            asrStarted,
            this.#monotonicNow(),
          );
          this.throwIfCancelled(
            sessionOperation.signal,
            input.signal,
          );
          let rawTranscript: string;
          try {
            rawTranscript = validRawTranscript(recognized.text);
          } catch {
            throw new DictationFailure("ASR_FAILED", 500);
          }

          state.errorStage = "rewrite";
          const rewriteStarted = this.#monotonicNow();
          let rewritten;
          try {
            rewritten = await this.options.textRewriteProvider.rewrite({
              rawTranscript,
              signal,
            });
          } catch (error) {
            this.throwIfCancelled(
              sessionOperation.signal,
              input.signal,
            );
            throw error;
          }
          const rewriteMs = milliseconds(
            rewriteStarted,
            this.#monotonicNow(),
          );
          this.throwIfCancelled(
            sessionOperation.signal,
            input.signal,
          );
          let finalText: string;
          try {
            finalText = validateFinalText(rewritten.finalText);
          } catch {
            throw new DictationFailure("REWRITE_FAILED", 500);
          }

          state.errorStage = "response";
          finalization.lease =
            await this.#finalizationQueue.acquire(signal);
          this.throwIfCancelled(
            sessionOperation.signal,
            input.signal,
          );
          if (
            this.options.contentDatabase.inTransaction ||
            this.options.coreDatabase.inTransaction
          ) {
            throw new Error(
              "Finalization database transaction already active",
            );
          }
          const completedAt = this.#now();
          try {
            this.options.contentDatabase.exec("BEGIN IMMEDIATE");
          } catch (error) {
            finalization.contentTransactionOwned =
              this.options.contentDatabase.inTransaction;
            throw error;
          }
          if (!this.options.contentDatabase.inTransaction) {
            throw new Error("Content database transaction did not begin");
          }
          finalization.contentTransactionOwned = true;
          storeEncryptedContentPair({
            database: this.options.contentDatabase,
            cipher: this.options.contentCipher,
            requestId: activeRequestRef,
            rawTranscript,
            finalText,
            completedAt,
            retentionDays: this.options.contentRetentionDays,
            ...(this.options.internalId === undefined
              ? {}
              : { internalId: this.options.internalId }),
          });
          this.throwIfCancelled(
            sessionOperation.signal,
            input.signal,
          );
          return Object.freeze({
            finalText,
            asrMs,
            rewriteMs,
            rawCharacterCount: [...rawTranscript].length,
            finalCharacterCount: [...finalText].length,
            inputTokens: rewritten.inputTokens,
            outputTokens: rewritten.outputTokens,
            pcmDataLength: audio.pcmDataLength,
            completedAt,
          }) satisfies PreparedDictation;
        },
      );
      this.throwIfCancelled(
        sessionOperation.signal,
        input.signal,
      );
      if (!this.updateCleanupResult(activeRequestId, "succeeded")) {
        throw new TemporaryAudioCleanupFailure();
      }
      this.throwIfCancelled(
        sessionOperation.signal,
        input.signal,
      );
      if (
        !finalization.contentTransactionOwned ||
        !this.options.contentDatabase.inTransaction ||
        finalization.lease === undefined
      ) {
        finalization.lease?.poison();
        throw new Error("Finalization content transaction lost ownership");
      }
      if (this.options.coreDatabase.inTransaction) {
        throw new Error("Core database transaction already active");
      }
      try {
        this.options.coreDatabase.exec("BEGIN IMMEDIATE");
      } catch (error) {
        finalization.coreTransactionOwned =
          this.options.coreDatabase.inTransaction;
        throw error;
      }
      if (!this.options.coreDatabase.inTransaction) {
        throw new Error("Core database transaction did not begin");
      }
      finalization.coreTransactionOwned = true;
      const totalMs = milliseconds(
        totalStarted,
        this.#monotonicNow(),
      );
      const update = this.options.coreDatabase
        .prepare(
          `UPDATE dictation_requests
           SET status = 'completed',
               asr_ms = ?, rewrite_ms = ?, total_ms = ?,
               raw_character_count = ?,
               final_character_count = ?,
               input_token_count = ?,
               output_token_count = ?,
               completed_at = ?
           WHERE id = ? AND status = 'processing'`,
        )
        .run(
          result.asrMs,
          result.rewriteMs,
          totalMs,
          result.rawCharacterCount,
          result.finalCharacterCount,
          result.inputTokens,
          result.outputTokens,
          result.completedAt.toISOString(),
          activeRequestId,
        );
      if (update.changes !== 1) {
        throw new Error("Dictation completion metadata failed");
      }
      this.throwIfCancelled(
        sessionOperation.signal,
        input.signal,
      );

      try {
        this.options.contentDatabase.exec("COMMIT");
      } catch (error) {
        if (!this.options.contentDatabase.inTransaction) {
          finalization.contentTransactionOwned = false;
        }
        throw error;
      }
      if (this.options.contentDatabase.inTransaction) {
        throw new Error("Content database transaction did not commit");
      }
      finalization.contentTransactionOwned = false;

      try {
        this.options.coreDatabase.exec("COMMIT");
      } catch (error) {
        if (!this.options.coreDatabase.inTransaction) {
          finalization.coreTransactionOwned = false;
        }
        throw error;
      }
      if (this.options.coreDatabase.inTransaction) {
        throw new Error("Core database transaction did not commit");
      }
      finalization.coreTransactionOwned = false;
      if (this.options.billingUsage !== undefined && usageTicket !== undefined) {
        usageTerminal = true;
        this.options.billingUsage.settle(usageTicket, {
          uploadedPcmBytes: result.pcmDataLength,
          outcome: "usable_text",
          dictationRequestId: activeRequestId,
        });
      }
      return Object.freeze({
        requestId: activeRequestRef,
        finalText: result.finalText,
        asrMs: result.asrMs,
        rewriteMs: result.rewriteMs,
        totalMs,
      });
    } catch (error) {
      let rollbackError: unknown;
      let poisonFinalization = false;
      if (finalization.coreTransactionOwned) {
        try {
          if (!this.options.coreDatabase.inTransaction) {
            throw new Error(
              "Owned core database transaction ended unexpectedly",
            );
          }
          this.options.coreDatabase.exec("ROLLBACK");
          if (this.options.coreDatabase.inTransaction) {
            throw new Error(
              "Core database transaction did not roll back",
            );
          }
          finalization.coreTransactionOwned = false;
        } catch (rollbackFailure) {
          rollbackError = rollbackFailure;
          poisonFinalization = true;
        }
      }
      if (finalization.contentTransactionOwned) {
        try {
          if (!this.options.contentDatabase.inTransaction) {
            throw new Error(
              "Owned content database transaction ended unexpectedly",
            );
          }
          this.options.contentDatabase.exec("ROLLBACK");
          if (this.options.contentDatabase.inTransaction) {
            throw new Error(
              "Content database transaction did not roll back",
            );
          }
          finalization.contentTransactionOwned = false;
        } catch (rollbackFailure) {
          rollbackError ??= rollbackFailure;
          poisonFinalization = true;
        }
      }
      if (poisonFinalization) {
        finalization.lease?.poison();
      }
      const failure =
        rollbackError === undefined
          ? this.mapFailure(
              error,
              state.errorStage,
              sessionOperation.signal,
              input.signal,
            )
          : new DictationFailure("SERVICE_UNAVAILABLE", 503);
      if (metadataCreated && internalRequestId !== undefined) {
        const cancelled =
          sessionOperation.signal.aborted ||
          input.signal?.aborted === true;
        try {
          this.options.coreDatabase
            .prepare(
              `UPDATE dictation_requests
               SET status = ?,
                   error_stage = ?,
                   error_code = ?,
                   total_ms = ?,
                   temporary_cleanup_result = ?,
                   completed_at = ?
               WHERE id = ? AND status = 'processing'`,
            )
            .run(
              cancelled ? "cancelled" : "failed",
              cancelled ? "cancel" : state.errorStage,
              failure.code,
              milliseconds(totalStarted, this.#monotonicNow()),
              cleanupResult,
              this.#now().toISOString(),
              internalRequestId,
            );
        } catch {
          // Failure metadata is content-free and must not mask the safe error.
        }
      }
      throw failure;
    } finally {
      if (
        !usageTerminal &&
        usageTicket !== undefined &&
        this.options.billingUsage !== undefined
      ) {
        usageTerminal = true;
        try {
          this.options.billingUsage.abandon(usageTicket);
        } catch {
          // Usage release is best-effort and cannot mask the safe primary result.
        }
      }
      finalization.lease?.release();
      sessionOperation.complete();
      this.#activeAccounts.delete(identity.accountId);
    }
  }

  private throwIfCancelled(
    sessionSignal: AbortSignal,
    callerSignal: AbortSignal | undefined,
  ): void {
    if (sessionSignal.aborted) {
      const reason = sessionSignal.reason;
      if (
        reason instanceof SessionOperationRevoked &&
        reason.reason === "replaced"
      ) {
        throw new DictationFailure("SESSION_REPLACED", 401);
      }
      if (
        reason instanceof SessionOperationRevoked &&
        reason.reason === "disabled"
      ) {
        throw new DictationFailure("ACCOUNT_DISABLED", 403);
      }
      throw new DictationFailure("AUTH_REQUIRED", 401);
    }
    if (callerSignal?.aborted === true) {
      throw new DictationFailure("SERVICE_UNAVAILABLE", 503);
    }
  }

  private mapFailure(
    error: unknown,
    stage: ErrorStage,
    sessionSignal: AbortSignal,
    callerSignal: AbortSignal | undefined,
  ): DictationFailure | AuthFailure {
    try {
      this.throwIfCancelled(sessionSignal, callerSignal);
    } catch (cancelled) {
      return cancelled as DictationFailure;
    }
    if (error instanceof AuthFailure || error instanceof DictationFailure) {
      return error;
    }
    if (
      error instanceof BillingFailure &&
      error.code === "BILLING_QUOTA_EXHAUSTED"
    ) {
      return new DictationFailure("BILLING_QUOTA_EXHAUSTED", 402);
    }
    if (error instanceof BillingFailure) {
      return new DictationFailure("SERVICE_UNAVAILABLE", 503);
    }
    if (error instanceof AudioValidationFailure) {
      return new DictationFailure("AUDIO_INVALID", 400);
    }
    if (error instanceof TemporaryAudioAborted) {
      return new DictationFailure("SERVICE_UNAVAILABLE", 503);
    }
    if (
      error instanceof ProviderError &&
      error.code === "PROVIDER_CONFIGURATION_REJECTED"
    ) {
      return new DictationFailure("SERVICE_UNAVAILABLE", 503);
    }
    if (
      error instanceof TemporaryAudioCleanupFailure ||
      stage === "response"
    ) {
      return new DictationFailure("SERVICE_UNAVAILABLE", 503);
    }
    if (stage === "asr") {
      return new DictationFailure("ASR_FAILED", 500);
    }
    if (stage === "rewrite") {
      return new DictationFailure("REWRITE_FAILED", 500);
    }
    if (stage === "upload") {
      return new DictationFailure(
        "SERVICE_UNAVAILABLE",
        503,
      );
    }
    return new DictationFailure("SERVICE_UNAVAILABLE", 503);
  }

  private updateCleanupResult(
    requestId: string,
    result: "pending" | "succeeded" | "failed",
  ): boolean {
    try {
      this.options.coreDatabase
        .prepare(
          `UPDATE dictation_requests
           SET temporary_cleanup_result = ?
           WHERE id = ?`,
        )
        .run(result, requestId);
      return true;
    } catch {
      // Cleanup itself continues even when content-free metadata is unavailable.
      return false;
    }
  }

}
