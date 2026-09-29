import { createHash } from "node:crypto";
import { z } from "zod";

export const REALTIME_PROTOCOL =
  "community.realtime-dictation.v1" as const;

export const REALTIME_SESSION_MODES = [
  "smart",
  "verbatim",
  "dictation",
] as const;

export type RealtimeSessionMode =
  (typeof REALTIME_SESSION_MODES)[number];

export const REALTIME_RESULT_MODES = [
  "smart",
  "verbatim",
  "verbatim_fallback",
] as const;

export type RealtimeResultMode =
  (typeof REALTIME_RESULT_MODES)[number];

export const REALTIME_FALLBACK_REASONS = [
  "text_optimization_timeout",
  "text_optimization_provider_failed",
  "text_optimization_empty_result",
  "text_optimization_fidelity_rejected",
  // Accepted for wire compatibility with earlier v5 Desktop candidates.
  "text_optimization_failed",
] as const;

export type RealtimeFallbackReason =
  (typeof REALTIME_FALLBACK_REASONS)[number];

export const TXCHAT_TEXT_OPTIMIZATION_PROMPT_VERSION =
  "txchat-smart-organize-multilingual-v5" as const;
export const TXCHAT_TEXT_OPTIMIZATION_PROMPT_SHA256 =
  "9851d2057f8208b73fdb3a26ea9a87e1f45910ac2c42d8c9c57b7516fc63d799" as const;
export const TXCHAT_TEXT_OPTIMIZATION_PROMPT_UTF8_BYTES = 1_795 as const;

export type RealtimeTextOptimizationPrompt = Readonly<{
  version: typeof TXCHAT_TEXT_OPTIMIZATION_PROMPT_VERSION;
  sha256: typeof TXCHAT_TEXT_OPTIMIZATION_PROMPT_SHA256;
  utf8Bytes: typeof TXCHAT_TEXT_OPTIMIZATION_PROMPT_UTF8_BYTES;
  content: string;
}>;

export const REALTIME_FAILURE_CODES = [
  "AUTH_REQUIRED",
  "SESSION_REPLACED",
  "SESSION_EXPIRED",
  "ACCOUNT_DISABLED",
  "TOO_MANY_REQUESTS",
  "BILLING_QUOTA_EXHAUSTED",
  "PROTOCOL_ERROR",
  "AUDIO_LIMIT_EXCEEDED",
  "UPSTREAM_UNAVAILABLE",
  "FINAL_TIMEOUT",
  // Emitted only for clients opting into no-speech-v1.
  "NO_SPEECH",
] as const;

export type RealtimeFailureCode =
  (typeof REALTIME_FAILURE_CODES)[number];

export type ClientControl =
  | Readonly<{
      type: "session.start";
      protocol: typeof REALTIME_PROTOCOL;
      audio: Readonly<{
        encoding: "pcm_s16le";
        sampleRate: 16_000;
        channels: 1;
      }>;
      mode: RealtimeSessionMode;
      textOptimization?: Readonly<{
        prompt: RealtimeTextOptimizationPrompt;
      }>;
    }>
  | Readonly<{ type: "session.finish" }>
  | Readonly<{ type: "session.cancel" }>;

export type ServerControl =
  | Readonly<{ type: "session.started"; requestId: string }>
  | Readonly<{ type: "transcript.partial"; text: string }>
  | Readonly<{ type: "transcript.organizing" }>
  | Readonly<{
      type: "transcript.final";
      text: string;
      resultMode?: Exclude<RealtimeResultMode, "verbatim_fallback">;
    }>
  | Readonly<{
      type: "transcript.final";
      text: string;
      resultMode: "verbatim_fallback";
      fallbackReason: RealtimeFallbackReason;
    }>
  | Readonly<{ type: "session.failed"; code: RealtimeFailureCode }>
  | Readonly<{ type: "session.ended" }>;

const MAXIMUM_CONTROL_CHARACTERS = 4_096;
const MAXIMUM_TRANSCRIPT_CODE_POINTS = 20_000;

const audioSchema = z.strictObject({
  encoding: z.literal("pcm_s16le"),
  sampleRate: z.literal(16_000),
  channels: z.literal(1),
});

const textOptimizationPromptSchema = z
  .strictObject({
    version: z.literal(TXCHAT_TEXT_OPTIMIZATION_PROMPT_VERSION),
    sha256: z.literal(TXCHAT_TEXT_OPTIMIZATION_PROMPT_SHA256),
    utf8Bytes: z.literal(TXCHAT_TEXT_OPTIMIZATION_PROMPT_UTF8_BYTES),
    content: z.string().min(1).max(4_096),
  })
  .superRefine((prompt, context) => {
    const byteLength = Buffer.byteLength(prompt.content, "utf8");
    const digest = createHash("sha256")
      .update(prompt.content, "utf8")
      .digest("hex");
    if (
      byteLength !== prompt.utf8Bytes ||
      digest !== prompt.sha256 ||
      prompt.content.includes("\r") ||
      prompt.content.split("\n").length !== 25 ||
      !prompt.content.startsWith(`[prompt:${prompt.version}]\n`)
    ) {
      context.addIssue({
        code: "custom",
        message: "invalid text optimization prompt",
      });
    }
  });

