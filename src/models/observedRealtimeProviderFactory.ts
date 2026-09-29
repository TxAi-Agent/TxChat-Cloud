import {
  ContentFreeMetrics,
  observeStreamingASRProvider,
} from "../observability/metrics.js";
import type { StreamingASRProvider } from "../realtime/streamingProvider.js";
import {
  type RealtimeProviderFactory,
  RealtimeProviderFactoryError,
} from "./realtimeProviderFactory.js";

export class ObservedRealtimeProviderFactory
  implements RealtimeProviderFactory
{
  readonly #rawProviders = new WeakMap<
    StreamingASRProvider,
    StreamingASRProvider
  >();

  constructor(
    private readonly inner: RealtimeProviderFactory,
    private readonly metrics: ContentFreeMetrics,
  ) {
    if (
      inner === null ||
      typeof inner !== "object" ||
      typeof inner.create !== "function" ||
      typeof inner.validate !== "function" ||
      !(metrics instanceof ContentFreeMetrics)
    ) {
      throw new RealtimeProviderFactoryError("INVALID_CONFIGURATION");
    }
  }

  create(
    input: Parameters<RealtimeProviderFactory["create"]>[0],
  ): StreamingASRProvider {
    const raw = this.inner.create(input);
    const observed = observeStreamingASRProvider(raw, this.metrics);
    this.#rawProviders.set(observed, raw);
    return observed;
  }

  async validate(
    provider: StreamingASRProvider,
    signal: AbortSignal,
  ): Promise<void> {
    const raw = this.#rawProviders.get(provider);
    if (raw === undefined) {
      throw new RealtimeProviderFactoryError("INVALID_CONFIGURATION");
    }
    await this.inner.validate(raw, signal);
  }
}
