const protocolUuidReference =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const wechatReference = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const businessCode = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const semanticVersion =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const buildNumber = /^[1-9]\d{0,9}$/u;

function matches(
  value: unknown,
  pattern: RegExp,
  maximumLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length <= maximumLength &&
    pattern.test(value)
  );
}

export function isProtocolUuidReference(value: unknown): value is string {
  return matches(value, protocolUuidReference, 36);
}

export function isWechatReference(value: unknown): value is string {
  return matches(value, wechatReference, 128);
}

export function isBusinessCode(value: unknown): value is string {
  return matches(value, businessCode, 64);
}

export function isSemanticVersion(value: unknown): value is string {
  return matches(value, semanticVersion, 128);
}

export function isBuildNumber(value: unknown): value is string {
  return matches(value, buildNumber, 10);
}
