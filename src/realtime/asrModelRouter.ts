import { createHash } from "node:crypto";

import type { RuntimeProviderFailure } from "../models/runtimeModelRegistry.js";
import type { StreamingASRProvider } from "./streamingProvider.js";

export type ASRRouteDefinition = Readonly<{
  id: string;
  provider: StreamingASRProvider;
  enabled: boolean;
  healthy: boolean;
  weight: number;
}>;

export type ASRModelRouterErrorCode =
  | "INVALID_ALLOWLIST"
  | "INVALID_SELECTION"
  | "NO_AVAILABLE_ROUTE"
  | "REQUEST_PIN_CONFLICT";

export class ASRModelRouterError extends Error {
  readonly code: ASRModelRouterErrorCode;

  constructor(code: ASRModelRouterErrorCode) {
    super(`ASR model router failed (${code})`);
    this.name = "ASRModelRouterError";
    this.code = code;
  }
}

export type SelectedASRRoute = Readonly<{
  routeId: string;
  provider: StreamingASRProvider;
  publicDescriptor: Readonly<{ routeVersion: 1 }>;
}>;

export interface StreamingRouteSelector {
  select(input: Readonly<{
    accountId: string;
    requestId: string;
  }>): SelectedASRRoute;
  replaceAfterOpenFailure(input: Readonly<{
    accountId: string;
    requestId: string;
    error: unknown;
  }>): SelectedASRRoute | undefined;
  reportReady(requestId: string): void;
  reportFailure(requestId: string, input: RuntimeProviderFailure): void;
  release(requestId: string): boolean;
}

type PinnedRoute = Readonly<{
  accountId: string;
  selection: SelectedASRRoute;
}>;

const PUBLIC_DESCRIPTOR = Object.freeze({ routeVersion: 1 as const });
const MAX_IDENTITY_LENGTH = 512;

function invalidAllowlist(): never {
  throw new ASRModelRouterError("INVALID_ALLOWLIST");
}

function validateRoute(route: ASRRouteDefinition): void {
  if (
    typeof route.id !== "string" ||
    route.id.length === 0 ||
    route.id.length > MAX_IDENTITY_LENGTH ||
    route.id.trim() !== route.id ||
    typeof route.provider !== "object" ||
    route.provider === null ||
    typeof route.provider.open !== "function" ||
    typeof route.enabled !== "boolean" ||
    typeof route.healthy !== "boolean" ||
    !Number.isSafeInteger(route.weight) ||
    route.weight < 0
  ) {
    invalidAllowlist();
  }
}

function validateIdentity(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTITY_LENGTH ||
    value.trim() !== value
  ) {
    throw new ASRModelRouterError("INVALID_SELECTION");
  }
}

function stableBucket(input: string, totalWeight: number): number {
  const digest = createHash("sha256").update(input, "utf8").digest();
  const value = digest.readBigUInt64BE(0);
  return Number(value % BigInt(totalWeight));
}

export class ASRModelRouter implements StreamingRouteSelector {
  readonly #routes: readonly ASRRouteDefinition[];
  readonly #pins = new Map<string, PinnedRoute>();

  constructor(routes: readonly ASRRouteDefinition[]) {
    if (!Array.isArray(routes) || routes.length === 0) {
      invalidAllowlist();
    }

    const routeIds = new Set<string>();
    let totalWeight = 0;
    for (const route of routes) {
      validateRoute(route);
      if (routeIds.has(route.id)) {
        invalidAllowlist();
      }
      routeIds.add(route.id);
      totalWeight += route.weight;
      if (!Number.isSafeInteger(totalWeight)) {
        invalidAllowlist();
      }
    }

    this.#routes = Object.freeze(
      [...routes]
        .sort((left, right) => left.id.localeCompare(right.id, "en"))
        .map((route) => Object.freeze({ ...route })),
    );
  }

  select(input: Readonly<{ accountId: string; requestId: string }>): SelectedASRRoute {
    validateIdentity(input.accountId);
    validateIdentity(input.requestId);

    const pinned = this.#pins.get(input.requestId);
    if (pinned !== undefined) {
      if (pinned.accountId !== input.accountId) {
        throw new ASRModelRouterError("REQUEST_PIN_CONFLICT");
      }
      return pinned.selection;
    }

    const candidates = this.#routes.filter(
      (route) => route.enabled && route.healthy && route.weight > 0,
    );
    const totalWeight = candidates.reduce(
      (total, route) => total + route.weight,
      0,
    );
    if (!Number.isSafeInteger(totalWeight) || totalWeight <= 0) {
      throw new ASRModelRouterError("NO_AVAILABLE_ROUTE");
    }

    const bucket = stableBucket(
      `${input.accountId.length}:${input.accountId}${input.requestId.length}:${input.requestId}`,
      totalWeight,
    );
    let cumulativeWeight = 0;
    let chosen: ASRRouteDefinition | undefined;
    for (const candidate of candidates) {
      cumulativeWeight += candidate.weight;
      if (bucket < cumulativeWeight) {
        chosen = candidate;
        break;
      }
    }
    if (chosen === undefined) {
      throw new ASRModelRouterError("NO_AVAILABLE_ROUTE");
    }

    const selection = Object.freeze({
      routeId: chosen.id,
      provider: chosen.provider,
      publicDescriptor: PUBLIC_DESCRIPTOR,
    });
    this.#pins.set(
      input.requestId,
      Object.freeze({ accountId: input.accountId, selection }),
    );
    return selection;
  }

  replaceAfterOpenFailure(input: Readonly<{
    accountId: string;
    requestId: string;
    error: unknown;
  }>): undefined {
    validateIdentity(input.accountId);
    validateIdentity(input.requestId);
    return undefined;
  }

  reportReady(requestId: string): void {
    validateIdentity(requestId);
  }

  reportFailure(requestId: string, _input: RuntimeProviderFailure): void {
    validateIdentity(requestId);
  }

  release(requestId: string): boolean {
    validateIdentity(requestId);
    return this.#pins.delete(requestId);
  }
}
