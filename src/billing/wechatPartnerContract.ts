const MERCHANT_ID = /^[A-Za-z0-9_-]{1,32}$/u;

export function isWeChatPartnerMerchantId(value: unknown): value is string {
  return typeof value === "string" && MERCHANT_ID.test(value);
}

/** Callback location is supplied by the operator; no service is bundled. */
export function isWeChatPartnerNotifyUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048 ||
      value.trim() !== value || /[\u0000-\u0020\u007f]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0 &&
      url.username === "" && url.password === "" && !value.includes("#");
  } catch { return false; }
}
