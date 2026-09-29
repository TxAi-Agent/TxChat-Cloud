export class FinalizationQueuePoisoned extends Error {
  constructor() {
    super("Dictation finalization is unavailable");
    this.name = "FinalizationQueuePoisoned";
  }
}

export class FinalizationQueueCancelled extends Error {
  constructor() {
    super("Dictation finalization wait was cancelled");
    this.name = "FinalizationQueueCancelled";
  }
}

export type FinalizationLease = Readonly<{
  poison(): void;
  release(): void;
}>;

type Waiter = {
  signal: AbortSignal;
  resolve(lease: FinalizationLease): void;
  reject(error: Error): void;
  abort(): void;
};

export class FinalizationQueue {
  readonly #waiters: Waiter[] = [];
  #active = false;
  #poisoned = false;

  assertHealthy(): void {
    if (this.#poisoned) {
      throw new FinalizationQueuePoisoned();
    }
  }

  acquire(signal: AbortSignal): Promise<FinalizationLease> {
    try {
      this.assertHealthy();
    } catch (error) {
      return Promise.reject(error);
    }
    if (signal.aborted) {
      return Promise.reject(new FinalizationQueueCancelled());
    }

    return new Promise<FinalizationLease>((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.#waiters.indexOf(waiter);
          if (index === -1) {
            return;
          }
          this.#waiters.splice(index, 1);
          waiter.signal.removeEventListener("abort", waiter.abort);
          reject(new FinalizationQueueCancelled());
          this.#drain();
        },
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.#waiters.push(waiter);
      this.#drain();
    });
  }

  #drain(): void {
    if (this.#active) {
      return;
    }
    if (this.#poisoned) {
      const waiters = this.#waiters.splice(0);
      for (const waiter of waiters) {
        waiter.signal.removeEventListener("abort", waiter.abort);
        waiter.reject(new FinalizationQueuePoisoned());
      }
      return;
    }

    const waiter = this.#waiters.shift();
    if (waiter === undefined) {
      return;
    }
    waiter.signal.removeEventListener("abort", waiter.abort);
    if (waiter.signal.aborted) {
      waiter.reject(new FinalizationQueueCancelled());
      this.#drain();
      return;
    }

    this.#active = true;
    let released = false;
    waiter.resolve(
      Object.freeze({
        poison: () => {
          if (released || this.#poisoned) {
            return;
          }
          this.#poisoned = true;
          this.#drain();
        },
        release: () => {
          if (released) {
            return;
          }
          released = true;
          this.#active = false;
          this.#drain();
        },
      }),
    );
  }
}
