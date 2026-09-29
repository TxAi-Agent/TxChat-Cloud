import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createVersionedKeyRing } from "../src/auth/phoneIdentity.js";
import { SmsConfigurationCipher } from "../src/smsAdmin/smsConfigurationCipher.js";

it("protects credentials for an operator-defined SMS identity and rejects identity changes", () => {
  const cipher = new SmsConfigurationCipher(createVersionedKeyRing({
    activeVersion: "v1", keys: { v1: randomBytes(32) },
  }));
  const identity = {
    configurationId: randomUUID(), revision: 1, provider: "alibaba-cloud" as const,
    signName: randomUUID(), templateCode: `SMS_${randomInt(100000, 999999)}`,
  };
  const credentials = {
    accessKeyId: randomBytes(16).toString("hex"),
    accessKeySecret: randomBytes(32).toString("hex"),
  };
  try {
    const encrypted = cipher.encrypt({ ...identity, ...credentials });
    expect(cipher.decrypt({ ...identity, encrypted })).toEqual(credentials);
    expect(() => cipher.decrypt({ ...identity, signName: randomUUID(), encrypted })).toThrow();
    expect(encrypted.ciphertext.includes(Buffer.from(credentials.accessKeySecret))).toBe(false);
  } finally { cipher.dispose(); }
});
