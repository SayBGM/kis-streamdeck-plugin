import { KisError } from "../core/errors.js";
import type { MarketSnapshot } from "../core/market-clock.js";
import type {
  CanonicalInstrument,
  KisRestDescriptor,
  QuoteSample,
} from "../markets/market-adapter.js";
import { KIS_REST_BASE, type Market } from "../types/index.js";
import type {
  AccessTokenExpectation,
  CredentialIdentity,
  RestAuthorizationLease,
} from "./credential-session.js";

const MAX_CONCURRENT_REQUESTS = 4;
const MAX_STARTS_PER_SECOND = 10;
const RATE_WINDOW_MS = 1_000;
const NEGATIVE_CACHE_MS = 30_000;
const MAX_CACHE_ENTRIES = 512;

export type RestRequestPriority = "manual" | "initial" | "fallback";

export interface RestCredentialPort {
  initialize(): Promise<CredentialIdentity>;
  getRestAuthorization(): Promise<RestAuthorizationLease>;
  invalidateAccessToken(expected: AccessTokenExpectation): Promise<boolean>;
}

export interface RestFetchInit {
  readonly method: "GET";
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

export type RestFetch = (url: string, init: RestFetchInit) => Promise<unknown>;
export type RestTimerHandle = unknown;

export interface RestCoordinatorOptions {
  readonly fetch?: RestFetch;
  readonly now?: () => number;
  readonly setTimeout?: (callback: () => void, milliseconds: number) => RestTimerHandle;
  readonly clearTimeout?: (handle: RestTimerHandle) => void;
}

export interface RestQuoteAdapter {
  readonly id: string;
  readonly market: Market;
  restDescriptor(instrument: CanonicalInstrument): KisRestDescriptor;
  parseRest(
    payload: unknown,
    instrument: CanonicalInstrument,
    context: { readonly receivedAt: number; readonly sessionEpoch: number },
  ): QuoteSample;
}

export interface RestQuoteRequest {
  readonly adapter: RestQuoteAdapter;
  readonly instrument: CanonicalInstrument;
  readonly marketSnapshot: MarketSnapshot;
  readonly priority: RestRequestPriority;
  readonly signal?: AbortSignal;
}

interface ValidRequest {
  readonly adapter: RestQuoteAdapter;
  readonly instrument: CanonicalInstrument;
  readonly marketSnapshot: MarketSnapshot;
  readonly priority: RestRequestPriority;
  readonly signal?: AbortSignal;
  readonly adapterId: string;
  readonly instrumentKey: string;
}

interface Waiter {
  readonly id: number;
  readonly resolve: (quote: QuoteSample) => void;
  readonly reject: (error: KisError) => void;
  readonly signal?: AbortSignal;
  readonly abortListener?: () => void;
}

interface Flight {
  readonly key: string;
  readonly cacheKey: string;
  readonly request: ValidRequest;
  readonly expectedIdentity: CredentialIdentity & {
    readonly configured: true;
    readonly credentialFingerprint: string;
  };
  readonly sequence: number;
  readonly controller: AbortController;
  readonly waiters: Map<number, Waiter>;
  priorityRank: number;
  state: "queued" | "running" | "settled";
  cacheAllowed: boolean;
  abandoned: boolean;
}

interface RateWaiter {
  readonly resolve: () => void;
  readonly reject: (error: KisError) => void;
  readonly signal: AbortSignal;
  readonly abortListener: () => void;
}

type CacheEntry =
  | { readonly kind: "success"; readonly quote: QuoteSample }
  | { readonly kind: "failure"; readonly error: KisError; readonly expiresAt: number };

const PRIORITY_RANK: Readonly<Record<RestRequestPriority, number>> = {
  manual: 0,
  initial: 1,
  fallback: 2,
};

function defaultFetch(url: string, init: RestFetchInit): Promise<unknown> {
  return fetch(url, init);
}

function defaultSetTimeout(callback: () => void, milliseconds: number): RestTimerHandle {
  return setTimeout(callback, milliseconds);
}

function defaultClearTimeout(handle: RestTimerHandle): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

function restError(
  code: "AUTH_REJECTED" | "NETWORK" | "PROTOCOL" | "INVALID_INSTRUMENT",
  retryable: boolean,
  safeMessage: string,
  httpStatus?: number,
): KisError {
  return Object.freeze(new KisError({
    code,
    scope: "rest",
    retryable,
    safeMessage,
    ...(httpStatus === undefined ? {} : { metadata: { httpStatus } }),
  }));
}

function cancelledError(): KisError {
  return restError("NETWORK", true, "시세 요청이 취소되었습니다.");
}

function protocolError(): KisError {
  return restError("PROTOCOL", false, "시세 HTTP 응답 형식이 올바르지 않습니다.");
}

function changedCredentialError(): KisError {
  return restError(
    "AUTH_REJECTED",
    true,
    "자격증명이 변경되어 이전 시세 결과를 폐기했습니다.",
  );
}

function normalizeError(value: unknown): KisError {
  if (value instanceof KisError) return value;
  return restError("NETWORK", true, "KIS 시세 요청을 처리하지 못했습니다.");
}

function ownData(value: unknown, key: string): unknown {
  try {
    if (typeof value !== "object" || value === null) throw protocolError();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) throw protocolError();
    return descriptor.value;
  } catch (error) {
    if (error instanceof KisError) throw error;
    throw protocolError();
  }
}

