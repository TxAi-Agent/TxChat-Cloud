export type AdminSetupFragment = Readonly<{
  mode: "setup" | "reset";
  token: string;
}>;

export class AdminSetupSubmissionGuard {
  #inFlight = false;

  async run(
    control: { disabled: boolean },
    operation: () => Promise<void>,
  ): Promise<"completed" | "ignored"> {
    if (this.#inFlight) return "ignored";
    this.#inFlight = true;
    control.disabled = true;
    try {
      await operation();
      return "completed";
    } finally {
      control.disabled = false;
      this.#inFlight = false;
    }
  }
}

const SETUP_FRAGMENT_PATTERN = /^#(setup|reset)=([0123456789ABCDEFGHJKMNPQRSTVWXYZ]{32})\.([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])$/u;

export function adminSetupFailurePolicy(status: number): Readonly<{
  terminal: true;
  message: string;
}> {
  return Object.freeze({
    terminal: true as const,
    message: status === 503
      ? "服务暂时不可用，请重新打开一次性链接后重试。"
      : "设置链接无效或已过期。",
  });
}

export function parseAdminSetupFragment(
  value: string,
): AdminSetupFragment | null {
  if (typeof value !== "string") return null;
  const match = SETUP_FRAGMENT_PATTERN.exec(value);
  if (match === null) return null;
  const mode = match[1];
  const tokenId = match[2];
  const secret = match[3];
  if (
    (mode !== "setup" && mode !== "reset") ||
    tokenId === undefined ||
    secret === undefined
  ) return null;
  return Object.freeze({ mode, token: `${tokenId}.${secret}` });
}
