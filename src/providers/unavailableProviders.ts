import {
  ProviderError,
  type SpeechRecognitionProvider,
  type TextRewriteProvider,
} from "./providerTypes.js";

export class UnavailableSpeechRecognitionProvider
  implements SpeechRecognitionProvider
{
  async recognize(
    _input: Parameters<SpeechRecognitionProvider["recognize"]>[0],
  ): ReturnType<SpeechRecognitionProvider["recognize"]> {
    throw new ProviderError({
      stage: "asr",
      code: "PROVIDER_CONFIGURATION_REJECTED",
    });
  }
}

export class UnavailableTextRewriteProvider
  implements TextRewriteProvider
{
  async rewrite(
    _input: Parameters<TextRewriteProvider["rewrite"]>[0],
  ): ReturnType<TextRewriteProvider["rewrite"]> {
    throw new ProviderError({
      stage: "rewrite",
      code: "PROVIDER_CONFIGURATION_REJECTED",
    });
  }
}
