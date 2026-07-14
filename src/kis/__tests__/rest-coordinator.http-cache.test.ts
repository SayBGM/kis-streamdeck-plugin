import { describe, expect, it, vi } from "vitest";
import { KisError } from "../../core/errors.js";
import { getMarketSnapshot, type MarketSnapshot } from "../../core/market-clock.js";
import {
  domesticStockAdapter,
  type CanonicalInstrument,
  type QuoteSample,
} from "../../markets/market-adapter.js";
import type {
  AccessTokenExpectation,
  CredentialIdentity,
  PreparedRestAuthorization,
  PreparedRestRequest,
  RestAuthorizationLease,
} from "../credential-session.js";
import {
  RestCoordinator,
  type RestCredentialPort,
  type RestFetch,
  type RestQuoteAdapter,
} from "../rest-coordinator.js";

function authorization(generation = 3, tokenVersion = 5): RestAuthorizationLease {
  return Object.freeze({
    appKey: `app-key-${generation}`,
    appSecret: `app-secret-${generation}`,
    token: `access-token-${generation}`,
    expiresAt: 9_999_999_999_999,
    credentialGeneration: generation,
    credentialFingerprint: `fingerprint-${generation}`,
    tokenVersion,
  });
}

function identity(lease: RestAuthorizationLease): CredentialIdentity {
  return Object.freeze({
    configured: true,
    credentialGeneration: lease.credentialGeneration,
    credentialFingerprint: lease.credentialFingerprint,
  });
}

function preparedAuthorization(
  lease: RestAuthorizationLease,
  current: () => RestAuthorizationLease,
  restFetch: RestFetch,
): PreparedRestAuthorization {
  let used = false;
  const expectation = Object.freeze({
    credentialGeneration: lease.credentialGeneration,
    credentialFingerprint: lease.credentialFingerprint,
    tokenVersion: lease.tokenVersion,
  });
  const isCurrent = () => {
    const value = current();
    return value.credentialGeneration === lease.credentialGeneration &&
      value.credentialFingerprint === lease.credentialFingerprint &&
      value.tokenVersion === lease.tokenVersion &&
      value.token === lease.token;
  };
  return Object.freeze({
    expectation,
    isCurrent,
    execute: (request: PreparedRestRequest) => {
      if (used || !isCurrent()) {
        throw new KisError({
          code: "AUTH_REJECTED",
          scope: "auth",
          retryable: true,
          safeMessage: "stale authorization",
        });
      }
      used = true;
      return restFetch(request.url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          authorization: `Bearer ${lease.token}`,
          appkey: lease.appKey,
          appsecret: lease.appSecret,
          tr_id: request.trId,
          custtype: "P",
        },
        signal: request.signal,
      });
    },
  });
}

function mutableCredentials(
  initial = authorization(),
  restFetch: RestFetch = async () => successfulResponse(),
): RestCredentialPort & {
  current: RestAuthorizationLease;
  initialize: ReturnType<typeof vi.fn>;
  prepareRestAuthorization: ReturnType<typeof vi.fn>;
  invalidateAccessToken: ReturnType<typeof vi.fn>;
} {
  let current = initial;
  const port = {
    get current(): RestAuthorizationLease { return current; },
    set current(value: RestAuthorizationLease) { current = value; },
    initialize: vi.fn(async () => identity(current)),
    prepareRestAuthorization: vi.fn(async () =>
      preparedAuthorization(current, () => current, restFetch)),
    invalidateAccessToken: vi.fn(async (_expected: AccessTokenExpectation) => true),
  };
  return port;
}

function instrument(code = "005930") {
  return domesticStockAdapter.toInstrument({ stockCode: code });
}

function snapshot(iso: string): MarketSnapshot {
  return getMarketSnapshot("domestic", Date.parse(iso));
}

const openNow = Date.parse("2026-07-06T01:00:00.000Z");
const closedNow = Date.parse("2026-07-06T10:00:00.000Z");
const openSnapshot = snapshot("2026-07-06T01:00:00.000Z");
const closedSnapshot = snapshot("2026-07-06T10:00:00.000Z");