function validateRequest(input: RestQuoteRequest): ValidRequest {
  try {
    const adapter = ownData(input, "adapter") as RestQuoteAdapter;
    const instrument = ownData(input, "instrument") as CanonicalInstrument;
    const marketSnapshot = ownData(input, "marketSnapshot") as MarketSnapshot;
    const priority = ownData(input, "priority");
    const signal = Object.prototype.hasOwnProperty.call(input, "signal")
      ? ownData(input, "signal")
      : undefined;
    const adapterId = ownData(adapter, "id");
    const adapterMarket = ownData(adapter, "market");
    const instrumentKey = ownData(instrument, "key");
    const instrumentMarket = ownData(instrument, "market");
    const snapshotMarket = ownData(marketSnapshot, "market");
    const session = ownData(marketSnapshot, "session");
    const sessionEpoch = ownData(marketSnapshot, "sessionEpoch");

    if (
      typeof adapterId !== "string" || adapterId.length === 0 ||
      (adapterMarket !== "domestic" && adapterMarket !== "overseas") ||
      typeof instrumentKey !== "string" || instrumentKey.length === 0 ||
      instrumentMarket !== adapterMarket || snapshotMarket !== adapterMarket ||
      (session !== "PRE" && session !== "REG" && session !== "AFT" && session !== "CLOSED") ||
      typeof sessionEpoch !== "number" || !Number.isFinite(sessionEpoch) ||
      (priority !== "manual" && priority !== "initial" && priority !== "fallback") ||
      (signal !== undefined && !(signal instanceof AbortSignal)) ||
      typeof adapter.restDescriptor !== "function" ||
      typeof adapter.parseRest !== "function"
    ) {
      throw protocolError();
    }
    return {
      adapter,
      instrument,
      marketSnapshot,
      priority,
      ...(signal ? { signal } : {}),
      adapterId,
      instrumentKey,
    };
  } catch (error) {
    if (error instanceof KisError) throw error;
    throw protocolError();
  }
}

function configuredIdentity(
  identity: CredentialIdentity,
): identity is CredentialIdentity & {
  readonly configured: true;
  readonly credentialFingerprint: string;
} {
  return identity.configured &&
    typeof identity.credentialFingerprint === "string" &&
    identity.credentialFingerprint.length > 0;
}

function sameCredential(
  identity: CredentialIdentity,
  expected: { readonly credentialGeneration: number; readonly credentialFingerprint: string },
): boolean {
  return identity.configured &&
    identity.credentialGeneration === expected.credentialGeneration &&
    identity.credentialFingerprint === expected.credentialFingerprint;
}

function descriptorUrl(descriptor: KisRestDescriptor): { url: string; trId: string } {
  try {
    const method = ownData(descriptor, "method");
    const path = ownData(descriptor, "path");
    const trId = ownData(descriptor, "trId");
    const query = ownData(descriptor, "query");
    if (
      method !== "GET" ||
      typeof path !== "string" || !path.startsWith("/uapi/") || path.includes("?") ||
      typeof trId !== "string" || !/^[A-Z0-9]+$/.test(trId) ||
      typeof query !== "object" || query === null || Array.isArray(query) ||
      Object.getOwnPropertySymbols(query).length > 0
    ) throw protocolError();

    const url = new URL(`${KIS_REST_BASE}${path}`);
    const descriptors = Object.getOwnPropertyDescriptors(query);
    for (const [key, property] of Object.entries(descriptors)) {
      if (!property.enumerable || !("value" in property) || typeof property.value !== "string") {
        throw protocolError();
      }
      url.searchParams.append(key, property.value);
    }
    return { url: url.toString(), trId };
  } catch (error) {
    if (error instanceof KisError) throw error;
    throw protocolError();
  }
}

