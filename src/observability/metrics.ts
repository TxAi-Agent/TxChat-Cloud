import { performance } from "node:perf_hooks";

import type {
  SpeechRecognitionProvider,
  TextRewriteProvider,
} from "../providers/providerTypes.js";
import type {
  StreamingASRProvider,
  StreamingProviderSession,
} from "../realtime/streamingProvider.js";
import {
  REALTIME_FALLBACK_REASONS,
  type RealtimeFallbackReason,
} from "../realtime/realtimeProtocol.js";

const HISTOGRAM_BOUNDS_MS = Object.freeze([
  5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000,
  30_000, 60_000, 120_000, 360_000,
]);

const MAX_COUNTER = Number.MAX_SAFE_INTEGER;

export type ProviderMetricStage = "asr" | "rewrite" | "realtime_asr";
export type ProviderMetricOutcome = "success" | "failure";
type HttpStatusClass = "1xx" | "2xx" | "3xx" | "4xx" | "5xx";

export type HistogramSnapshot = Readonly<{
  count: number;
  sum: number;
  p50UpperBoundMs: number;
  p95UpperBoundMs: number;
  buckets: readonly Readonly<{
    upperBoundMs: number;
    count: number;
  }>[];
}>;

export type ContentFreeMetricsSnapshot = Readonly<{
  counters: Readonly<{
    requestsTotal: Readonly<Record<HttpStatusClass, number>>;
    providerOperationsTotal: Readonly<Record<string, number>>;
    textOptimizationFallbacksTotal: Readonly<
      Record<RealtimeFallbackReason, number>
    >;
  }>;
  histograms: Readonly<{
    requestDurationMs: HistogramSnapshot;
    providerDurationMs: Readonly<
      Record<ProviderMetricStage, HistogramSnapshot>
    >;
  }>;
  health: Readonly<{
    databases: boolean;
    temporaryAudioCleanup: boolean;
    retentionCleanup: boolean;
    consecutiveProviderFailures: number;
  }>;
}>;

function increment(value: number): number {
  return Math.min(MAX_COUNTER, value + 1);
}

function validDuration(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError("Metric duration must be finite and non-negative");
  }
  return Math.min(value, HISTOGRAM_BOUNDS_MS.at(-1)!);
}

class BoundedHistogram {
  readonly #counts = HISTOGRAM_BOUNDS_MS.map(() => 0);
  #count = 0;
  #sum = 0;

  observe(durationMs: number): void {
    const bounded = validDuration(durationMs);
    const bucketIndex = HISTOGRAM_BOUNDS_MS.findIndex(
      (upperBound) => bounded <= upperBound,
    );
    this.#counts[bucketIndex] = increment(this.#counts[bucketIndex]!);
    this.#count = increment(this.#count);
    this.#sum = Math.min(MAX_COUNTER, this.#sum + bounded);
  }

