import { describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { generateInternalId } from "../src/ids/internalId.js";
import { ProviderError, type ProviderErrorCode } from "../src/providers/providerTypes.js";
import { StreamingDictationSession } from "../src/realtime/streamingDictationSession.js";
import type { StreamingProviderSession } from "../src/realtime/streamingProvider.js";
import type { StreamingRouteSelector } from "../src/realtime/asrModelRouter.js";
import { encodeServerControl, parseClientControl, parseServerControl, REALTIME_PROTOCOL, type ServerControl } from "../src/realtime/realtimeProtocol.js";

async function runSession(options: { capability: boolean; failure: ProviderErrorCode | "empty-stream" | "timeout"; partial?: boolean; beforeFinish?: boolean }) {
  let finish!: () => void;
  let cancel!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const cancelled = new Promise<void>((resolve) => { cancel = resolve; });
  const messages: ServerControl[] = [];
  const usage = { abandon: vi.fn(), settle: vi.fn() };
  const sessionHandle: StreamingProviderSession = {
    sendAudio: async () => undefined,
    finish: async () => { finish(); },
    cancel: vi.fn(() => { cancel(); }),
    async *events() {
      if (!options.beforeFinish) await Promise.race([finished, cancelled]);
      if (options.partial) yield { type: "partial", text: randomBytes(8).toString("hex") };
      if (options.failure === "timeout") { await cancelled; return; }
      if (options.failure === "empty-stream") return;
      throw new ProviderError({ stage: "asr", code: options.failure });
    },
  };
  const selection = { routeId: randomUUID(), provider: { open: async () => sessionHandle }, publicDescriptor: { routeVersion: 1 as const } };
  const router: StreamingRouteSelector = {
    select: () => selection,
    replaceAfterOpenFailure: () => undefined,
    reportReady: vi.fn(), reportFailure: vi.fn(), release: vi.fn(() => true),
  };
  const session = new StreamingDictationSession({
    noSpeechCapability: options.capability, requestId: randomUUID(),
    identity: { accountId: generateInternalId(), sessionId: generateInternalId(), deviceId: randomUUID() },
    router, usage, signal: new AbortController().signal, finalTimeoutMs: 25, upstreamOpenTimeoutMs: 100,
    textRewriteProvider: { rewrite: async () => { throw new Error("Unexpected text rewrite"); } },
    emit: async (message) => { messages.push(parseServerControl(encodeServerControl(message))); },
  });
  try {
    await session.receiveControl(parseClientControl(JSON.stringify({
      type: "session.start", protocol: REALTIME_PROTOCOL,
      audio: { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 }, mode: "verbatim",
    })));
    if (!options.beforeFinish) {
      await session.receiveAudio(randomBytes(640));
      await session.receiveControl({ type: "session.finish" });
    }
    await vi.waitFor(() => expect(messages.at(-1)?.type).toBe("session.ended"), { timeout: 1000, interval: 5 });
    const terminalCount = messages.length;
    await session.receiveControl({ type: "session.finish" });
    await session.receiveAudio(randomBytes(640));
    expect(messages).toHaveLength(terminalCount);
    expect(messages.filter(({ type }) => type === "session.failed")).toHaveLength(1);
    expect(messages.filter(({ type }) => type === "session.ended")).toHaveLength(1);
    expect(usage.abandon).toHaveBeenCalledTimes(1);
    expect(usage.settle).not.toHaveBeenCalled();
    expect(router.release).toHaveBeenCalledTimes(1);
    expect(sessionHandle.cancel).toHaveBeenCalledTimes(1);
    return { messages, router };
  } finally { await session.disconnect(); }
}

describe("community realtime no-speech negotiation", () => {
  it("round-trips NO_SPEECH as a stable protocol failure", () => {
    const message: ServerControl = { type: "session.failed", code: "NO_SPEECH" };
    expect(parseServerControl(encodeServerControl(message))).toEqual(message);
  });

  it("reports explicit empty ASR output as NO_SPEECH only after an opted-in client finishes", async () => {
    const result = await runSession({ capability: true, failure: "PROVIDER_EMPTY_OUTPUT" });
    expect(result.messages).toContainEqual({ type: "session.failed", code: "NO_SPEECH" });
    expect(result.router.reportFailure).toHaveBeenCalledWith(expect.any(String), { kind: "no_speech" });
  });

  it("preserves the existing failure code for a client without the capability", async () => {
    const result = await runSession({ capability: false, failure: "PROVIDER_EMPTY_OUTPUT" });
    expect(result.messages).toContainEqual({ type: "session.failed", code: "UPSTREAM_UNAVAILABLE" });
  });

  it.each(["PROVIDER_REQUEST_FAILED", "PROVIDER_TIMEOUT", "PROVIDER_PROTOCOL_ERROR", "empty-stream"] as const)(
    "does not disguise an upstream fault (%s) as no speech", async (failure) => {
      const result = await runSession({ capability: true, failure });
      expect(result.messages).toContainEqual({ type: "session.failed", code: "UPSTREAM_UNAVAILABLE" });
    },
  );

  it("keeps FINAL_TIMEOUT when an upstream never returns a final result", async () => {
    const result = await runSession({ capability: true, failure: "timeout" });
    expect(result.messages).toContainEqual({ type: "session.failed", code: "FINAL_TIMEOUT" });
  });

  it("does not suppress a failure after partial text has already arrived", async () => {
    const result = await runSession({ capability: true, failure: "PROVIDER_EMPTY_OUTPUT", partial: true });
    expect(result.messages.some(({ type }) => type === "transcript.partial")).toBe(true);
    expect(result.messages).toContainEqual({ type: "session.failed", code: "UPSTREAM_UNAVAILABLE" });
  });

  it("does not turn an empty-output failure before client finish into no speech", async () => {
    const result = await runSession({ capability: true, failure: "PROVIDER_EMPTY_OUTPUT", beforeFinish: true });
    expect(result.messages).toContainEqual({ type: "session.failed", code: "UPSTREAM_UNAVAILABLE" });
  });
});
