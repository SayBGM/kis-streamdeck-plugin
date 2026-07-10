import { KisError, type KisErrorCode } from "../core/errors.js";
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
  PreparedRestAuthorization,
} from "./credential-session.js";

const MAX_CONCURRENT_REQUESTS = 4;
const MAX_STARTS_PER_SECOND = 10;
const RATE_WINDOW_MS = 1_000;
const NEGATIVE_CACHE_MS = 30_000;
const MAX_CACHE_ENTRIES = 512;
const ALLOWED_REST_ENDPOINTS: Readonly<Record<string, string>> = Object.freeze({
  "/uapi/domestic-stock/v1/quotations/inquire-price": "FHKST01010100",
  "/uapi/etfetn/v1/quotations/inquire-price": "FHPST02400000",
  "/uapi/overseas-price/v1/quotations/price": "HHDFS00000300",
});

export type RestRequestPriority = "manual" | "initial" | "fallback";

export interface RestCredentialPort {
  initialize(): Promise<CredentialIdentity>;
  prepareRestAuthorization(): Promise<PreparedRestAuthorization>;
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
  readonly now?: () => number;
  readonly rateNow?: () => number;
  readonly setTimeout?: (callback: () => void, milliseconds: number) => RestTimerHandle;
  readonly clearTimeout?: (handle: RestTimerHandle) => void;
}

export interface RestCoordinatorDiagnostics {
  readonly queuedRequests: number;
  readonly sharedRequests: number;
  readonly activeTransports: number;
  readonly cacheEntries: number;
  readonly startsInRateWindow: number;
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
  readonly instrumentSymbol: string;
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
  state: "queued" | "preparing" | "gate_wait" | "running" | "settled";
  cacheAllowed: boolean;
  abandoned: boolean;
  transportStarted: boolean;
  releaseTransport?: (removeRateReservation?: boolean) => void;
}

interface TransportGateWaiter {
  readonly flight: Flight;
  readonly resolve: (release: (removeRateReservation?: boolean) => void) => void;
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

function defaultSetTimeout(callback: () => void, milliseconds: number): RestTimerHandle {
  return setTimeout(callback, milliseconds);
}

function defaultClearTimeout(handle: RestTimerHandle): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

function defaultRateNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function restError(
  code: KisErrorCode,
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

function sessionTransitionError(): KisError {
  return restError(
    "TIMEOUT",
    true,
    "시장 세션이 전환되어 이전 시세 결과를 폐기했습니다.",
  );
}

function transportGateError(): KisError {
  return restError("NETWORK", true, "REST 전송 대기열을 처리하지 못했습니다.");
}

function raceWithAbort<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(cancelledError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      try { signal.removeEventListener("abort", onAbort); } catch { /* noop */ }
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(cancelledError());
    };
    try {
      signal.addEventListener("abort", onAbort, { once: true });
    } catch {
      onAbort();
      return;
    }
    Promise.resolve(operation).then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

function normalizeError(value: unknown): KisError {
  if (value instanceof KisError) {
    let code: unknown;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, "code");
      code = descriptor && "value" in descriptor ? descriptor.value : undefined;
    } catch {
      code = undefined;
    }
    switch (code) {
      case "NO_CREDENTIALS":
        return restError(code, false, "KIS API 자격증명이 비어 있습니다.");
      case "AUTH_REJECTED":
        return restError(code, true, "KIS 인증 상태가 유효하지 않습니다.");
      case "AUTH_RATE_LIMITED":
        return restError(code, true, "KIS 인증 요청 제한에 도달했습니다.");
      case "NETWORK":
        return restError(code, true, "KIS 시세 서버에 연결하지 못했습니다.");
      case "TIMEOUT":
        return restError(code, true, "KIS 시세 요청 시간이 만료되었습니다.");
      case "INVALID_INSTRUMENT":
        return restError(code, false, "종목 설정 또는 시세 요청이 올바르지 않습니다.");
      case "PROTOCOL":
        return restError(code, false, "KIS 시세 응답 형식이 올바르지 않습니다.");
      case "SUBSCRIPTION_REJECTED":
        return restError(code, false, "KIS 요청이 거부되었습니다.");
      case "SETTINGS":
        return restError(code, true, "KIS 설정을 안전하게 처리하지 못했습니다.");
    }
  }
  return restError("NETWORK", true, "KIS 시세 요청을 처리하지 못했습니다.");
}