export class RestCoordinator {
  private readonly credentials: RestCredentialPort;
  private readonly fetch: RestFetch;
  private readonly now: () => number;
  private readonly setTimeout: NonNullable<RestCoordinatorOptions["setTimeout"]>;
  private readonly clearTimeout: NonNullable<RestCoordinatorOptions["clearTimeout"]>;
  private readonly queue: Flight[] = [];
  private readonly flights = new Map<string, Flight>();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly startTimes: number[] = [];
  private readonly rateWaiters: RateWaiter[] = [];
  private activeCount = 0;
  private nextSequence = 0;
  private nextWaiterId = 0;
  private rateTimer?: RestTimerHandle;

  constructor(credentials: RestCredentialPort, options: RestCoordinatorOptions = {}) {
    this.credentials = credentials;
    this.fetch = options.fetch ?? defaultFetch;
    this.now = options.now ?? Date.now;
    this.setTimeout = options.setTimeout ?? defaultSetTimeout;
    this.clearTimeout = options.clearTimeout ?? defaultClearTimeout;
  }

  requestQuote(input: RestQuoteRequest): Promise<QuoteSample> {
    return this.prepareRequest(input);
  }

  private async prepareRequest(input: RestQuoteRequest): Promise<QuoteSample> {
    const request = validateRequest(input);
    if (request.signal?.aborted) throw cancelledError();

    let identity: CredentialIdentity;
    try {
      identity = await this.credentials.initialize();
    } catch (error) {
      throw normalizeError(error);
    }
    if (!configuredIdentity(identity)) {
      throw restError("AUTH_REJECTED", false, "KIS API 자격증명이 비어 있습니다.");
    }
    if (request.signal?.aborted) throw cancelledError();

    const cacheKey = `${request.adapterId}|${request.instrumentKey}|${request.marketSnapshot.sessionEpoch}|${identity.credentialGeneration}`;
    if (request.priority !== "manual") {
      const cached = this.readCache(cacheKey);
      if (cached?.kind === "success") return cached.quote;
      if (cached?.kind === "failure") throw cached.error;
    }

    const flightKey = cacheKey;
    let flight = this.flights.get(flightKey);
    if (!flight) {
      flight = {
        key: flightKey,
        cacheKey,
        request,
        expectedIdentity: identity,
        sequence: this.nextSequence++,
        controller: new AbortController(),
        waiters: new Map(),
        priorityRank: PRIORITY_RANK[request.priority],
        state: "queued",
        cacheAllowed: request.priority !== "manual",
        abandoned: false,
      };
      this.flights.set(flightKey, flight);
      this.queue.push(flight);
    } else {
      flight.priorityRank = Math.min(flight.priorityRank, PRIORITY_RANK[request.priority]);
    }

    const result = this.addWaiter(flight, request.signal);
    this.pump();
    return result;
  }

