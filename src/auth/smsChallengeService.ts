import {
  createHmac,
  randomInt as secureRandomInt,
  timingSafeEqual,
} from "node:crypto";

import { authenticationPolicy } from "./authenticationPolicy.js";
import type { ConfiguredTestCodeReader } from "./configuredTestCodeReader.js";
import type { VersionedKeyRing } from "./phoneIdentity.js";
import type {
  SmsDeliveryOutcome,
  SmsProvider,
} from "./smsProvider.js";

type CodeMode = "mock" | "sms" | "closed_beta";
type Environment = "development" | "test" | "production";

type ChallengeServiceOptions = Readonly<{
  environment: Environment;
  codeMode: CodeMode;
  matchesMockCode(candidate: string): boolean;
  configuredTestCodes?: ConfiguredTestCodeReader;
  otpKeys: VersionedKeyRing;
  smsProvider: SmsProvider;
  randomInt?: (minimum: number, maximum: number) => number;
}>;

export function generateProductionVerificationCode(
  randomInt: (minimum: number, maximum: number) => number = secureRandomInt,
): string {
  return randomInt(0, 10 ** authenticationPolicy.codeDigits)
    .toString()
    .padStart(authenticationPolicy.codeDigits, "0");
}

function otpHmac(
  challengeId: string,
  phoneLookup: string,
  code: string,
  version: string,
  key: Buffer,
): string {
  return `${version}:${createHmac("sha256", key)
    .update(challengeId)
    .update(":")
    .update(phoneLookup)
    .update(":")
    .update(code)
    .digest("hex")}`;
}

export class SmsChallengeService {
  constructor(private readonly options: ChallengeServiceOptions) {
    const mockMatches = options.matchesMockCode("123456");
    if (
      (options.environment === "production" &&
        (options.codeMode === "mock" || mockMatches)) ||
      (options.codeMode === "mock" &&
        (!mockMatches || options.matchesMockCode("000000")))
    ) {
      throw new Error("Invalid mock authentication configuration");
    }
  }

  get mockMode(): boolean {
    return this.options.codeMode === "mock";
  }

  createCode(phone: string): string {
    if (this.mockMode) {
      return "123456";
    }
    if (this.options.codeMode === "closed_beta") {
      const configuredCode = this.options.configuredTestCodes?.readCode(phone);
      if (configuredCode !== undefined) {
        return configuredCode;
      }
    }
    return generateProductionVerificationCode(this.options.randomInt);
  }

  createVerifier(
    challengeId: string,
    phoneLookup: string,
    code: string,
  ): string {
    const version = this.options.otpKeys.activeVersion;
    const key = this.options.otpKeys.versions.get(version);
    if (key === undefined) {
      throw new Error("Active OTP key is unavailable");
    }
    return otpHmac(challengeId, phoneLookup, code, version, key);
  }

  matchesVerifier(
    verifier: string,
    challengeId: string,
    phoneLookup: string,
    candidate: string,
  ): boolean {
    const separator = verifier.indexOf(":");
    if (separator <= 0) {
      return false;
    }
    const version = verifier.slice(0, separator);
    const key = this.options.otpKeys.versions.get(version);
    if (key === undefined) {
      return false;
    }
    const expected = otpHmac(
      challengeId,
      phoneLookup,
      candidate,
      version,
      key,
    );
    const expectedBytes = Buffer.from(expected);
    const candidateBytes = Buffer.from(verifier);
    return (
      expectedBytes.length === candidateBytes.length &&
      timingSafeEqual(expectedBytes, candidateBytes)
    );
  }

  async send(
    phone: string,
    code: string,
    challengeId: string,
  ): Promise<SmsDeliveryOutcome> {
    if (
      this.mockMode ||
      this.options.codeMode === "closed_beta"
    ) {
      return { kind: "accepted" };
    }
    return this.options.smsProvider.send({ phone, code, challengeId });
  }
}