  snapshot(): HistogramSnapshot {
    const quantileUpperBound = (quantile: number): number => {
      if (this.#count === 0) {
        return 0;
      }
      const target = Math.ceil(this.#count * quantile);
      let cumulative = 0;
      for (const [index, count] of this.#counts.entries()) {
        cumulative += count;
        if (cumulative >= target) {
          return HISTOGRAM_BOUNDS_MS[index]!;
        }
      }
      return HISTOGRAM_BOUNDS_MS.at(-1)!;
    };
    const buckets = Object.freeze(
      HISTOGRAM_BOUNDS_MS.map((upperBoundMs, index) =>
        Object.freeze({
          upperBoundMs,
          count: this.#counts[index]!,
        }),
      ),
    );
    return Object.freeze({
      count: this.#count,
      sum: this.#sum,
      p50UpperBoundMs: quantileUpperBound(0.5),
      p95UpperBoundMs: quantileUpperBound(0.95),
      buckets,
    });
  }
}

function statusClass(httpStatus: number): HttpStatusClass {
  if (!Number.isSafeInteger(httpStatus) || httpStatus < 100 || httpStatus > 599) {
    throw new TypeError("Metric HTTP status is invalid");
  }
  return `${Math.floor(httpStatus / 100)}xx` as HttpStatusClass;
}

const providerStages = new Set<ProviderMetricStage>([
  "asr",
  "rewrite",
  "realtime_asr",
]);
const providerOutcomes = new Set<ProviderMetricOutcome>([
  "success",
  "failure",
]);

export class ContentFreeMetrics {
  readonly #requestsTotal: Record<HttpStatusClass, number> = {
    "1xx": 0,
    "2xx": 0,
    "3xx": 0,
    "4xx": 0,
    "5xx": 0,
  };
  readonly #providerOperationsTotal: Record<string, number> = Object.fromEntries(
    [...providerStages].flatMap((stage) =>
      [...providerOutcomes].map((outcome) => [`${stage}:${outcome}`, 0]),
    ),
  );
  readonly #textOptimizationFallbacksTotal = Object.fromEntries(
    REALTIME_FALLBACK_REASONS.map((reason) => [reason, 0]),
  ) as Record<RealtimeFallbackReason, number>;
  readonly #requestDurationMs = new BoundedHistogram();
  readonly #providerDurationMs: Record<ProviderMetricStage, BoundedHistogram> = {
    asr: new BoundedHistogram(),
    rewrite: new BoundedHistogram(),
    realtime_asr: new BoundedHistogram(),
  };
  #health = {
    databases: false,
    temporaryAudioCleanup: false,
    retentionCleanup: false,
    consecutiveProviderFailures: 0,
  };

  recordRequest(input: Readonly<{
    httpStatus: number;
    durationMs: number;
  }>): void {
    const classification = statusClass(input.httpStatus);
    const duration = validDuration(input.durationMs);
    this.#requestsTotal[classification] = increment(
      this.#requestsTotal[classification],
    );
    this.#requestDurationMs.observe(duration);
  }

  recordProviderResult(input: Readonly<{
    stage: ProviderMetricStage;
    outcome: ProviderMetricOutcome;
    durationMs: number;
  }>): void {
    if (
      !providerStages.has(input.stage) ||
      !providerOutcomes.has(input.outcome)
    ) {
      throw new TypeError("Provider metric dimension is invalid");
    }
    const duration = validDuration(input.durationMs);
    const key = `${input.stage}:${input.outcome}`;
    this.#providerOperationsTotal[key] = increment(
      this.#providerOperationsTotal[key]!,
    );
    this.#providerDurationMs[input.stage].observe(duration);
    this.#health.consecutiveProviderFailures =
      input.outcome === "success"
        ? 0
        : increment(this.#health.consecutiveProviderFailures);
  }

  recordTextOptimizationFallback(reason: RealtimeFallbackReason): void {
    if (!REALTIME_FALLBACK_REASONS.includes(reason)) {
      throw new TypeError("Text optimization fallback reason is invalid");
    }
    this.#textOptimizationFallbacksTotal[reason] = increment(
      this.#textOptimizationFallbacksTotal[reason],
    );
  }

  updateHealth(input: Readonly<{
    databases: boolean;
    temporaryAudioCleanup: boolean;
    retentionCleanup: boolean;
  }>): void {
    this.#health = {
      ...this.#health,
      databases: input.databases,
      temporaryAudioCleanup: input.temporaryAudioCleanup,
      retentionCleanup: input.retentionCleanup,
    };
  }

  snapshot(): ContentFreeMetricsSnapshot {
    const providerDurationMs = Object.freeze({
      asr: this.#providerDurationMs.asr.snapshot(),
      rewrite: this.#providerDurationMs.rewrite.snapshot(),
      realtime_asr: this.#providerDurationMs.realtime_asr.snapshot(),
    });
    return Object.freeze({
      counters: Object.freeze({
        requestsTotal: Object.freeze({ ...this.#requestsTotal }),
        providerOperationsTotal: Object.freeze({
          ...this.#providerOperationsTotal,
        }),
        textOptimizationFallbacksTotal: Object.freeze({
          ...this.#textOptimizationFallbacksTotal,
        }),
      }),
      histograms: Object.freeze({
        requestDurationMs: this.#requestDurationMs.snapshot(),
        providerDurationMs,
      }),
      health: Object.freeze({ ...this.#health }),
    });
  }
}

type MonotonicNow = () => number;

function elapsed(startedAt: number, now: MonotonicNow): number {
  return Math.max(0, now() - startedAt);
}

export function observeSpeechRecognitionProvider(
  provider: SpeechRecognitionProvider,
  metrics: ContentFreeMetrics,
  monotonicNow: MonotonicNow = () => performance.now(),
): SpeechRecognitionProvider {
  return Object.freeze({
    async recognize(
      input: Parameters<SpeechRecognitionProvider["recognize"]>[0],
    ) {
      const startedAt = monotonicNow();
      try {
        const result = await provider.recognize(input);
        metrics.recordProviderResult({
          stage: "asr",
          outcome: "success",
          durationMs: elapsed(startedAt, monotonicNow),
        });
        return result;
      } catch (error) {
        metrics.recordProviderResult({
          stage: "asr",
          outcome: "failure",
          durationMs: elapsed(startedAt, monotonicNow),
        });
        throw error;
      }
    },
  });
}

export function observeTextRewriteProvider(
  provider: TextRewriteProvider,
  metrics: ContentFreeMetrics,
  monotonicNow: MonotonicNow = () => performance.now(),
): TextRewriteProvider {
  return Object.freeze({
    async rewrite(input: Parameters<TextRewriteProvider["rewrite"]>[0]) {
      const startedAt = monotonicNow();
      try {
        const result = await provider.rewrite(input);
        metrics.recordProviderResult({
          stage: "rewrite",
          outcome: "success",
          durationMs: elapsed(startedAt, monotonicNow),
        });
        return result;
      } catch (error) {
        metrics.recordProviderResult({
          stage: "rewrite",
          outcome: "failure",
          durationMs: elapsed(startedAt, monotonicNow),
        });
        throw error;
      }
    },
  });
}

function observeStreamingSession(
  session: StreamingProviderSession,
  metrics: ContentFreeMetrics,
  startedAt: number,
  monotonicNow: MonotonicNow,
): StreamingProviderSession {
  let recorded = false;
  let cancelled = false;
  const record = (outcome: ProviderMetricOutcome) => {
    if (recorded || cancelled) {
      return;
    }
    recorded = true;
    metrics.recordProviderResult({
      stage: "realtime_asr",
      outcome,
      durationMs: elapsed(startedAt, monotonicNow),
    });
  };
  const recordFailureAndRethrow = (error: unknown): never => {
    record("failure");
    throw error;
  };

  return Object.freeze({
    async sendAudio(frame: Uint8Array) {
      try {
        await session.sendAudio(frame);
      } catch (error) {
        recordFailureAndRethrow(error);
      }
    },
    async finish() {
      try {
        await session.finish();
      } catch (error) {
        recordFailureAndRethrow(error);
      }
    },
    cancel() {
      cancelled = true;
      session.cancel();
    },
    async *events() {
      try {
        for await (const event of session.events()) {
          if (event.type === "final") {
            record("success");
          }
          yield event;
        }
        if (!recorded && !cancelled) {
          record("failure");
        }
      } catch (error) {
        recordFailureAndRethrow(error);
      }
    },
  });
}

export function observeStreamingASRProvider(
  provider: StreamingASRProvider,
  metrics: ContentFreeMetrics,
  monotonicNow: MonotonicNow = () => performance.now(),
): StreamingASRProvider {
  return Object.freeze({
    async open(input: Parameters<StreamingASRProvider["open"]>[0]) {
      const startedAt = monotonicNow();
      try {
        const session = await provider.open(input);
        return observeStreamingSession(
          session,
          metrics,
          startedAt,
          monotonicNow,
        );
      } catch (error) {
        metrics.recordProviderResult({
          stage: "realtime_asr",
          outcome: "failure",
          durationMs: elapsed(startedAt, monotonicNow),
        });
        throw error;
      }
    },
  });
}
