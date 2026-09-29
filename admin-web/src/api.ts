export type ApiFailureCode =
  | "ADMIN_AUTH_REQUIRED"
  | "ADMIN_AUTH_FAILED"
  | "ADMIN_ACCESS_DENIED"
  | "ADMIN_CSRF_REJECTED"
  | "ADMIN_INVALID_REQUEST"
  | "ADMIN_ACCOUNT_NOT_FOUND"
  | "ADMIN_USER_NOT_FOUND"
  | "ADMIN_FEEDBACK_NOT_FOUND"
  | "ADMIN_ORDER_NOT_FOUND"
  | "ADMIN_OFFER_NOT_FOUND"
  | "ADMIN_OFFER_INVALID"
  | "ADMIN_OFFER_IMMUTABLE"
  | "ADMIN_OFFER_SCHEDULE_CONFLICT"
  | "ADMIN_MODEL_NOT_FOUND"
  | "ADMIN_MODEL_TEST_FAILED"
  | "ADMIN_MODEL_STATE_CONFLICT"
  | "ADMIN_SMS_NOT_FOUND"
  | "ADMIN_SMS_TEST_FAILED"
  | "ADMIN_SMS_RATE_LIMITED"
  | "ADMIN_SMS_STATE_CONFLICT"
  | "ADMIN_USERNAME_UNAVAILABLE"
  | "ADMIN_SETUP_REJECTED"
  | "ADMIN_REVISION_CONFLICT"
  | "ADMIN_RATE_LIMITED"
  | "ADMIN_SERVICE_UNAVAILABLE";

type ErrorEnvelope = Readonly<{
  code?: unknown;
  message?: unknown;
}>;

const FAILURE_CODES = new Set<string>([
  "ADMIN_AUTH_REQUIRED",
  "ADMIN_AUTH_FAILED",
  "ADMIN_ACCESS_DENIED",
  "ADMIN_CSRF_REJECTED",
  "ADMIN_INVALID_REQUEST",
  "ADMIN_ACCOUNT_NOT_FOUND",
  "ADMIN_USER_NOT_FOUND",
  "ADMIN_FEEDBACK_NOT_FOUND",
  "ADMIN_ORDER_NOT_FOUND",
  "ADMIN_OFFER_NOT_FOUND",
  "ADMIN_OFFER_INVALID",
  "ADMIN_OFFER_IMMUTABLE",
  "ADMIN_OFFER_SCHEDULE_CONFLICT",
  "ADMIN_MODEL_NOT_FOUND",
  "ADMIN_MODEL_TEST_FAILED",
  "ADMIN_MODEL_STATE_CONFLICT",
  "ADMIN_SMS_NOT_FOUND",
  "ADMIN_SMS_TEST_FAILED",
  "ADMIN_SMS_RATE_LIMITED",
  "ADMIN_SMS_STATE_CONFLICT",
  "ADMIN_USERNAME_UNAVAILABLE",
  "ADMIN_SETUP_REJECTED",
  "ADMIN_REVISION_CONFLICT",
  "ADMIN_RATE_LIMITED",
  "ADMIN_SERVICE_UNAVAILABLE",
]);

export class AdminApiError extends Error {
  constructor(
    readonly code: ApiFailureCode,
    readonly status: number,
  ) {
    super(code);
    this.name = "AdminApiError";
  }
}

export class AdminApiClient {
  #csrfToken: string | undefined;

  setCsrfToken(value: string): void {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
      throw new AdminApiError("ADMIN_SERVICE_UNAVAILABLE", 503);
    }
    this.#csrfToken = value;
  }

  clear(): void {
    this.#csrfToken = undefined;
  }

  async consumeSetup(input: Readonly<{
    token: string;
    username: string;
    password: string;
  }>): Promise<void> {
    await this.request<void>("/console/api/v1/setup/consume", {
      method: "POST",
      body: input,
    });
  }

  async consumeReset(input: Readonly<{
    token: string;
    password: string;
  }>): Promise<void> {
    await this.request<void>("/console/api/v1/reset/consume", {
      method: "POST",
      body: input,
    });
  }

  async request<T>(
    path: string,
    options: Readonly<{
      method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      body?: unknown;
      query?: Readonly<Record<string, string>>;
    }> = {},
  ): Promise<T> {
    if (!/^\/console\/api\/v1\/[A-Za-z0-9/_-]*$/u.test(path)) {
      throw new AdminApiError("ADMIN_INVALID_REQUEST", 400);
    }
    const method = options.method ?? "GET";
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(key) || typeof value !== "string") {
        throw new AdminApiError("ADMIN_INVALID_REQUEST", 400);
      }
      query.set(key, value);
    }
    const target = query.size === 0 ? path : `${path}?${query.toString()}`;
    const headers = new Headers({ Accept: "application/json" });
    let body: string | undefined;
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.body);
    }
    if (method !== "GET") {
      if (this.#csrfToken !== undefined) {
        headers.set("x-txchat-admin-csrf", this.#csrfToken);
      }
    }
    const response = await fetch(target, {
      method,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      ...(body === undefined ? {} : { body }),
    });
    const rotated = response.headers.get("x-txchat-admin-csrf");
    if (rotated !== null) this.setCsrfToken(rotated);
    if (!response.ok) {
      let envelope: ErrorEnvelope = {};
      try {
        envelope = await response.json() as ErrorEnvelope;
      } catch {
        // Stable status mapping below intentionally ignores raw response text.
      }
      const code = typeof envelope.code === "string" &&
          FAILURE_CODES.has(envelope.code)
        ? envelope.code as ApiFailureCode
        : "ADMIN_SERVICE_UNAVAILABLE";
      throw new AdminApiError(code, response.status);
    }
    if (response.status === 204) return undefined as T;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      throw new AdminApiError("ADMIN_SERVICE_UNAVAILABLE", 503);
    }
    return await response.json() as T;
  }
}
