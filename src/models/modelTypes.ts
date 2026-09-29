export type ModelCapability = "realtime-asr";

export type RuntimeProviderKind =
  | "bailian-qwen-realtime"
  | "bailian-streaming-asr";

export type ModelLifecycleState =
  | "draft"
  | "validating"
  | "standby"
  | "active"
  | "draining"
  | "unhealthy"
  | "pending_deletion";

export type ModelValidationStatus =
  | "not_tested"
  | "testing"
  | "passed"
  | "failed";

export type EncryptedModelCredential = Readonly<{
  keyVersion: string;
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}>;

export type SafeModelConfiguration = Readonly<{
  id: string;
  supersedesId: string | null;
  capability: ModelCapability;
  providerKind: RuntimeProviderKind;
  displayName: string;
  endpoint: string;
  modelId: string;
  revision: number;
  lifecycleState: ModelLifecycleState;
  validationStatus: ModelValidationStatus;
  lastValidatedAt: string | null;
  deleteWhenDrained: boolean;
  createdAt: string;
  updatedAt: string;
  credentialConfigured: boolean;
}>;

export type ModelSelection = Readonly<{
  capability: ModelCapability;
  activeModelId: string | null;
  fallbackModelId: string | null;
  updatedAt: string | null;
}>;
