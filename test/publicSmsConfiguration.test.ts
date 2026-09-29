import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { applyPublicSchema } from "../src/db/migrator.js";
import { createVersionedKeyRing } from "../src/auth/phoneIdentity.js";
import { SmsConfigurationCipher } from "../src/smsAdmin/smsConfigurationCipher.js";
import { SmsAdministrationRepository } from "../src/smsAdmin/smsAdministrationRepository.js";
import { RuntimeSmsConfigurationRegistry } from "../src/smsAdmin/runtimeSmsConfigurationRegistry.js";

it("keeps administration usable when an existing SMS configuration loses its operator settings", () => {
  const database = openDatabase(":memory:");
  applyPublicSchema(database, "core");
  const repository = new SmsAdministrationRepository(database);
  const cipher = new SmsConfigurationCipher(createVersionedKeyRing({ activeVersion: "v1", keys: { v1: randomBytes(32) } }));
  const initial = new RuntimeSmsConfigurationRegistry({ repository, cipher, signName: randomUUID(), endpoint: "sms.example.invalid" });
  try {
    const draft = initial.saveDraft({
      expectedRevision: null, templateCode: `SMS_${randomInt(100000, 999999)}`,
      accessKeyId: randomBytes(16).toString("hex"), accessKeySecret: randomBytes(32).toString("hex"),
    });
    initial.dispose();
    const unconfigured = new RuntimeSmsConfigurationRegistry({ repository, cipher });
    expect(unconfigured.isConfigured()).toBe(false);
    expect(unconfigured.safeStatus().draft?.revision).toBe(draft.revision);
    expect(unconfigured.safeStatus().draft?.secretConfigured).toBe(false);
    unconfigured.dispose();
    const changed = new RuntimeSmsConfigurationRegistry({ repository, cipher, signName: randomUUID(), endpoint: "sms.example.invalid" });
    expect(changed.isConfigured()).toBe(false);
    const replacement = changed.saveDraft({
      expectedRevision: draft.revision, templateCode: `SMS_${randomInt(100000, 999999)}`,
      accessKeyId: randomBytes(16).toString("hex"), accessKeySecret: randomBytes(32).toString("hex"),
    });
    expect(replacement.revision).toBeGreaterThan(draft.revision);
    expect(changed.safeStatus().draft?.secretConfigured).toBe(true);
    changed.dispose();
  } finally { initial.dispose(); cipher.dispose(); database.close(); }
});
