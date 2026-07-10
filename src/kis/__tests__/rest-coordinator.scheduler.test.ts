import { afterEach, describe, expect, it, vi } from "vitest";
import { getMarketSnapshot } from "../../core/market-clock.js";
import { domesticStockAdapter } from "../../markets/market-adapter.js";
import type {
  AccessTokenExpectation,
  CredentialIdentity,
  PreparedRestAuthorization,
  PreparedRestFetch,
  PreparedRestRequest,
  RestAuthorizationLease,
} from "../credential-session.js";
import {
  RestCoordinator,
  type RestCredentialPort,
  type RestFetch,
} from "../rest-coordinator.js";

const fingerprint = "fingerprint";
const lease: RestAuthorizationLease = Object.freeze({
  appKey: "app-key",
  appSecret: "app-secret",
  token: "access-token",
  expiresAt: 9_999_999_999_999,
  credentialGeneration: 3,
  credentialFingerprint: fingerprint,
  tokenVersion: 5,
});

function preparedAuthorization(): PreparedRestAuthorization {
  let used = false;
  return Object.freeze({
    expectation: Object.freeze({
      credentialGeneration: lease.credentialGeneration,
      credentialFingerprint: lease.credentialFingerprint,
      tokenVersion: lease.tokenVersion,
    }),
    isCurrent: () => true,
    execute: (request: PreparedRestRequest, fetch: PreparedRestFetch) => {
      if (used) throw new Error("used capability");
      used = true;
      return fetch(request.url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${lease.token}`,
          appkey: lease.appKey,
          appsecret: lease.appSecret,
          tr_id: request.trId,
        },
        signal: request.signal,
      });
    },
  });
}

function credentials(): RestCredentialPort & {
  invalidateAccessToken: ReturnType<typeof vi.fn>;
} {
  return {
    initialize: vi.fn(async (): Promise<CredentialIdentity> => ({
      configured: true,
      credentialGeneration: lease.credentialGeneration,
      credentialFingerprint: fingerprint,
    })),
    prepareRestAuthorization: vi.fn(async () => preparedAuthorization()),
    invalidateAccessToken: vi.fn(async (_expected: AccessTokenExpectation) => true),
  };
}

function instrument(index: number) {
  return domesticStockAdapter.toInstrument({ stockCode: String(index).padStart(6, "0") });
}

const marketNow = Date.parse("2026-07-06T01:00:00.000Z");
const marketSnapshot = getMarketSnapshot("domestic", marketNow);

function successfulResponse(price = "1000"): unknown {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      rt_cd: "0",
      output: { stck_prpr: price, prdy_vrss_sign: "3", prdy_ctrt: "0" },
    }),
  };
}

async function flush(rounds = 30): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RestCoordinator scheduler", () => {
  it("runs at most four HTTP requests concurrently", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    const fetch = vi.fn<RestFetch>(() => new Promise((resolve) => {
      resolvers.push(resolve);
    }));
    const coordinator = new RestCoordinator(credentials(), { fetch, now: () => marketNow });
    const requests = Array.from({ length: 5 }, (_, index) => coordinator.requestQuote({
      adapter: domesticStockAdapter,
      instrument: instrument(index + 1),
      marketSnapshot,
      priority: "initial",
    }));

    await flush();
    expect(fetch).toHaveBeenCalledTimes(4);
    resolvers[0](successfulResponse());
    await flush();
    expect(fetch).toHaveBeenCalledTimes(5);

    for (const resolve of resolvers.slice(1)) resolve(successfulResponse());
    await expect(Promise.all(requests)).resolves.toHaveLength(5);
  });

  it("starts no more than ten requests in a sliding one-second window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const starts: number[] = [];
    const fetch = vi.fn<RestFetch>(async () => {
      starts.push(Date.now());
      return successfulResponse();
    });
    const coordinator = new RestCoordinator(credentials(), {
      fetch,
      now: () => Date.now(),
    });
    const requests = Array.from({ length: 11 }, (_, index) => coordinator.requestQuote({
      adapter: domesticStockAdapter,
      instrument: instrument(index + 1),
      marketSnapshot,
      priority: "initial",
    }));

    await flush(80);
    expect(starts).toHaveLength(10);
    expect(starts).toEqual(Array(10).fill(0));
    await vi.advanceTimersByTimeAsync(999);
    expect(starts).toHaveLength(10);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(starts).toHaveLength(11);
    expect(starts[10]).toBe(1_000);
    await expect(Promise.all(requests)).resolves.toHaveLength(11);
  });

  it("rates the actual HTTP start even when authorization finishes much later", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const authorizationResolvers: Array<() => void> = [];
    const port = credentials();
    port.prepareRestAuthorization = vi.fn(
      () => new Promise<PreparedRestAuthorization>((resolve) => {
      authorizationResolvers.push(() => {
        resolve(preparedAuthorization());
      });
    }));
    const starts: number[] = [];
    const fetch = vi.fn<RestFetch>(async () => {
      starts.push(Date.now());
      return successfulResponse();
    });
    const coordinator = new RestCoordinator(port, { fetch, now: () => Date.now() });
    const requests = Array.from({ length: 14 }, (_, index) => coordinator.requestQuote({
      adapter: domesticStockAdapter,
      instrument: instrument(index + 1),
      marketSnapshot,
      priority: "initial",
    }));
    await flush();
    expect(authorizationResolvers).toHaveLength(14);

    await vi.advanceTimersByTimeAsync(2_000);
    for (const resolve of authorizationResolvers) resolve();
    await flush(120);
    expect(starts).toHaveLength(10);
    expect(starts).toEqual(Array(10).fill(2_000));
    await vi.advanceTimersByTimeAsync(999);
    expect(starts).toHaveLength(10);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(starts).toHaveLength(14);
    expect(starts.slice(10)).toEqual(Array(4).fill(3_000));
    await expect(Promise.all(requests)).resolves.toHaveLength(14);
  });

  it("orders queued work manual, initial, fallback and preserves FIFO within a priority", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    const fetch = vi.fn<RestFetch>(() => new Promise((resolve) => {
      resolvers.push(resolve);
    }));
    const coordinator = new RestCoordinator(credentials(), { fetch, now: () => marketNow });
    const pending = [1, 2, 3, 4].map((index) => coordinator.requestQuote({
      adapter: domesticStockAdapter,
      instrument: instrument(index),
      marketSnapshot,
      priority: "fallback" as const,
    }));
    pending.push(coordinator.requestQuote({
      adapter: domesticStockAdapter,
      instrument: instrument(5),
      marketSnapshot,
      priority: "fallback",
    }));
    pending.push(coordinator.requestQuote({
      adapter: domesticStockAdapter,
      instrument: instrument(6),
      marketSnapshot,
      priority: "manual",
    }));
    pending.push(coordinator.requestQuote({
      adapter: domesticStockAdapter,
      instrument: instrument(7),
      marketSnapshot,
      priority: "initial",
    }));
    pending.push(coordinator.requestQuote({
      adapter: domesticStockAdapter,
      instrument: instrument(8),
      marketSnapshot,
      priority: "manual",
    }));
    await flush();

    resolvers[0](successfulResponse());
    await flush();
    expect(new URL(fetch.mock.calls[4][0]).searchParams.get("FID_INPUT_ISCD")).toBe("000006");
    resolvers[1](successfulResponse());
    await flush();
    expect(new URL(fetch.mock.calls[5][0]).searchParams.get("FID_INPUT_ISCD")).toBe("000008");
    resolvers[2](successfulResponse());
    await flush();
    expect(new URL(fetch.mock.calls[6][0]).searchParams.get("FID_INPUT_ISCD")).toBe("000007");
    resolvers[3](successfulResponse());
    await flush();
    expect(new URL(fetch.mock.calls[7][0]).searchParams.get("FID_INPUT_ISCD")).toBe("000005");

    for (const resolve of resolvers.slice(4)) resolve(successfulResponse());
    await expect(Promise.all(pending)).resolves.toHaveLength(8);
  });

  it("deduplicates a flight while allowing each waiter to cancel independently", async () => {
    let resolveFetch!: (value: unknown) => void;
    let transportSignal!: AbortSignal;
    const fetch = vi.fn<RestFetch>((_url, init) => {
      transportSignal = init.signal;
      return new Promise((resolve) => { resolveFetch = resolve; });
    });
    const coordinator = new RestCoordinator(credentials(), { fetch, now: () => marketNow });
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const input = {
      adapter: domesticStockAdapter,
      instrument: instrument(1),
      marketSnapshot,
      priority: "initial" as const,
    };
    const first = coordinator.requestQuote({ ...input, signal: firstAbort.signal });
    const second = coordinator.requestQuote({ ...input, signal: secondAbort.signal });
    await flush();
    expect(fetch).toHaveBeenCalledOnce();

    firstAbort.abort();
    await expect(first).rejects.toMatchObject({ code: "NETWORK", scope: "rest" });
    expect(transportSignal.aborted).toBe(false);
    secondAbort.abort();
    await expect(second).rejects.toMatchObject({ code: "NETWORK", scope: "rest" });
    expect(transportSignal.aborted).toBe(true);
    resolveFetch(successfulResponse());
    await flush();
  });

  it("lets a new same-key flight proceed while the abandoned flight body is still hanging", async () => {
    const jsonResolvers: Array<(value: unknown) => void> = [];
    const fetch = vi.fn<RestFetch>().mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: () => new Promise((resolve) => { jsonResolvers.push(resolve); }),
    }));
    const coordinator = new RestCoordinator(credentials(), { fetch, now: () => marketNow });
    const abort = new AbortController();
    const input = {
      adapter: domesticStockAdapter,
      instrument: instrument(1),
      marketSnapshot,
      priority: "initial" as const,
    };

    const abandoned = coordinator.requestQuote({ ...input, signal: abort.signal });
    await flush();
    expect(jsonResolvers).toHaveLength(1);
    abort.abort();
    await expect(abandoned).rejects.toMatchObject({ code: "NETWORK", scope: "rest" });

    const current = coordinator.requestQuote(input);
    await flush();
    expect(jsonResolvers).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    jsonResolvers[0](successfulResponse());
    await flush();

    const joined = coordinator.requestQuote(input);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    jsonResolvers[1]({
      rt_cd: "0",
      output: { stck_prpr: "2000", prdy_vrss_sign: "3", prdy_ctrt: "0" },
    });
    await expect(Promise.all([current, joined])).resolves.toEqual([
      expect.objectContaining({ price: 2_000 }),
      expect.objectContaining({ price: 2_000 }),
    ]);
  });

  it.each(["fetch", "json"] as const)(
    "reclaims all four logical transport slots when cancelled %s ignores abort",
    async (stage) => {
      let calls = 0;
      const fetch = vi.fn<RestFetch>(async () => {
        calls += 1;
        if (calls <= 4) {
          if (stage === "fetch") return new Promise(() => {});
          return { ok: true, status: 200, json: () => new Promise(() => {}) };
        }
        return successfulResponse("5000");
      });
      const coordinator = new RestCoordinator(credentials(), {
        fetch,
        now: () => marketNow,
      });
      const controllers = Array.from({ length: 4 }, () => new AbortController());
      const abandoned = controllers.map((controller, index) => coordinator.requestQuote({
        adapter: domesticStockAdapter,
        instrument: instrument(index + 1),
        marketSnapshot,
        priority: "fallback",
        signal: controller.signal,
      }));
      await flush();
      expect(fetch).toHaveBeenCalledTimes(4);
      for (const controller of controllers) controller.abort();
      await expect(Promise.allSettled(abandoned)).resolves.toEqual(
        Array(4).fill(expect.objectContaining({ status: "rejected" })),
      );

      const manual = coordinator.requestQuote({
        adapter: domesticStockAdapter,
        instrument: instrument(5),
        marketSnapshot,
        priority: "manual",
      });
      await flush(80);
      expect(fetch).toHaveBeenCalledTimes(5);
      await expect(manual).resolves.toMatchObject({ price: 5_000 });
    },
  );

  it("prioritizes a later manual gate waiter without spending slots on rate waits", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetch = vi.fn<RestFetch>().mockResolvedValue(successfulResponse());
    const coordinator = new RestCoordinator(credentials(), {
      fetch,
      now: () => marketNow,
      rateNow: () => Date.now(),
    });
    await Promise.all(Array.from({ length: 10 }, (_, index) => coordinator.requestQuote({
      adapter: domesticStockAdapter,
      instrument: instrument(index + 1),
      marketSnapshot,
      priority: "initial",
    })));
    expect(fetch).toHaveBeenCalledTimes(10);

    const fallback = [11, 12, 13, 14].map((index) => coordinator.requestQuote({
      adapter: domesticStockAdapter,
      instrument: instrument(index),
      marketSnapshot,
      priority: "fallback" as const,
    }));
    await flush();
    const manual = coordinator.requestQuote({
      adapter: domesticStockAdapter,
      instrument: instrument(15),
      marketSnapshot,
      priority: "manual",
    });
    await flush();
    expect(fetch).toHaveBeenCalledTimes(10);

    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(new URL(fetch.mock.calls[10][0]).searchParams.get("FID_INPUT_ISCD")).toBe("000015");
    await expect(Promise.all([...fallback, manual])).resolves.toHaveLength(5);
  });

  it("uses the monotonic rate clock and does not grant early after wall-clock rollback", async () => {
    vi.useFakeTimers();
    let rateTime = 0;
    const fetch = vi.fn<RestFetch>().mockResolvedValue(successfulResponse());
    const coordinator = new RestCoordinator(credentials(), {
      fetch,
      now: () => marketNow,
      rateNow: () => rateTime,
    });
    await Promise.all(Array.from({ length: 10 }, (_, index) => coordinator.requestQuote({
      adapter: domesticStockAdapter,
      instrument: instrument(index + 1),
      marketSnapshot,
      priority: "initial",
    })));
    const pending = coordinator.requestQuote({
      adapter: domesticStockAdapter,
      instrument: instrument(11),
      marketSnapshot,
      priority: "initial",
    });
    await flush();
    rateTime = -500;
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(10);
    rateTime = 1_000;
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ symbol: "000011" });
    expect(fetch).toHaveBeenCalledTimes(11);
  });

  it("handles synchronous rate-timer callbacks without retaining a stale timer", async () => {
    let rateTime = 0;
    const fetch = vi.fn<RestFetch>().mockResolvedValue(successfulResponse());
    const coordinator = new RestCoordinator(credentials(), {
      fetch,
      now: () => marketNow,
      rateNow: () => rateTime,
      setTimeout: (callback, milliseconds) => {
        rateTime += milliseconds;
        callback();
        return { rateTime };
      },
      clearTimeout: () => {},
    });

    await expect(Promise.all(Array.from({ length: 21 }, (_, index) =>
      coordinator.requestQuote({
        adapter: domesticStockAdapter,
        instrument: instrument(index + 1),
        marketSnapshot,
        priority: "initial",
      }),
    ))).resolves.toHaveLength(21);
    expect(fetch).toHaveBeenCalledTimes(21);
    expect(rateTime).toBe(2_000);
  });

  it("safely rejects and removes gate waiters when rate timer creation throws", async () => {
    let rateTime = 0;
    let timerThrows = true;
    const fetch = vi.fn<RestFetch>().mockResolvedValue(successfulResponse());
    const coordinator = new RestCoordinator(credentials(), {
      fetch,
      now: () => marketNow,
      rateNow: () => rateTime,
      setTimeout: () => {
        if (timerThrows) throw new Error("raw timer failure with app-secret");
        return 1;
      },
      clearTimeout: () => {},
    });
    const results = await Promise.allSettled(Array.from({ length: 11 }, (_, index) =>
      coordinator.requestQuote({
        adapter: domesticStockAdapter,
        instrument: instrument(index + 1),
        marketSnapshot,
        priority: "initial",
      }),
    ));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(10);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "NETWORK", scope: "rest" },
    });
    expect(JSON.stringify(rejected)).not.toContain("app-secret");

    timerThrows = false;
    rateTime = 1_000;
    await expect(coordinator.requestQuote({
      adapter: domesticStockAdapter,
      instrument: instrument(12),
      marketSnapshot,
      priority: "manual",
    })).resolves.toMatchObject({ symbol: "000012" });
    expect(fetch).toHaveBeenCalledTimes(11);
  });

  it("removes a fully cancelled queued flight before it reaches HTTP", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    const fetch = vi.fn<RestFetch>(() => new Promise((resolve) => {
      resolvers.push(resolve);
    }));
    const coordinator = new RestCoordinator(credentials(), { fetch, now: () => marketNow });
    const running = [1, 2, 3, 4].map((index) => coordinator.requestQuote({
      adapter: domesticStockAdapter,
      instrument: instrument(index),
      marketSnapshot,
      priority: "initial" as const,
    }));
    const abort = new AbortController();
    const queued = coordinator.requestQuote({
      adapter: domesticStockAdapter,
      instrument: instrument(5),
      marketSnapshot,
      priority: "initial",
      signal: abort.signal,
    });
    await flush();
    expect(fetch).toHaveBeenCalledTimes(4);
    abort.abort();
    await expect(queued).rejects.toMatchObject({ scope: "rest" });
    resolvers[0](successfulResponse());
    await flush();
    expect(fetch).toHaveBeenCalledTimes(4);

    for (const resolve of resolvers.slice(1)) resolve(successfulResponse());
    await expect(Promise.all(running)).resolves.toHaveLength(4);
  });

  it("cleans a settled dedupe flight so an open-market request can run again", async () => {
    const fetch = vi.fn<RestFetch>().mockResolvedValue(successfulResponse());
    const coordinator = new RestCoordinator(credentials(), { fetch, now: () => marketNow });
    const input = {
      adapter: domesticStockAdapter,
      instrument: instrument(1),
      marketSnapshot,
      priority: "initial" as const,
    };

    const [first, second] = await Promise.all([
      coordinator.requestQuote(input),
      coordinator.requestQuote(input),
    ]);
    expect(first).toEqual(second);
    expect(fetch).toHaveBeenCalledOnce();
    await coordinator.requestQuote(input);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