function successfulResponse(price = "71200"): unknown {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      rt_cd: "0",
      output: {
        stck_prpr: price,
        prdy_vrss_sign: "2",
        prdy_vrss: "1200",
        prdy_ctrt: "1.25",
      },
    }),
  };
}

function customInstrument(key: string, symbol = "CUSTOM"): CanonicalInstrument {
  return Object.freeze({
    key,
    market: "domestic",
    instrumentType: "stock",
    symbol,
    displayName: symbol,
  });
}

function customAdapter(
  id: string,
  parseRest: RestQuoteAdapter["parseRest"],
  path = "/uapi/domestic-stock/v1/quotations/inquire-price",
): RestQuoteAdapter {
  return Object.freeze({
    id,
    market: "domestic" as const,
    restDescriptor: () => ({
      method: "GET" as const,
      path,
      trId: "FHKST01010100",
      query: { FID_COND_MRKT_DIV_CODE: "UN", FID_INPUT_ISCD: "005930" },
    }),
    parseRest,
  });
}

function customQuote(
  instrument: CanonicalInstrument,
  context: { receivedAt: number; sessionEpoch: number },
  price: number,
): QuoteSample {
  return {
    symbol: instrument.symbol,
    price,
    change: 0,
    changeRate: 0,
    sign: "flat",
    source: "rest",
    receivedAt: context.receivedAt,
    sessionEpoch: context.sessionEpoch,
  };
}

function request(
  coordinator: RestCoordinator,
  marketSnapshot = openSnapshot,
  priority: "manual" | "initial" | "fallback" = "initial",
  signal?: AbortSignal,
) {
  return coordinator.requestQuote({
    adapter: domesticStockAdapter,
    instrument: instrument(),
    marketSnapshot,
    priority,
    ...(signal ? { signal } : {}),
  });
}

async function flush(rounds = 20): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

