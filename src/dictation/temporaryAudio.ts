import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";

import {
  AUDIO_HTTP_BODY_MAX_BYTES,
  AudioValidationFailure,
} from "./audioValidation.js";

const TEMPORARY_FILE_MODE = 0o600;
const STARTUP_MAXIMUM_AGE_MS = 10 * 60_000;

export type TemporaryAudioFile = Readonly<{
  path: string;
  bytes: number;
}>;

export class TemporaryAudioAborted extends Error {
  constructor() {
    super("Temporary audio operation aborted");
    this.name = "TemporaryAudioAborted";
  }
}

export class TemporaryAudioCleanupFailure extends Error {
  constructor() {
    super("Temporary audio cleanup failed");
    this.name = "TemporaryAudioCleanupFailure";
  }
}

export type TemporaryAudioOptions = Readonly<{
  directory: string;
  source: AsyncIterable<Uint8Array>;
  signal?: AbortSignal;
  onCreated?(path: string): void;
  onCleanup?(result: "succeeded" | "failed"): void;
}>;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new TemporaryAudioAborted();
  }
}

function nextWithSignal<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<T>> {
  throwIfAborted(signal);
  const pending = Promise.resolve().then(() => iterator.next());
  if (signal === undefined) {
    return pending;
  }

  return new Promise<IteratorResult<T>>((resolve, reject) => {
    let settled = false;
    const finish = (
      outcome:
        | Readonly<{ value: IteratorResult<T> }>
        | Readonly<{ error: unknown }>,
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", abort);
      if ("error" in outcome) {
        reject(outcome.error);
      } else {
        resolve(outcome.value);
      }
    };
    const abort = () => {
      finish({ error: new TemporaryAudioAborted() });
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
    pending.then(
      (value) => {
        if (signal.aborted) {
          abort();
          return;
        }
        finish({ value });
      },
      (error: unknown) => {
        finish({ error });
      },
    );
  });
}

function closeIterator(iterator: AsyncIterator<unknown>): void {
  try {
    const completion = iterator.return?.();
    if (completion !== undefined) {
      void Promise.resolve(completion).catch(() => undefined);
    }
  } catch {
    // A source cleanup failure must not replace the upload failure.
  }
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  source: AsyncIterable<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<number> {
  let totalBytes = 0;
  const iterator = source[Symbol.asyncIterator]();
  let iteratorCompleted = false;
  try {
    while (true) {
      throwIfAborted(signal);
      const next = await nextWithSignal(iterator, signal);
      if (next.done) {
        iteratorCompleted = true;
        break;
      }
      throwIfAborted(signal);
      const value = next.value;
      const chunk = Buffer.from(
        value.buffer,
        value.byteOffset,
        value.byteLength,
      );
      if (totalBytes + chunk.length > AUDIO_HTTP_BODY_MAX_BYTES) {
        throw new AudioValidationFailure();
      }
      let written = 0;
      while (written < chunk.length) {
        throwIfAborted(signal);
        const result = await handle.write(
          chunk,
          written,
          chunk.length - written,
          null,
        );
        throwIfAborted(signal);
        if (result.bytesWritten === 0) {
          throw new Error("Temporary audio write failed");
        }
        written += result.bytesWritten;
      }
      totalBytes += chunk.length;
    }
    throwIfAborted(signal);
    return totalBytes;
  } finally {
    if (!iteratorCompleted) {
      closeIterator(iterator);
    }
  }
}

export async function withTemporaryAudio<T>(
  options: TemporaryAudioOptions,
  work: (temporaryFile: TemporaryAudioFile) => Promise<T>,
): Promise<T> {
  throwIfAborted(options.signal);
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  throwIfAborted(options.signal);
  const root = await realpath(options.directory);
  throwIfAborted(options.signal);
  const filename = `${randomBytes(32).toString("hex")}.wav`;
  const path = join(root, filename);
  throwIfAborted(options.signal);
  const handle = await open(path, "wx", TEMPORARY_FILE_MODE);
  let operationError: unknown;
  let result: T | undefined;
  try {
    throwIfAborted(options.signal);
    await handle.chmod(TEMPORARY_FILE_MODE);
    throwIfAborted(options.signal);
    options.onCreated?.(path);
    const written = await writeAll(handle, options.source, options.signal);
    await handle.close();
    throwIfAborted(options.signal);
    result = await work(Object.freeze({ path, bytes: written }));
  } catch (error) {
    operationError = error;
  } finally {
    await handle.close().catch(() => undefined);
    let cleanupOutcome: "succeeded" | "failed";
    try {
      await unlink(path);
      cleanupOutcome = "succeeded";
    } catch {
      cleanupOutcome = "failed";
      if (operationError === undefined) {
        operationError = new TemporaryAudioCleanupFailure();
      }
    }
    try {
      options.onCleanup?.(cleanupOutcome);
    } catch {
      if (operationError === undefined) {
        operationError = new TemporaryAudioCleanupFailure();
      }
    }
  }

  if (operationError !== undefined) {
    throw operationError;
  }
  return result as T;
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export async function cleanupStaleTemporaryAudio(
  directory: string,
  now: Date = new Date(),
): Promise<{ removed: number }> {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Invalid temporary audio cleanup time");
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await realpath(directory);
  const entries = await readdir(root);
  const cutoff = now.getTime() - STARTUP_MAXIMUM_AGE_MS;
  let removed = 0;
  for (const name of entries) {
    const path = join(root, name);
    let statistics;
    try {
      statistics = await lstat(path);
    } catch (error) {
      if (isNotFound(error)) {
        continue;
      }
      throw error;
    }
    if (!statistics.isFile() || statistics.mtimeMs >= cutoff) {
      continue;
    }
    try {
      await unlink(path);
      removed += 1;
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
  }
  return { removed };
}