const textOptimizationSchema = z.strictObject({
  prompt: textOptimizationPromptSchema,
});

const clientControlSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("session.start"),
    protocol: z.literal(REALTIME_PROTOCOL),
    audio: audioSchema,
    mode: z.enum(REALTIME_SESSION_MODES),
    textOptimization: textOptimizationSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("session.finish"),
  }),
  z.strictObject({
    type: z.literal("session.cancel"),
  }),
]);

function isDisallowedControl(codePoint: number): boolean {
  return (
    (codePoint < 0x20 &&
      codePoint !== 0x09 &&
      codePoint !== 0x0a &&
      codePoint !== 0x0d) ||
    (codePoint >= 0x7f && codePoint <= 0x9f)
  );
}

const transcriptSchema = z.string().superRefine((value, context) => {
  let codePoints = 0;
  for (const character of value) {
    codePoints += 1;
    if (
      codePoints > MAXIMUM_TRANSCRIPT_CODE_POINTS ||
      isDisallowedControl(character.codePointAt(0) ?? 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "invalid transcript",
      });
      return;
    }
  }
  if (value.trim().length === 0) {
    context.addIssue({
      code: "custom",
      message: "invalid transcript",
    });
  }
});

const serverControlSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("session.started"),
    requestId: z.uuid(),
  }),
  z.strictObject({
    type: z.literal("transcript.partial"),
    text: transcriptSchema,
  }),
  z.strictObject({
    type: z.literal("transcript.organizing"),
  }),
  z.strictObject({
    type: z.literal("transcript.final"),
    text: transcriptSchema,
    resultMode: z.enum(REALTIME_RESULT_MODES).optional(),
    fallbackReason: z.enum(REALTIME_FALLBACK_REASONS).optional(),
  }),
  z.strictObject({
    type: z.literal("session.failed"),
    code: z.enum(REALTIME_FAILURE_CODES),
  }),
  z.strictObject({
    type: z.literal("session.ended"),
  }),
]);

export class RealtimeProtocolError extends Error {
  constructor() {
    super("Invalid realtime dictation protocol message");
    this.name = "RealtimeProtocolError";
  }
}

function deepFreezeClient(message: ClientControl): ClientControl {
  if (message.type !== "session.start") {
    return Object.freeze(message);
  }
  const textOptimization = message.textOptimization === undefined
    ? undefined
    : Object.freeze({
        prompt: Object.freeze({ ...message.textOptimization.prompt }),
      });
  return Object.freeze({
    ...message,
    audio: Object.freeze({ ...message.audio }),
    ...(textOptimization === undefined ? {} : { textOptimization }),
  });
}

function hasValidFinalRelation(message: object): boolean {
  const candidate = message as {
    type?: string;
    resultMode?: string;
    fallbackReason?: string;
  };
  if (candidate.type !== "transcript.final") {
    return candidate.resultMode === undefined &&
      candidate.fallbackReason === undefined;
  }
  return candidate.resultMode === "verbatim_fallback"
    ? candidate.fallbackReason !== undefined
    : candidate.fallbackReason === undefined;
}

export function parseClientControl(message: string): ClientControl {
  if (
    typeof message !== "string" ||
    message.length === 0 ||
    message.length > MAXIMUM_CONTROL_CHARACTERS
  ) {
    throw new RealtimeProtocolError();
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(message);
  } catch {
    throw new RealtimeProtocolError();
  }
  const parsed = clientControlSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new RealtimeProtocolError();
  }
  const control = parsed.data as ClientControl;
  if (
    control.type === "session.start" &&
    control.mode !== "smart" &&
    control.textOptimization !== undefined
  ) {
    throw new RealtimeProtocolError();
  }
  return deepFreezeClient(control);
}

export function encodeServerControl(message: ServerControl): string {
  const parsed = serverControlSchema.safeParse(message);
  if (!parsed.success || !hasValidFinalRelation(parsed.data)) {
    throw new RealtimeProtocolError();
  }
  return JSON.stringify(parsed.data);
}

export function parseServerControl(message: string): ServerControl {
  if (
    typeof message !== "string" ||
    message.length === 0 ||
    message.length > MAXIMUM_CONTROL_CHARACTERS
  ) {
    throw new RealtimeProtocolError();
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(message);
  } catch {
    throw new RealtimeProtocolError();
  }
  const parsed = serverControlSchema.safeParse(candidate);
  if (!parsed.success || !hasValidFinalRelation(parsed.data)) {
    throw new RealtimeProtocolError();
  }
  return Object.freeze(parsed.data as ServerControl);
}
