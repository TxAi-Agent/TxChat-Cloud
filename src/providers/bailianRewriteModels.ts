export const BAILIAN_REWRITE_MODELS = [
  "qwen3.7-flash-2026-07-15",
  "qwen3.7-plus-2026-05-26",
] as const;

export type BailianRewriteModel =
  (typeof BAILIAN_REWRITE_MODELS)[number];

export const RECOMMENDED_BAILIAN_REWRITE_MODEL: BailianRewriteModel =
  "qwen3.7-flash-2026-07-15";
