export type StreamingProviderEvent =
  | Readonly<{ type: "partial"; text: string }>
  | Readonly<{
      type: "final";
      text: string;
      providerRequestId?: string;
    }>;

export interface StreamingProviderSession {
  sendAudio(frame: Uint8Array): Promise<void>;
  finish(): Promise<void>;
  cancel(): void;
  events(): AsyncIterable<StreamingProviderEvent>;
}

export interface StreamingASRProvider {
  open(input: {
    requestId: string;
    signal: AbortSignal;
  }): Promise<StreamingProviderSession>;
}
