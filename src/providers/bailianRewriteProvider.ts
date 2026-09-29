import type { BailianRewriteModel } from "./bailianRewriteModels.js";
import {
  createProviderAbortContext,
  mapProviderFailure,
  ProviderError,
  type TextRewriteProvider,
} from "./providerTypes.js";

export const REWRITE_PROMPT_VERSION = "community-zh-fidelity-v2";

const REWRITE_SYSTEM_PROMPT = [
  `[prompt:${REWRITE_PROMPT_VERSION}]`,
  "你是中文语音转写的保真整理器，只能整理表达，不能改写内容。",
  "必须逐项保留原意、所有事实、人名、专有名词、数字、金额和日期。",
  "必须逐项保留否定关系、要求的强弱程度和原始语气。",
  "只允许删除无意义的口头语和无意义重复，优化标点、断句与必要分段，并修复明显不通顺的口语结构。",
  "不得添加原文没有的信息，不得主动删除任何有意义的信息，不得压缩为摘要。",
  "不得改成正式公文、委婉或其他语气，不得调用工具或联网，不得解释处理过程。",
  "只输出整理后的纯文本，不要标题、Markdown、引号或其他元话术。",
].join("\n");

export type BailianRewriteTransportInput = Readonly<{
  url: string;
  headers: Readonly<Record<string, string>>;
  body: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
}>;

export type BailianRewriteTransportResult = Readonly<{
  status: number;
  body: unknown;
}>;

export type BailianRewriteTransport = (
  input: BailianRewriteTransportInput,
) => Promise<BailianRewriteTransportResult>;

export type BailianRewriteProviderOptions = Readonly<{
  apiKey: string;
  baseUrl: string;
  model: BailianRewriteModel;
  timeoutMs: number;
  transport?: BailianRewriteTransport;
}>;

export const defaultBailianRewriteTransport: BailianRewriteTransport = async ({
  url,
  headers,
  body,
  signal,
}) => {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  const responseBody = await response.json().catch(() => undefined);
  return {
    status: response.status,
    body: responseBody,
  };
};

type ChatCompletionResponse = Readonly<{
  id?: unknown;
  choices?: unknown;
  usage?: unknown;
}>;

function parseRewriteResponse(
  result: BailianRewriteTransportResult,
): {
  finalText: string;
  inputTokens: number;
  outputTokens: number;
} {
  if (result.status < 200 || result.status >= 300) {
    throw new ProviderError({
      stage: "rewrite",
      code: "PROVIDER_REQUEST_FAILED",
      status: result.status,
    });
  }
  if (result.body === null || typeof result.body !== "object") {
    throw new ProviderError({
      stage: "rewrite",
      code: "PROVIDER_PROTOCOL_ERROR",
    });
  }

  const response = result.body as ChatCompletionResponse;
  const choice =
    Array.isArray(response.choices) && response.choices.length === 1
      ? response.choices[0]
      : undefined;
  const finishReason =
    choice !== null &&
    typeof choice === "object" &&
    "finish_reason" in choice &&
    typeof choice.finish_reason === "string"
      ? choice.finish_reason
      : undefined;
  if (finishReason !== "stop") {
    throw new ProviderError({
      stage: "rewrite",
      code: "PROVIDER_PROTOCOL_ERROR",
      ...(finishReason === undefined ? {} : { status: finishReason }),
    });
  }
  const message =
    choice !== null &&
    typeof choice === "object" &&
    "message" in choice &&
    choice.message !== null &&
    typeof choice.message === "object"
      ? choice.message
      : undefined;
  const content =
    message !== undefined &&
    "content" in message &&
    typeof message.content === "string"
      ? message.content.trim()
      : "";
  if (content.length === 0) {
    throw new ProviderError({
      stage: "rewrite",
      code: "PROVIDER_EMPTY_OUTPUT",
    });
  }

  const usage =
    response.usage !== null && typeof response.usage === "object"
      ? response.usage
      : undefined;
  const inputTokens =
    usage !== undefined &&
    "prompt_tokens" in usage &&
    typeof usage.prompt_tokens === "number" &&
    Number.isSafeInteger(usage.prompt_tokens) &&
    usage.prompt_tokens >= 0
      ? usage.prompt_tokens
      : undefined;
  const outputTokens =
    usage !== undefined &&
    "completion_tokens" in usage &&
    typeof usage.completion_tokens === "number" &&
    Number.isSafeInteger(usage.completion_tokens) &&
    usage.completion_tokens >= 0
      ? usage.completion_tokens
      : undefined;
  if (inputTokens === undefined || outputTokens === undefined) {
    throw new ProviderError({
      stage: "rewrite",
      code: "PROVIDER_PROTOCOL_ERROR",
    });
  }

  return {
    finalText: content,
    inputTokens,
    outputTokens,
  };
}

export class BailianRewriteProvider implements TextRewriteProvider {
  private readonly transport: BailianRewriteTransport;

  constructor(private readonly options: BailianRewriteProviderOptions) {
    this.transport = options.transport ?? defaultBailianRewriteTransport;
  }

  async rewrite(input: {
    rawTranscript: string;
    signal: AbortSignal;
    systemPrompt?: string;
  }): Promise<{
    finalText: string;
    inputTokens: number;
    outputTokens: number;
  }> {
    const abortContext = createProviderAbortContext(
      "rewrite",
      input.signal,
      this.options.timeoutMs,
    );
    try {
      if (abortContext.signal.aborted) {
        throw new Error("provider request aborted");
      }
      const result = await this.transport({
        url: `${this.options.baseUrl.replace(/\/+$/, "")}/chat/completions`,
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: {
          model: this.options.model,
          messages: [
            {
              role: "system",
              content: input.systemPrompt ?? REWRITE_SYSTEM_PROMPT,
            },
            {
              role: "user",
              content: input.rawTranscript,
            },
          ],
          temperature: 0.2,
          enable_thinking: false,
          enable_search: false,
          tools: [],
          stream: false,
        },
        signal: abortContext.signal,
      });
      return parseRewriteResponse(result);
    } catch (error) {
      throw mapProviderFailure({
        stage: "rewrite",
        error,
        parentSignal: input.signal,
        abortContext,
      });
    } finally {
      abortContext.dispose();
    }
  }
}
