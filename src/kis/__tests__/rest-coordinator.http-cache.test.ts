import { describe, expect, it, vi } from "vitest";
import { getMarketSnapshot, type MarketSnapshot } from "../../core/market-clock.js";
import { domesticStockAdapter } from "../../markets/market-adapter.js";
import type {
  AccessTokenExpectation,
  CredentialIdentity,
  RestAuthorizationLease,
} from "../credential-session.js";
import {
  RestCoordinator,
  type RestCredentialPort,
  type RestFetch,
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

function mutableCredentials(initial = authorization()): RestCredentialPort & {
  current: RestAuthorizationLease;
  initialize: ReturnType<typeof vi.fn>;
  getRestAuthorization: ReturnType<typeof vi.fn>;
  invalidateAccessToken: ReturnType<typeof vi.fn>;
} {
  const port = {
    current: initial,
    initialize: vi.fn(async () => identity(port.current)),
    getRestAuthorization: vi.fn(async () => port.current),
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
        prdy_ctrt: "1.25",
      },
    }),
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
  it("builds the descriptor URL and exact KIS authorization headers", async () => {
    const credentials = mutableCredentials();
    const fetch = vi.fn<RestFetch>().mockResolvedValue(successfulResponse());
    const coordinator = new RestCoordinator(credentials, {
      fetch,
      now: () => 1_900_000_000_000,
    });

    await expect(request(coordinator)).resolves.toEqual({
      symbol: "005930",
      price: 71_200,
      changeRate: 1.25,
      sign: "rise",
      source: "rest",
      receivedAt: 1_900_000_000_000,
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
    const credentials = mutableCredentials(authorization(8, 13));
    const fetch = vi.fn<RestFetch>().mockResolvedValue({ ok: false, status: 401 });
    const coordinator = new RestCoordinator(credentials, { fetch });

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

  it.each([
    ["primitive response", null],
    ["contradictory status", { ok: true, status: 401, json: async () => ({}) }],
    ["missing json", { ok: true, status: 200 }],
    ["throwing json", { ok: true, status: 200, json: async () => { throw new Error("raw-secret"); } }],
    ["primitive payload", { ok: true, status: 200, json: async () => "raw-secret" }],
    ["business rejection", { ok: true, status: 200, json: async () => ({ rt_cd: "1", msg1: "raw-secret" }) }],
  ])("sanitizes malformed HTTP boundaries: %s", async (_label, response) => {
    const coordinator = new RestCoordinator(mutableCredentials(), {
      fetch: vi.fn<RestFetch>().mockResolvedValue(response),
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
    const coordinator = new RestCoordinator(mutableCredentials(), {
      fetch: vi.fn<RestFetch>().mockResolvedValue(malicious),
    });

    const error = await request(coordinator).catch((value: unknown) => value) as {
      readonly code?: unknown;
    };
    expect(error).toMatchObject({ scope: "rest" });
    expect(["NETWORK", "PROTOCOL"]).toContain(error.code);
    expect(JSON.stringify(error)).not.toContain("access-token-3");
    expect(JSON.stringify(error)).not.toContain("app-secret-3");
  });

  it("discards a response when its credential generation changes in flight", async () => {
    const credentials = mutableCredentials(authorization(3));
    let resolveFetch!: (value: unknown) => void;
    const fetch = vi.fn<RestFetch>(() => new Promise((resolve) => { resolveFetch = resolve; }));
    const coordinator = new RestCoordinator(credentials, { fetch });

    const pending = request(coordinator);
    while (fetch.mock.calls.length === 0) await Promise.resolve();
    credentials.current = authorization(4);
    resolveFetch(successfulResponse());

    await expect(pending).rejects.toMatchObject({ code: "AUTH_REJECTED", scope: "rest" });
    fetch.mockResolvedValue(successfulResponse());
    await expect(request(coordinator)).resolves.toMatchObject({ price: 71_200 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("settles a cancelled waiter before a late JSON body and never caches that body", async () => {
    let resolveJson!: (value: unknown) => void;
    const fetch = vi.fn<RestFetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => new Promise((resolve) => { resolveJson = resolve; }),
    });
    const coordinator = new RestCoordinator(mutableCredentials(), { fetch });
    const abort = new AbortController();
    const pending = request(coordinator, closedSnapshot, "initial", abort.signal);
    await flush();
    abort.abort();

    await expect(pending).rejects.toMatchObject({ code: "NETWORK", scope: "rest" });
    resolveJson({
      rt_cd: "0",
      output: { stck_prpr: "99999", prdy_vrss_sign: "3", prdy_ctrt: "0" },
    });
    await flush();
    fetch.mockResolvedValue(successfulResponse("70000"));
    await expect(request(coordinator, closedSnapshot)).resolves.toMatchObject({ price: 70_000 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("RestCoordinator cache policy", () => {
  it("reuses closed-session success only for the same instrument, session and credential generation", async () => {
    const credentials = mutableCredentials(authorization(2));
    const fetch = vi.fn<RestFetch>().mockResolvedValue(successfulResponse());
    const coordinator = new RestCoordinator(credentials, { fetch });

    await request(coordinator, closedSnapshot);
    await request(coordinator, closedSnapshot);
    expect(fetch).toHaveBeenCalledOnce();

    const nextClosedSession = snapshot("2026-07-07T10:00:00.000Z");
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
    const coordinator = new RestCoordinator(mutableCredentials(), { fetch });

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
    const coordinator = new RestCoordinator(mutableCredentials(), {
      fetch,
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
});
