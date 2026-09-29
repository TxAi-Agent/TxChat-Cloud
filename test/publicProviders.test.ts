import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ProductionRealtimeProviderFactory } from "../src/models/realtimeProviderFactory.js";
import { isWeChatPartnerNotifyUrl } from "../src/billing/wechatPartnerContract.js";

describe("operator configured external services", () => {
  it("accepts an operator supplied secure streaming endpoint without contacting it", () => {
    const factory = new ProductionRealtimeProviderFactory();
    expect(() => factory.create({
      providerKind: "bailian-streaming-asr",
      endpoint: "wss://speech.example.invalid/custom-stream",
      modelId: "fun-asr-realtime",
      credential: randomBytes(32).toString("hex"),
    })).not.toThrow();
  });

  it.each([
    "ws://speech.example.invalid/stream",
    "wss://speech.example.invalid/stream#fragment",
    "wss://speech.example.invalid/stream?credential=value",
  ])("rejects unsafe streaming endpoint %s", (endpoint) => {
    expect(() => new ProductionRealtimeProviderFactory().create({
      providerKind: "bailian-streaming-asr", endpoint,
      modelId: "fun-asr-realtime", credential: randomBytes(32).toString("hex"),
    })).toThrow();
  });

  it("accepts a configured HTTPS payment callback without a built-in service address", () => {
    expect(isWeChatPartnerNotifyUrl("https://payments.example.invalid/callback")).toBe(true);
    expect(isWeChatPartnerNotifyUrl("http://payments.example.invalid/callback")).toBe(false);
    expect(isWeChatPartnerNotifyUrl("https://payments.example.invalid/callback#fragment")).toBe(false);
  });
});