describe("RestCoordinator HTTP boundary", () => {
  it("records one shared REST transport failure for all waiters", async () => {
    const diagnostics = { record: vi.fn(), increment: vi.fn() };
    const fetch = vi.fn<RestFetch>().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ raw: "raw-secret-response" }),
    });
    const coordinator = new RestCoordinator(mutableCredentials(authorization(), fetch), {
      now: () => openNow,
      diagnostics,
    });

    await Promise.allSettled([request(coordinator), request(coordinator)]);

    expect(fetch).toHaveBeenCalledOnce();
    expect(diagnostics.record).toHaveBeenCalledOnce();
    expect(diagnostics.increment).toHaveBeenCalledOnce();
    expect(diagnostics.increment).toHaveBeenCalledWith("restFailures");
    expect(JSON.stringify(diagnostics.record.mock.calls)).not.toContain("raw-secret-response");
  });

  it("does not count cancellation or invalid instruments as REST infrastructure failures", async () => {
    const diagnostics = { record: vi.fn(), increment: vi.fn() };
    const invalidFetch = vi.fn<RestFetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ rt_cd: "1", msg1: "raw-secret-response" }),
    });
    const coordinator = new RestCoordinator(
      mutableCredentials(authorization(), invalidFetch),
      { now: () => openNow, diagnostics },
    );
    const controller = new AbortController();
    controller.abort();

    await expect(request(coordinator, openSnapshot, "initial", controller.signal)).rejects.toMatchObject({
      code: "NETWORK",
    });
    await expect(request(coordinator)).rejects.toMatchObject({ code: "INVALID_INSTRUMENT" });

    expect(diagnostics.record).toHaveBeenCalledOnce();
    expect(diagnostics.increment).not.toHaveBeenCalled();
    expect(JSON.stringify(diagnostics.record.mock.calls)).not.toContain("raw-secret-response");
  });

  it("builds the descriptor URL and exact KIS authorization headers", async () => {
    const fetch = vi.fn<RestFetch>().mockResolvedValue(successfulResponse());
    const credentials = mutableCredentials(authorization(), fetch);
    const coordinator = new RestCoordinator(credentials, {
      now: () => openNow,
    });

    await expect(request(coordinator)).resolves.toEqual({
      symbol: "005930",
      price: 71_200,
      change: 1_200,
      changeRate: 1.25,
      sign: "rise",
      source: "rest",
      receivedAt: openNow,
      sessionEpoch: openSnapshot.sessionEpoch,
    });
    const [url, init] = fetch.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://openapi.koreainvestment.com:9443");
    expect(parsed.pathname).toBe("/uapi/domestic-stock/v1/quotations/inquire-price");
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      FID_COND_MRKT_DIV_CODE: "UN",
      FID_INPUT_ISCD: "005930",
    });
    expect(init.headers).toEqual({
      "Content-Type": "application/json; charset=utf-8",
      authorization: "Bearer access-token-3",
      appkey: "app-key-3",
      appsecret: "app-secret-3",
      tr_id: "FHKST01010100",
      custtype: "P",
    });
  });

  it("invalidates a rejected token using the exact generation-version CAS lease", async () => {
    const fetch = vi.fn<RestFetch>().mockResolvedValue({ ok: false, status: 401 });
    const credentials = mutableCredentials(authorization(8, 13), fetch);
    const coordinator = new RestCoordinator(credentials, { now: () => openNow });

    const error = await request(coordinator).catch((value: unknown) => value) as {
      readonly code?: unknown;
    };
    expect(error).toMatchObject({ code: "AUTH_REJECTED", scope: "rest", retryable: true });
    expect(credentials.invalidateAccessToken).toHaveBeenCalledOnce();
    expect(credentials.invalidateAccessToken).toHaveBeenCalledWith({
      credentialGeneration: 8,
      credentialFingerprint: "fingerprint-8",
      tokenVersion: 13,
    });
    expect(JSON.stringify(error)).not.toContain("access-token-8");
    expect(JSON.stringify(error)).not.toContain("app-secret-8");
  });

  it("does not negative-cache 401 and immediately retries with the replacement token", async () => {
    const fetch = vi.fn<RestFetch>()
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce(successfulResponse("72000"));
    const credentials = mutableCredentials(authorization(3, 5), fetch);
    const diagnostics = { record: vi.fn(), increment: vi.fn() };
    credentials.invalidateAccessToken.mockImplementation(async () => {
      credentials.current = Object.freeze({
        ...authorization(3, 6),
        token: "replacement-token",
      });
      return true;
    });
    const coordinator = new RestCoordinator(credentials, {
      now: () => openNow,
      diagnostics,
    });

    await expect(request(coordinator)).rejects.toMatchObject({ code: "AUTH_REJECTED" });
    await expect(request(coordinator)).resolves.toMatchObject({ price: 72_000 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1].headers.authorization).toBe("Bearer replacement-token");
    expect(diagnostics.record).toHaveBeenCalledOnce();
    expect(diagnostics.increment).toHaveBeenCalledOnce();
  });

  it("refreshes an authorization invalidated while its flight waits for the transport gate", async () => {
    let calls = 0;
    const fetch = vi.fn<RestFetch>(async () => {
      calls += 1;
      return calls === 1 ? { ok: false, status: 401 } : successfulResponse("72000");
    });
    const credentials = mutableCredentials(authorization(3, 5), fetch);
    credentials.invalidateAccessToken.mockImplementation(async () => {
      credentials.current = Object.freeze({
        ...authorization(3, 6),
        token: "replacement-token",
      });
      return true;
    });
    const coordinator = new RestCoordinator(credentials, { now: () => openNow });
    const results = await Promise.allSettled(Array.from({ length: 11 }, (_, index) =>
      coordinator.requestQuote({
        adapter: domesticStockAdapter,
        instrument: instrument(String(index + 1).padStart(6, "0")),
        marketSnapshot: openSnapshot,
        priority: index === 10 ? "manual" : "initial",
      }),
    ));

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(10);
    expect(fetch).toHaveBeenCalledTimes(11);
    expect(fetch.mock.calls[10][1].headers.authorization).toBe("Bearer replacement-token");
  });

  it.each([
    ["primitive response", null],
    ["contradictory status", { ok: true, status: 401, json: async () => ({}) }],
    ["missing json", { ok: true, status: 200 }],
    ["throwing json", { ok: true, status: 200, json: async () => { throw new Error("raw-secret"); } }],
    ["primitive payload", { ok: true, status: 200, json: async () => "raw-secret" }],
    ["business rejection", { ok: true, status: 200, json: async () => ({ rt_cd: "1", msg1: "raw-secret" }) }],
  ])("sanitizes malformed HTTP boundaries: %s", async (_label, response) => {
    const fetch = vi.fn<RestFetch>().mockResolvedValue(response);
    const coordinator = new RestCoordinator(mutableCredentials(authorization(), fetch), {
      now: () => openNow,
    });
    const error = await request(coordinator).catch((value: unknown) => value) as {
      readonly code?: unknown;
    };

    expect(error).toBeInstanceOf(Object);
    expect(error).toMatchObject({ scope: "rest" });
    expect(["PROTOCOL", "INVALID_INSTRUMENT"]).toContain(error.code);
    expect(JSON.stringify(error)).not.toContain("raw-secret");
    expect(JSON.stringify(error)).not.toContain("app-secret");
  });

  it("turns response getters and proxy traps into a safe protocol error", async () => {
    const malicious = new Proxy({}, {
      get() { throw new Error("access-token-3 app-secret-3"); },
    });
    const fetch = vi.fn<RestFetch>().mockResolvedValue(malicious);
    const coordinator = new RestCoordinator(mutableCredentials(authorization(), fetch), {
      now: () => openNow,
    });

    const error = await request(coordinator).catch((value: unknown) => value) as {
      readonly code?: unknown;
    };
    expect(error).toMatchObject({ scope: "rest" });
    expect(["NETWORK", "PROTOCOL"]).toContain(error.code);
    expect(JSON.stringify(error)).not.toContain("access-token-3");
    expect(JSON.stringify(error)).not.toContain("app-secret-3");
  });

  it("turns a revoked payload proxy into a safe protocol error", async () => {
    const target = {};
    const revocable = Proxy.revocable(target, {});
    revocable.revoke();
    const fetch = vi.fn<RestFetch>().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => revocable.proxy,
      });
    const coordinator = new RestCoordinator(mutableCredentials(authorization(), fetch), {
      now: () => openNow,
    });

    await expect(request(coordinator)).rejects.toMatchObject({
      code: "PROTOCOL",
      scope: "rest",
    });
  });

  it("rejects non-allowlisted canonical REST endpoint paths before fetch", async () => {
    const fetch = vi.fn<RestFetch>();
    const adapter = customAdapter(
      "malicious-path",
      (payload, instrumentValue, context) => customQuote(instrumentValue, context, 1),
      "/uapi/../oauth2/tokenP",
    );
    const coordinator = new RestCoordinator(mutableCredentials(authorization(), fetch), {
      now: () => openNow,
    });

    await expect(coordinator.requestQuote({
      adapter,
      instrument: customInstrument("path-key"),
      marketSnapshot: openSnapshot,
      priority: "initial",
    })).rejects.toMatchObject({ code: "PROTOCOL", scope: "rest" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("discards a response when its credential generation changes in flight", async () => {
    let resolveFetch!: (value: unknown) => void;
    const fetch = vi.fn<RestFetch>(() => new Promise((resolve) => { resolveFetch = resolve; }));
    const credentials = mutableCredentials(authorization(3), fetch);
    const coordinator = new RestCoordinator(credentials, { now: () => openNow });

    const pending = request(coordinator);
    while (fetch.mock.calls.length === 0) await Promise.resolve();
    credentials.current = authorization(4);
    resolveFetch(successfulResponse());

    await expect(pending).rejects.toMatchObject({ code: "AUTH_REJECTED", scope: "rest" });
    fetch.mockResolvedValue(successfulResponse());
    await expect(request(coordinator)).resolves.toMatchObject({ price: 71_200 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("discards a quote completed exactly at the market session transition", async () => {
    let now = openSnapshot.nextTransitionAt - 1;
    let resolveJson!: (value: unknown) => void;
    const fetch = vi.fn<RestFetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => new Promise((resolve) => { resolveJson = resolve; }),
    });
    const coordinator = new RestCoordinator(mutableCredentials(authorization(), fetch), {
      now: () => now,
    });

    const pending = request(coordinator);
    await flush();
    expect(resolveJson).toBeTypeOf("function");
    now = openSnapshot.nextTransitionAt;
    resolveJson({
      rt_cd: "0",
      output: { stck_prpr: "71000", prdy_vrss_sign: "3", prdy_vrss: "0", prdy_ctrt: "0" },
    });

    await expect(pending).rejects.toMatchObject({
      code: "TIMEOUT",
      scope: "rest",
      retryable: true,
    });
  });

  it("rechecks the transition before settling or success-caching the quote", async () => {
    let now = closedSnapshot.nextTransitionAt - 1;
    let resolveJson!: (value: unknown) => void;
    const fetch = vi.fn<RestFetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => new Promise((resolve) => { resolveJson = resolve; }),
    });
    const coordinator = new RestCoordinator(mutableCredentials(authorization(), fetch), {
      now: () => now,
    });

    const pending = request(coordinator, closedSnapshot);
    await flush();
    resolveJson({
      rt_cd: "0",
      output: { stck_prpr: "71000", prdy_vrss_sign: "3", prdy_vrss: "0", prdy_ctrt: "0" },
    });
    queueMicrotask(() => { now = closedSnapshot.nextTransitionAt; });

    await expect(pending).rejects.toMatchObject({ code: "TIMEOUT", scope: "rest" });
    fetch.mockResolvedValue(successfulResponse("72000"));
    await expect(request(coordinator, {
      ...closedSnapshot,
      sessionEpoch: closedSnapshot.nextTransitionAt,
      nextTransitionAt: closedSnapshot.nextTransitionAt + 60_000,
    })).resolves.toMatchObject({ price: 72_000 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects stale and non-finite transition inputs through safe boundaries", async () => {
    const fetch = vi.fn<RestFetch>().mockResolvedValue(successfulResponse());
    const staleCoordinator = new RestCoordinator(mutableCredentials(authorization(), fetch), {
      now: () => openSnapshot.nextTransitionAt,
    });
    await expect(request(staleCoordinator)).rejects.toMatchObject({
      code: "TIMEOUT",
      scope: "rest",
    });

    const invalidCoordinator = new RestCoordinator(mutableCredentials(authorization(), fetch), {
      now: () => openNow,
    });
    await expect(invalidCoordinator.requestQuote({
      adapter: domesticStockAdapter,
      instrument: instrument(),
      marketSnapshot: { ...openSnapshot, nextTransitionAt: Number.NaN },
      priority: "initial",
    })).rejects.toMatchObject({ code: "PROTOCOL", scope: "rest" });
    expect(JSON.stringify(await invalidCoordinator.requestQuote({
      adapter: domesticStockAdapter,
      instrument: instrument(),
      marketSnapshot: { ...openSnapshot, nextTransitionAt: Number.POSITIVE_INFINITY },
      priority: "initial",
    }).catch((error: unknown) => error))).not.toContain("app-secret");
  });

  it("settles a cancelled waiter before a late JSON body and never caches that body", async () => {
    let resolveJson!: (value: unknown) => void;
    const fetch = vi.fn<RestFetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => new Promise((resolve) => { resolveJson = resolve; }),
    });
    const coordinator = new RestCoordinator(mutableCredentials(authorization(), fetch), {
      now: () => closedNow,
    });
    const abort = new AbortController();
    const pending = request(coordinator, closedSnapshot, "initial", abort.signal);
    await flush();
    abort.abort();

    await expect(pending).rejects.toMatchObject({ code: "NETWORK", scope: "rest" });
    resolveJson({
      rt_cd: "0",
      output: { stck_prpr: "99999", prdy_vrss_sign: "3", prdy_vrss: "0", prdy_ctrt: "0" },
    });
    await flush();
    fetch.mockResolvedValue(successfulResponse("70000"));
    await expect(request(coordinator, closedSnapshot)).resolves.toMatchObject({ price: 70_000 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("RestCoordinator cache policy", () => {
  it("uses collision-proof structured keys for flights and caches", async () => {
    const firstAdapter = customAdapter(
      "a|b",
      (_payload, instrumentValue, context) => customQuote(instrumentValue, context, 71_000),
    );
    const secondAdapter = customAdapter(
      "a",
      (_payload, instrumentValue, context) => customQuote(instrumentValue, context, 72_000),
    );
    const fetch = vi.fn<RestFetch>().mockResolvedValue(successfulResponse());
    const coordinator = new RestCoordinator(mutableCredentials(authorization(), fetch), {
      now: () => closedNow,
    });

    await expect(coordinator.requestQuote({
      adapter: firstAdapter,
      instrument: customInstrument("c", "FIRST"),
      marketSnapshot: closedSnapshot,
      priority: "initial",
    })).resolves.toMatchObject({ price: 71_000, symbol: "FIRST" });
    await expect(coordinator.requestQuote({
      adapter: secondAdapter,
      instrument: customInstrument("b|c", "SECOND"),
      marketSnapshot: closedSnapshot,
      priority: "initial",
    })).resolves.toMatchObject({ price: 72_000, symbol: "SECOND" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("clones and freezes adapter quotes before sharing a closed-session cache", async () => {
    let mutableQuote: QuoteSample | undefined;
    const adapter = customAdapter("mutable-quote", (_payload, instrumentValue, context) => {
      mutableQuote = customQuote(instrumentValue, context, 71_000);
      return mutableQuote;
    });
    const fetch = vi.fn<RestFetch>().mockResolvedValue(successfulResponse());
    const coordinator = new RestCoordinator(mutableCredentials(authorization(), fetch), {
      now: () => closedNow,
    });
    const input = {
      adapter,
      instrument: customInstrument("mutable-key", "SAFE"),
      marketSnapshot: closedSnapshot,
      priority: "initial" as const,
    };

    const first = await coordinator.requestQuote(input);
    expect(Object.isFrozen(first)).toBe(true);
    (mutableQuote as { price: number }).price = 1;
    (mutableQuote as { change: number }).change = 999;
    const cached = await coordinator.requestQuote(input);
    expect(cached).toMatchObject({ symbol: "SAFE", price: 71_000, change: 0 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects missing, non-finite, accessor, and extra native change fields", async () => {
    let getterCalls = 0;
    const invalidAdapters = [
      customAdapter("missing-change", (_payload, instrumentValue, context) => {
        const { change: _change, ...quoteWithoutChange } =
          customQuote(instrumentValue, context, 71_000);
        return quoteWithoutChange as QuoteSample;
      }),
      customAdapter("nan-change", (_payload, instrumentValue, context) => ({
        ...customQuote(instrumentValue, context, 71_000),
        change: Number.NaN,
      })),
      customAdapter("infinite-change", (_payload, instrumentValue, context) => ({
        ...customQuote(instrumentValue, context, 71_000),
        change: Number.POSITIVE_INFINITY,
      })),
      customAdapter("accessor-change", (_payload, instrumentValue, context) => {
        const quote = customQuote(instrumentValue, context, 71_000);
        Object.defineProperty(quote, "change", {
          enumerable: true,
          get: () => {
            getterCalls += 1;
            return 0;
          },
        });
        return quote;
      }),
      customAdapter("extra-change-key", (_payload, instrumentValue, context) => ({
        ...customQuote(instrumentValue, context, 71_000),
        extra: "unsafe",
      })),
      customAdapter("symbol-change-key", (_payload, instrumentValue, context) => ({
        ...customQuote(instrumentValue, context, 71_000),
        [Symbol("unsafe")]: "unsafe",
      })),
    ];

    for (const adapter of invalidAdapters) {
      const fetch = vi.fn<RestFetch>().mockResolvedValue(successfulResponse());
      const coordinator = new RestCoordinator(mutableCredentials(authorization(), fetch), {
        now: () => openNow,
      });

      await expect(coordinator.requestQuote({
        adapter,
        instrument: customInstrument(adapter.id, "SAFE"),
        marketSnapshot: openSnapshot,
        priority: "initial",
      })).rejects.toMatchObject({ code: "PROTOCOL", scope: "rest" });
    }

    expect(getterCalls).toBe(0);
  });

  it("uses one descriptor snapshot so a stateful quote proxy cannot inject an unvalidated symbol", async () => {
    let ownKeysCalls = 0;
    let symbolDescriptorReads = 0;
    const extraSymbol = Symbol("unexpected-quote-key");
    const adapter = customAdapter("stateful-symbol-quote", (
      _payload,
      instrumentValue,
      context,
    ) => {
      const target = customQuote(instrumentValue, context, 71_000);
      return new Proxy(target, {
        ownKeys(value) {
          ownKeysCalls += 1;
          const keys = Reflect.ownKeys(value);
          return ownKeysCalls === 1 ? keys : [...keys, extraSymbol];
        },
        getOwnPropertyDescriptor(value, key) {
          if (key === extraSymbol) {
            symbolDescriptorReads += 1;
            return {
              configurable: true,
              enumerable: true,
              value: "unsafe",
              writable: false,
            };
          }
          return Reflect.getOwnPropertyDescriptor(value, key);
        },
      });
    });
    const fetch = vi.fn<RestFetch>().mockResolvedValue(successfulResponse());
    const coordinator = new RestCoordinator(mutableCredentials(authorization(), fetch), {
      now: () => openNow,
    });

    await expect(coordinator.requestQuote({
      adapter,
      instrument: customInstrument(adapter.id, "SAFE"),
      marketSnapshot: openSnapshot,
      priority: "initial",
    })).resolves.toMatchObject({ symbol: "SAFE", change: 0 });
    expect(ownKeysCalls).toBe(1);
    expect(symbolDescriptorReads).toBe(0);
  });

  it("rejects accessor or context-mismatched adapter quotes at the coordinator boundary", async () => {
    const accessorAdapter = customAdapter("accessor-quote", (_payload, instrumentValue, context) => {
      const quote = customQuote(instrumentValue, context, 71_000);
      Object.defineProperty(quote, "price", {
        enumerable: true,
        get: () => { throw new Error("app-secret leaked from quote getter"); },
      });
      return quote;
    });
    const mismatchAdapter = customAdapter("mismatch-quote", (_payload, instrumentValue, context) => ({
      ...customQuote(instrumentValue, context, 71_000),
      receivedAt: context.receivedAt + 1,
    }));
    for (const adapter of [accessorAdapter, mismatchAdapter]) {
      const fetch = vi.fn<RestFetch>().mockResolvedValue(successfulResponse());
      const coordinator = new RestCoordinator(mutableCredentials(authorization(), fetch), {
        now: () => openNow,
      });
      const error = await coordinator.requestQuote({
        adapter,
        instrument: customInstrument(adapter.id, "SAFE"),
        marketSnapshot: openSnapshot,
        priority: "initial",
      }).catch((value: unknown) => value);
      expect(error).toMatchObject({ code: "PROTOCOL", scope: "rest" });
      expect(JSON.stringify(error)).not.toContain("app-secret");
    }
  });

  it("sanitizes and freezes adapter KisErrors before negative-cache sharing", async () => {
    const adapter = customAdapter("unsafe-error", () => {
      throw new KisError({
        code: "PROTOCOL",
        scope: "action",
        retryable: false,
        safeMessage: "app-secret and raw response leaked",
      });
    });
    const fetch = vi.fn<RestFetch>().mockResolvedValue(successfulResponse());
    const coordinator = new RestCoordinator(mutableCredentials(authorization(), fetch), {
      now: () => openNow,
    });
    const input = {
      adapter,
      instrument: customInstrument("unsafe-error", "SAFE"),
      marketSnapshot: openSnapshot,
      priority: "initial" as const,
    };

    const first = await coordinator.requestQuote(input).catch((value: unknown) => value) as KisError;
    expect(first).toMatchObject({ code: "PROTOCOL", scope: "rest" });
    expect(Object.isFrozen(first)).toBe(true);
    expect(JSON.stringify(first)).not.toContain("app-secret");
    expect(() => Object.defineProperty(first, "code", { value: "NETWORK" })).toThrow();
    const second = await coordinator.requestQuote(input).catch((value: unknown) => value);
    expect(second).toMatchObject({ code: "PROTOCOL", scope: "rest" });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("reuses closed-session success only for the same instrument, session and credential generation", async () => {
    const fetch = vi.fn<RestFetch>().mockResolvedValue(successfulResponse());
    const credentials = mutableCredentials(authorization(2), fetch);
    let now = closedNow;
    const coordinator = new RestCoordinator(credentials, { now: () => now });

    await request(coordinator, closedSnapshot);
    await request(coordinator, closedSnapshot);
    expect(fetch).toHaveBeenCalledOnce();

    const nextClosedSession = snapshot("2026-07-07T10:00:00.000Z");
    now = Date.parse("2026-07-07T10:00:00.000Z");
    await request(coordinator, nextClosedSession);
    expect(fetch).toHaveBeenCalledTimes(2);

    credentials.current = authorization(3);
    await request(coordinator, nextClosedSession);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("always executes a manual closed-session request without replacing the automatic cache", async () => {
    const fetch = vi.fn<RestFetch>()
      .mockResolvedValueOnce(successfulResponse("71000"))
      .mockResolvedValueOnce(successfulResponse("72000"));
    const coordinator = new RestCoordinator(mutableCredentials(authorization(), fetch), {
      now: () => closedNow,
    });

    await expect(request(coordinator, closedSnapshot)).resolves.toMatchObject({ price: 71_000 });
    await expect(request(coordinator, closedSnapshot, "manual")).resolves.toMatchObject({ price: 72_000 });
    await expect(request(coordinator, closedSnapshot)).resolves.toMatchObject({ price: 71_000 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("negative-caches failures for 30 seconds while manual requests bypass them", async () => {
    let now = 10_000;
    const fetch = vi.fn<RestFetch>()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce(successfulResponse("73000"))
      .mockResolvedValueOnce(successfulResponse("74000"));
    const coordinator = new RestCoordinator(mutableCredentials(authorization(), fetch), {
      now: () => now,
    });

    await expect(request(coordinator)).rejects.toMatchObject({ code: "NETWORK" });
    await expect(request(coordinator)).rejects.toMatchObject({ code: "NETWORK" });
    expect(fetch).toHaveBeenCalledOnce();

    await expect(request(coordinator, openSnapshot, "manual")).resolves.toMatchObject({ price: 73_000 });
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(request(coordinator)).rejects.toMatchObject({ code: "NETWORK" });

    now += 30_000;
    await expect(request(coordinator)).resolves.toMatchObject({ price: 74_000 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not return a success cache crossed during credential initialization", async () => {
    const transitionAt = closedNow + 20_000;
    const shortSession = { ...closedSnapshot, nextTransitionAt: transitionAt };
    let now = closedNow;
    const fetch = vi.fn<RestFetch>().mockResolvedValue(successfulResponse("71000"));
    const credentials = mutableCredentials(authorization(), fetch);
    const coordinator = new RestCoordinator(credentials, { now: () => now });
    await expect(request(coordinator, shortSession)).resolves.toMatchObject({ price: 71_000 });

    let releaseInitialize!: () => void;
    credentials.initialize.mockImplementationOnce(() => new Promise((resolve) => {
      releaseInitialize = () => resolve(identity(credentials.current));
    }));
    now = transitionAt - 1;
    const pending = request(coordinator, shortSession);
    await flush();
    expect(releaseInitialize).toBeTypeOf("function");
    now = transitionAt;
    releaseInitialize();

    await expect(pending).rejects.toMatchObject({ code: "TIMEOUT", scope: "rest" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not return a negative cache crossed during credential initialization", async () => {
    const transitionAt = closedNow + 20_000;
    const shortSession = { ...closedSnapshot, nextTransitionAt: transitionAt };
    let now = closedNow;
    const fetch = vi.fn<RestFetch>().mockResolvedValue({ ok: false, status: 503 });
    const credentials = mutableCredentials(authorization(), fetch);
    const coordinator = new RestCoordinator(credentials, { now: () => now });
    await expect(request(coordinator, shortSession)).rejects.toMatchObject({ code: "NETWORK" });

    let releaseInitialize!: () => void;
    credentials.initialize.mockImplementationOnce(() => new Promise((resolve) => {
      releaseInitialize = () => resolve(identity(credentials.current));
    }));
    now = transitionAt - 1;
    const pending = request(coordinator, shortSession);
    await flush();
    expect(releaseInitialize).toBeTypeOf("function");
    now = transitionAt;
    releaseInitialize();

    await expect(pending).rejects.toMatchObject({ code: "TIMEOUT", scope: "rest" });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