  private readCache(key: string): CacheEntry | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.kind === "failure" && entry.expiresAt <= this.now()) {
      this.cache.delete(key);
      return undefined;
    }
    return entry;
  }

  private writeCache(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private addWaiter(flight: Flight, signal?: AbortSignal): Promise<QuoteSample> {
    return new Promise((resolve, reject) => {
      const id = this.nextWaiterId++;
      const abortListener = signal
        ? () => this.cancelWaiter(flight, id)
        : undefined;
      const waiter: Waiter = {
        id,
        resolve,
        reject,
        ...(signal ? { signal } : {}),
        ...(abortListener ? { abortListener } : {}),
      };
      flight.waiters.set(id, waiter);
      signal?.addEventListener("abort", abortListener!, { once: true });
      if (signal?.aborted) this.cancelWaiter(flight, id);
    });
  }

  private cancelWaiter(flight: Flight, waiterId: number): void {
    const waiter = flight.waiters.get(waiterId);
    if (!waiter) return;
    flight.waiters.delete(waiterId);
    this.removeAbortListener(waiter);
    waiter.reject(cancelledError());
    if (flight.waiters.size > 0) return;

    flight.abandoned = true;
    if (flight.state === "queued") {
      this.removeQueuedFlight(flight);
      this.flights.delete(flight.key);
    } else if (flight.state === "running") {
      try {
        flight.controller.abort();
      } catch {
        // The request completion path remains safe if a host signal cannot abort.
      }
    }
  }

  private removeQueuedFlight(flight: Flight): void {
    const index = this.queue.indexOf(flight);
    if (index >= 0) this.queue.splice(index, 1);
  }

  private removeAbortListener(waiter: Waiter): void {
    if (!waiter.signal || !waiter.abortListener) return;
    try {
      waiter.signal.removeEventListener("abort", waiter.abortListener);
    } catch {
      // Listener cleanup must not replace the caller's safe result.
    }
  }

  private pump(): void {
    this.queue.sort((left, right) =>
      left.priorityRank - right.priorityRank || left.sequence - right.sequence,
    );

    while (this.activeCount < MAX_CONCURRENT_REQUESTS && this.queue.length > 0) {
      const flight = this.queue.shift()!;
      if (flight.state !== "queued" || flight.waiters.size === 0) continue;
      flight.state = "running";
      this.activeCount += 1;
      void this.execute(flight).then(
        (quote) => this.settleFlight(flight, quote),
        (error: unknown) => this.failFlight(flight, normalizeError(error)),
      ).finally(() => {
        this.activeCount -= 1;
        this.pump();
      });
    }
  }

  private pruneStartTimes(): void {
    const cutoff = this.now() - RATE_WINDOW_MS;
    while (this.startTimes.length > 0 && this.startTimes[0] <= cutoff) {
      this.startTimes.shift();
    }
  }

  private scheduleRatePump(): void {
    if (
      this.rateTimer !== undefined ||
      this.startTimes.length === 0 ||
      this.rateWaiters.length === 0
    ) return;
    const delay = Math.max(0, this.startTimes[0] + RATE_WINDOW_MS - this.now());
    this.rateTimer = this.setTimeout(() => {
      this.rateTimer = undefined;
      this.pumpRatePermits();
    }, delay);
  }

  private acquireRatePermit(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(cancelledError());
    return new Promise((resolve, reject) => {
      let waiter!: RateWaiter;
      const abortListener = () => this.cancelRateWaiter(waiter);
      waiter = { resolve, reject, signal, abortListener };
      this.rateWaiters.push(waiter);
      try {
        signal.addEventListener("abort", abortListener, { once: true });
      } catch {
        this.cancelRateWaiter(waiter);
        return;
      }
      this.pumpRatePermits();
    });
  }

  private pumpRatePermits(): void {
    this.pruneStartTimes();
    while (
      this.rateWaiters.length > 0 &&
      this.startTimes.length < MAX_STARTS_PER_SECOND
    ) {
      const waiter = this.rateWaiters.shift()!;
      this.removeRateAbortListener(waiter);
      if (waiter.signal.aborted) {
        waiter.reject(cancelledError());
        continue;
      }
      this.startTimes.push(this.now());
      waiter.resolve();
    }
    if (this.rateWaiters.length > 0) this.scheduleRatePump();
  }

  private cancelRateWaiter(waiter: RateWaiter): void {
    const index = this.rateWaiters.indexOf(waiter);
    if (index < 0) return;
    this.rateWaiters.splice(index, 1);
    this.removeRateAbortListener(waiter);
    waiter.reject(cancelledError());
    if (this.rateWaiters.length === 0 && this.rateTimer !== undefined) {
      const handle = this.rateTimer;
      this.rateTimer = undefined;
      try { this.clearTimeout(handle); } catch { /* noop */ }
    }
  }

  private removeRateAbortListener(waiter: RateWaiter): void {
    try {
      waiter.signal.removeEventListener("abort", waiter.abortListener);
    } catch {
      // Listener cleanup must not replace the transport result.
    }
  }

  private async execute(flight: Flight): Promise<QuoteSample> {
    if (flight.abandoned || flight.controller.signal.aborted) throw cancelledError();
    const authorization = await this.credentials.getRestAuthorization();
    if (!sameCredential(flight.expectedIdentity, authorization)) {
      throw changedCredentialError();
    }
    if (flight.abandoned || flight.controller.signal.aborted) throw cancelledError();

    let descriptor: KisRestDescriptor;
    try {
      descriptor = flight.request.adapter.restDescriptor(flight.request.instrument);
    } catch (error) {
      throw normalizeError(error);
    }
    const target = descriptorUrl(descriptor);
    await this.acquireRatePermit(flight.controller.signal);
    if (flight.abandoned || flight.controller.signal.aborted) throw cancelledError();
    let rawResponse: unknown;
    try {
      rawResponse = await this.fetch(target.url, {
        method: "GET",
        headers: Object.freeze({
          "Content-Type": "application/json; charset=utf-8",
          authorization: `Bearer ${authorization.token}`,
          appkey: authorization.appKey,
          appsecret: authorization.appSecret,
          tr_id: target.trId,
          custtype: "P",
        }),
        signal: flight.controller.signal,
      });
    } catch {
      if (flight.controller.signal.aborted) throw cancelledError();
      throw restError("NETWORK", true, "KIS 시세 서버에 연결하지 못했습니다.");
    }
    if (flight.abandoned || flight.controller.signal.aborted) throw cancelledError();

    const payload = await this.decodeResponse(rawResponse, authorization);
    const receivedAt = this.now();
    let quote: QuoteSample;
    try {
      quote = flight.request.adapter.parseRest(
        payload,
        flight.request.instrument,
        { receivedAt, sessionEpoch: flight.request.marketSnapshot.sessionEpoch },
      );
    } catch (error) {
      if (error instanceof KisError) throw error;
      throw protocolError();
    }

    let currentIdentity: CredentialIdentity;
    try {
      currentIdentity = await this.credentials.initialize();
    } catch (error) {
      throw normalizeError(error);
    }
    if (!sameCredential(currentIdentity, authorization)) throw changedCredentialError();
    if (flight.abandoned || flight.controller.signal.aborted) throw cancelledError();
    return quote;
  }

  private async decodeResponse(
    rawResponse: unknown,
    authorization: RestAuthorizationLease,
  ): Promise<unknown> {
    let ok: unknown;
    let status: unknown;
    let json: unknown;
    try {
      if (typeof rawResponse !== "object" || rawResponse === null) throw protocolError();
      const response = rawResponse as { ok?: unknown; status?: unknown; json?: unknown };
      ok = response.ok;
      status = response.status;
      json = response.json;
    } catch {
      throw protocolError();
    }
    if (
      typeof ok !== "boolean" ||
      typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599 ||
      ok !== (status >= 200 && status < 300)
    ) throw protocolError();

    if (!ok) {
      if (status === 401) {
        try {
          await this.credentials.invalidateAccessToken({
            credentialGeneration: authorization.credentialGeneration,
            credentialFingerprint: authorization.credentialFingerprint,
            tokenVersion: authorization.tokenVersion,
          });
        } catch {
          // The original safe 401 classification wins over persistence failures.
        }
        throw restError("AUTH_REJECTED", true, "KIS 접근 토큰이 거부되었습니다.", status);
      }
      if (status === 403) {
        throw restError("AUTH_REJECTED", false, "KIS 시세 요청 권한이 거부되었습니다.", status);
      }
      throw restError(
        "NETWORK",
        status === 408 || status === 429 || status >= 500,
        "KIS 시세 요청이 실패했습니다.",
        status,
      );
    }
    if (typeof json !== "function") throw protocolError();

    let payload: unknown;
    try {
      payload = await Reflect.apply(json, rawResponse, []);
    } catch {
      throw protocolError();
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw protocolError();
    }
    try {
      const rtDescriptor = Object.getOwnPropertyDescriptor(payload, "rt_cd");
      if (rtDescriptor) {
        if (!("value" in rtDescriptor) || typeof rtDescriptor.value !== "string") {
          throw protocolError();
        }
        if (rtDescriptor.value !== "0") {
          throw restError(
            "INVALID_INSTRUMENT",
            false,
            "KIS가 종목 시세 요청을 거부했습니다.",
          );
        }
      }
    } catch (error) {
      if (error instanceof KisError) throw error;
      throw protocolError();
    }
    return payload;
  }

  private settleFlight(flight: Flight, quote: QuoteSample): void {
    flight.state = "settled";
    this.flights.delete(flight.key);
    if (
      !flight.abandoned &&
      flight.cacheAllowed &&
      flight.request.marketSnapshot.session === "CLOSED"
    ) {
      this.writeCache(flight.cacheKey, { kind: "success", quote });
    }
    for (const waiter of flight.waiters.values()) {
      this.removeAbortListener(waiter);
      waiter.resolve(quote);
    }
    flight.waiters.clear();
  }

  private failFlight(flight: Flight, error: KisError): void {
    flight.state = "settled";
    this.flights.delete(flight.key);
    if (!flight.abandoned && flight.cacheAllowed) {
      this.writeCache(flight.cacheKey, {
        kind: "failure",
        error,
        expiresAt: this.now() + NEGATIVE_CACHE_MS,
      });
    }
    for (const waiter of flight.waiters.values()) {
      this.removeAbortListener(waiter);
      waiter.reject(error);
    }
    flight.waiters.clear();
  }
}