function requestCacheKey(
  adapterId: string,
  instrumentKey: string,
  sessionEpoch: number,
  credentialGeneration: number,
): string {
  return JSON.stringify([
    adapterId,
    instrumentKey,
    sessionEpoch,
    credentialGeneration,
  ]);
}

function validateQuoteSample(
  value: unknown,
  expectedSymbol: string,
  receivedAt: number,
  sessionEpoch: number,
): QuoteSample {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw protocolError();
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) throw protocolError();
    if (Object.getOwnPropertySymbols(value).length > 0) throw protocolError();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = [
      "symbol",
      "price",
      "changeRate",
      "sign",
      "source",
      "receivedAt",
      "sessionEpoch",
    ] as const;
    if (Object.keys(descriptors).length !== keys.length) throw protocolError();
    const values = Object.create(null) as Record<(typeof keys)[number], unknown>;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !("value" in descriptor)) throw protocolError();
      values[key] = descriptor.value;
    }
    if (
      values.symbol !== expectedSymbol ||
      typeof values.price !== "number" || !Number.isFinite(values.price) || values.price <= 0 ||
      typeof values.changeRate !== "number" || !Number.isFinite(values.changeRate) ||
      (values.sign !== "rise" && values.sign !== "fall" && values.sign !== "flat") ||
      values.source !== "rest" ||
      values.receivedAt !== receivedAt ||
      values.sessionEpoch !== sessionEpoch
    ) throw protocolError();
    return Object.freeze({
      symbol: values.symbol,
      price: values.price,
      changeRate: values.changeRate,
      sign: values.sign,
      source: "rest",
      receivedAt,
      sessionEpoch,
    });
  } catch (error) {
    if (error instanceof KisError) throw normalizeError(error);
    throw protocolError();
  }
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
    const instrumentSymbol = ownData(instrument, "symbol");
    const instrumentMarket = ownData(instrument, "market");
    const snapshotMarket = ownData(marketSnapshot, "market");
    const session = ownData(marketSnapshot, "session");
    const sessionEpoch = ownData(marketSnapshot, "sessionEpoch");
    const nextTransitionAt = ownData(marketSnapshot, "nextTransitionAt");

    if (
      typeof adapterId !== "string" || adapterId.length === 0 ||
      (adapterMarket !== "domestic" && adapterMarket !== "overseas") ||
      typeof instrumentKey !== "string" || instrumentKey.length === 0 ||
      typeof instrumentSymbol !== "string" || instrumentSymbol.length === 0 ||
      instrumentMarket !== adapterMarket || snapshotMarket !== adapterMarket ||
      (session !== "PRE" && session !== "REG" && session !== "AFT" && session !== "CLOSED") ||
      typeof sessionEpoch !== "number" || !Number.isFinite(sessionEpoch) ||
      typeof nextTransitionAt !== "number" || !Number.isFinite(nextTransitionAt) ||
      nextTransitionAt <= sessionEpoch ||
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
      marketSnapshot: Object.freeze({
        market: snapshotMarket,
        session,
        sessionEpoch,
        nextTransitionAt,
      }) as MarketSnapshot,
      priority,
      ...(signal ? { signal } : {}),
      adapterId,
      instrumentKey,
      instrumentSymbol,
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
      ALLOWED_REST_ENDPOINTS[path] !== trId ||
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
  private readonly now: () => number;
  private readonly rateNow: () => number;
  private readonly setTimeout: NonNullable<RestCoordinatorOptions["setTimeout"]>;
  private readonly clearTimeout: NonNullable<RestCoordinatorOptions["clearTimeout"]>;
  private readonly queue: Flight[] = [];
  private readonly flights = new Map<string, Flight>();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly startTimes: number[] = [];
  private readonly gateWaiters: TransportGateWaiter[] = [];
  private activeTransportCount = 0;
  private nextSequence = 0;
  private nextWaiterId = 0;
  private rateTimer?: RestTimerHandle;
  private rateTimerScheduled = false;
  private rateTimerGeneration = 0;
  private lastRateNow = Number.NEGATIVE_INFINITY;

  constructor(credentials: RestCredentialPort, options: RestCoordinatorOptions = {}) {
    this.credentials = credentials;
    this.now = options.now ?? Date.now;
    this.rateNow = options.rateNow ?? defaultRateNow;
    this.setTimeout = options.setTimeout ?? defaultSetTimeout;
    this.clearTimeout = options.clearTimeout ?? defaultClearTimeout;
  }

  requestQuote(input: RestQuoteRequest): Promise<QuoteSample> {
    return this.prepareRequest(input);
  }

  getDiagnostics(): RestCoordinatorDiagnostics {
    return Object.freeze({
      queuedRequests: this.queue.filter((flight) => flight.state === "queued").length,
      sharedRequests: this.flights.size,
      activeTransports: this.activeTransportCount,
      cacheEntries: this.cache.size,
      startsInRateWindow: this.startTimes.length,
    });
  }

  private async prepareRequest(input: RestQuoteRequest): Promise<QuoteSample> {
    const request = validateRequest(input);
    if (request.signal?.aborted) throw cancelledError();
    if (this.now() >= request.marketSnapshot.nextTransitionAt) {
      throw sessionTransitionError();
    }

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
    if (this.now() >= request.marketSnapshot.nextTransitionAt) {
      throw sessionTransitionError();
    }

    const cacheKey = requestCacheKey(
      request.adapterId,
      request.instrumentKey,
      request.marketSnapshot.sessionEpoch,
      identity.credentialGeneration,
    );
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
        transportStarted: false,
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
    this.cache.delete(key);
    this.cache.set(key, entry);
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
    this.removeQueuedFlight(flight);
    this.deleteFlightIdentity(flight);
    try {
      flight.controller.abort();
    } catch {
      // The request completion path remains safe if a host signal cannot abort.
    }
    flight.releaseTransport?.(!flight.transportStarted);
  }

  private removeQueuedFlight(flight: Flight): void {
    const index = this.queue.indexOf(flight);
    if (index >= 0) this.queue.splice(index, 1);
  }

  private deleteFlightIdentity(flight: Flight): void {
    if (this.flights.get(flight.key) === flight) {
      this.flights.delete(flight.key);
    }
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

    while (this.queue.length > 0) {
      const flight = this.queue.shift()!;
      if (flight.state !== "queued" || flight.waiters.size === 0) continue;
      flight.state = "preparing";
      void this.execute(flight).then(
        (quote) => this.settleFlight(flight, quote),
        (error: unknown) => this.failFlight(flight, normalizeError(error)),
      );
    }
  }

  private readRateNow(): number {
    let current: number;
    try {
      current = this.rateNow();
    } catch {
      throw transportGateError();
    }
    if (!Number.isFinite(current)) throw transportGateError();
    if (current < this.lastRateNow) return this.lastRateNow;
    this.lastRateNow = current;
    return current;
  }

  private pruneStartTimes(current: number): void {
    const cutoff = current - RATE_WINDOW_MS;
    while (this.startTimes.length > 0 && this.startTimes[0] <= cutoff) {
      this.startTimes.shift();
    }
  }

  private scheduleRatePump(): void {
    if (
      this.rateTimerScheduled ||
      this.startTimes.length === 0 ||
      this.gateWaiters.length === 0 ||
      this.activeTransportCount >= MAX_CONCURRENT_REQUESTS
    ) return;
    let delay: number;
    try {
      delay = Math.max(0, this.startTimes[0] + RATE_WINDOW_MS - this.readRateNow());
    } catch (error) {
      this.failGateWaiters(normalizeError(error));
      return;
    }
    const generation = ++this.rateTimerGeneration;
    this.rateTimerScheduled = true;
    try {
      const handle = this.setTimeout(() => {
        if (!this.rateTimerScheduled || generation !== this.rateTimerGeneration) return;
        this.rateTimerScheduled = false;
        this.rateTimer = undefined;
        queueMicrotask(() => {
          if (generation !== this.rateTimerGeneration) return;
          this.pumpTransportGate();
        });
      }, delay);
      if (this.rateTimerScheduled && generation === this.rateTimerGeneration) {
        this.rateTimer = handle;
      }
    } catch {
      if (generation !== this.rateTimerGeneration) return;
      this.rateTimerScheduled = false;
      this.rateTimer = undefined;
      this.failGateWaiters(transportGateError());
    }
  }

  private acquireTransportGate(
    flight: Flight,
  ): Promise<(removeRateReservation?: boolean) => void> {
    const signal = flight.controller.signal;
    if (signal.aborted) return Promise.reject(cancelledError());
    flight.state = "gate_wait";
    return new Promise((resolve, reject) => {
      let waiter!: TransportGateWaiter;
      const abortListener = () => this.cancelGateWaiter(waiter);
      waiter = { flight, resolve, reject, signal, abortListener };
      this.gateWaiters.push(waiter);
      try {
        signal.addEventListener("abort", abortListener, { once: true });
      } catch {
        this.cancelGateWaiter(waiter);
        return;
      }
      this.pumpTransportGate();
    });
  }

  private pumpTransportGate(): void {
    let current: number;
    try {
      current = this.readRateNow();
    } catch (error) {
      this.failGateWaiters(normalizeError(error));
      return;
    }
    this.pruneStartTimes(current);
    this.gateWaiters.sort((left, right) =>
      left.flight.priorityRank - right.flight.priorityRank ||
      left.flight.sequence - right.flight.sequence,
    );
    while (
      this.gateWaiters.length > 0 &&
      this.activeTransportCount < MAX_CONCURRENT_REQUESTS &&
      this.startTimes.length < MAX_STARTS_PER_SECOND
    ) {
      const waiter = this.gateWaiters.shift()!;
      this.removeGateAbortListener(waiter);
      if (waiter.signal.aborted) {
        waiter.reject(cancelledError());
        continue;
      }
      this.startTimes.push(current);
      this.activeTransportCount += 1;
      waiter.flight.state = "running";
      let released = false;
      const release = (removeRateReservation = false): void => {
        if (released) return;
        released = true;
        if (removeRateReservation) {
          const timestampIndex = this.startTimes.indexOf(current);
          if (timestampIndex >= 0) this.startTimes.splice(timestampIndex, 1);
        }
        waiter.flight.releaseTransport = undefined;
        waiter.flight.transportStarted = false;
        this.activeTransportCount = Math.max(0, this.activeTransportCount - 1);
        this.pumpTransportGate();
      };
      waiter.flight.releaseTransport = release;
      waiter.resolve(release);
    }
    if (this.gateWaiters.length > 0) this.scheduleRatePump();
  }

  private cancelGateWaiter(waiter: TransportGateWaiter): void {
    const index = this.gateWaiters.indexOf(waiter);
    if (index < 0) return;
    this.gateWaiters.splice(index, 1);
    this.removeGateAbortListener(waiter);
    waiter.reject(cancelledError());
    if (this.gateWaiters.length === 0) this.clearRateTimer();
  }

  private clearRateTimer(): void {
    this.rateTimerGeneration += 1;
    this.rateTimerScheduled = false;
    if (this.rateTimer !== undefined) {
      const handle = this.rateTimer;
      this.rateTimer = undefined;
      try { this.clearTimeout(handle); } catch { /* noop */ }
    }
  }

  private removeGateAbortListener(waiter: TransportGateWaiter): void {
    try {
      waiter.signal.removeEventListener("abort", waiter.abortListener);
    } catch {
      // Listener cleanup must not replace the transport result.
    }
  }

  private failGateWaiters(error: KisError): void {
    this.clearRateTimer();
    const waiters = this.gateWaiters.splice(0);
    for (const waiter of waiters) {
      this.removeGateAbortListener(waiter);
      waiter.reject(error);
    }
  }

  private async execute(flight: Flight): Promise<QuoteSample> {
    if (flight.abandoned || flight.controller.signal.aborted) throw cancelledError();
    let descriptor: KisRestDescriptor;
    try {
      descriptor = flight.request.adapter.restDescriptor(flight.request.instrument);
    } catch (error) {
      throw normalizeError(error);
    }
    const target = descriptorUrl(descriptor);
    let authorization = await this.credentials.prepareRestAuthorization();

    for (;;) {
      if (!sameCredential(flight.expectedIdentity, authorization.expectation)) {
        throw changedCredentialError();
      }
      if (flight.abandoned || flight.controller.signal.aborted) throw cancelledError();
      const releaseTransport = await this.acquireTransportGate(flight);
      if (flight.abandoned || flight.controller.signal.aborted) {
        releaseTransport(true);
        throw cancelledError();
      }
      if (!authorization.isCurrent()) {
        releaseTransport(true);
        authorization = await this.credentials.prepareRestAuthorization();
        continue;
      }

      try {
        let fetchOperation: Promise<unknown>;
        try {
          flight.transportStarted = true;
          fetchOperation = authorization.execute({
            url: target.url,
            trId: target.trId,
            signal: flight.controller.signal,
          });
        } catch (error) {
          if (!authorization.isCurrent()) {
            flight.transportStarted = false;
            releaseTransport(true);
            authorization = await this.credentials.prepareRestAuthorization();
            continue;
          }
          throw normalizeError(error);
        }

        let rawResponse: unknown;
        try {
          rawResponse = await raceWithAbort(fetchOperation, flight.controller.signal);
        } catch (error) {
          if (error instanceof KisError) throw error;
          throw restError("NETWORK", true, "KIS 시세 서버에 연결하지 못했습니다.");
        }
        if (flight.abandoned || flight.controller.signal.aborted) throw cancelledError();

        const payload = await this.decodeResponse(
          rawResponse,
          authorization.expectation,
          flight.controller.signal,
        );
        const receivedAt = this.now();
        let parsedQuote: QuoteSample;
        try {
          parsedQuote = flight.request.adapter.parseRest(
            payload,
            flight.request.instrument,
            { receivedAt, sessionEpoch: flight.request.marketSnapshot.sessionEpoch },
          );
        } catch (error) {
          throw normalizeError(error);
        }
        const quote = validateQuoteSample(
          parsedQuote,
          flight.request.instrumentSymbol,
          receivedAt,
          flight.request.marketSnapshot.sessionEpoch,
        );

        let currentIdentity: CredentialIdentity;
        try {
          currentIdentity = await this.credentials.initialize();
        } catch (error) {
          throw normalizeError(error);
        }
        if (!sameCredential(currentIdentity, authorization.expectation)) {
          throw changedCredentialError();
        }
        if (flight.abandoned || flight.controller.signal.aborted) throw cancelledError();
        if (this.now() >= flight.request.marketSnapshot.nextTransitionAt) {
          throw sessionTransitionError();
        }
        return quote;
      } finally {
        releaseTransport();
      }
    }
  }

  private async decodeResponse(
    rawResponse: unknown,
    authorization: AccessTokenExpectation,
    signal: AbortSignal,
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
      const bodyOperation = Promise.resolve().then(() =>
        Reflect.apply(json as (...args: never[]) => unknown, rawResponse, []),
      );
      payload = await raceWithAbort(bodyOperation, signal);
    } catch (error) {
      if (error instanceof KisError) throw error;
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
    this.deleteFlightIdentity(flight);
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
    this.deleteFlightIdentity(flight);
    if (
      !flight.abandoned &&
      flight.cacheAllowed &&
      (error.code === "NETWORK" ||
        error.code === "PROTOCOL" ||
        error.code === "INVALID_INSTRUMENT")
    ) {
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
