import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MarketSnapshot } from "../../core/market-clock.js";
import type {
  CanonicalInstrument,
  MarketAdapter,
  QuoteSample,
} from "../../markets/market-adapter.js";
import type { RenderRequest } from "../../renderer/render-scheduler.js";
import { migrateGlobalSettings } from "../../settings/schema.js";
import {
  StockActionController,
  type StockActionView,
} from "../stock-action-controller.js";

interface TestSettings {
  readonly symbol?: string;
  readonly name?: string;
  readonly instrumentType?: string;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function snapshot(session: MarketSnapshot["session"] = "REG", epoch = 1_000): MarketSnapshot {
  return Object.freeze({
    market: "domestic" as const,
    session,
    sessionEpoch: epoch,
    nextTransitionAt: 1_000_000,
  });
}

function quote(source: QuoteSample["source"], price: number, receivedAt = Date.now()): QuoteSample {
  return Object.freeze({
    symbol: "005930",
    price,
    changeRate: 1.25,
    sign: "rise" as const,
    source,
    receivedAt,
    sessionEpoch: 1_000,
  });
}

class FakeClock {
  private listener?: (value: MarketSnapshot) => void;
  current = snapshot();

  snapshot(): MarketSnapshot {
    return this.current;
  }

  subscribe(listener: (value: MarketSnapshot) => void): () => void {
    this.listener = listener;
    listener(this.current);
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  start(): void {}
  stop(): void {}

  emit(value: MarketSnapshot): void {
    this.current = value;
    this.listener?.(value);
  }
}

class FakeSettingsRepository {
  readonly ready = deferred<ReturnType<FakeSettingsRepository["makeSnapshot"]>>();
  private listener?: (value: ReturnType<FakeSettingsRepository["makeSnapshot"]>) => void | Promise<void>;
  current = this.makeSnapshot();

  private makeSnapshot(overrides: Record<string, unknown> = {}) {
    const settings = migrateGlobalSettings({
      appKey: "app-key",
      appSecret: "app-secret",
      credentialFingerprint: "fingerprint",
      credentialGeneration: 1,
      ...overrides,
    });
    return Object.freeze({
      settings: Object.freeze(settings),
      status: Object.freeze({ baseKnown: true, persistenceDegraded: false }),
    });
  }

  whenReady() {
    return this.ready.promise;
  }

  getSnapshot() {
    return this.current;
  }

  subscribe(listener: (value: ReturnType<FakeSettingsRepository["makeSnapshot"]>) => void | Promise<void>) {
    this.listener = listener;
    listener(this.current);
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  resolve(overrides: Record<string, unknown> = {}): void {
    this.current = this.makeSnapshot(overrides);
    this.ready.resolve(this.current);
  }

  emit(overrides: Record<string, unknown>): void {
    this.current = this.makeSnapshot(overrides);
    void this.listener?.(this.current);
  }
}

type Observer = {
  onData?: (event: { fields: readonly string[]; receivedAt: number }) => void | Promise<void>;
  onState?: (value: { state: "desired" | "pending" | "live" | "stale" | "parked" | "rejected" }) => void | Promise<void>;
};

class FakeSubscriptions {
  subscriptions: Array<{ descriptor: { trId: string; trKey: string }; observer: Observer; released: boolean }> = [];
  retargets: Array<{ oldDescriptor: unknown; nextDescriptor: unknown }> = [];

  subscribe(descriptor: { trId: string; trKey: string }, observer: Observer) {
    const entry = { descriptor, observer, released: false };
    this.subscriptions.push(entry);
    observer.onState?.({ state: "desired" });
    return {
      descriptor,
      snapshot: undefined,
      release: () => {
        entry.released = true;
      },
    };
  }

  async retargetAll(oldDescriptor: unknown, nextDescriptor: unknown): Promise<void> {
    this.retargets.push({ oldDescriptor, nextDescriptor });
  }

  state(state: "desired" | "pending" | "live" | "stale" | "parked" | "rejected"): void {
    void this.active()?.observer.onState?.({ state });
  }

  data(price: number): void {
    void this.active()?.observer.onData?.({ fields: [String(price)], receivedAt: Date.now() });
  }

  private active() {
    return [...this.subscriptions].reverse().find((entry) => !entry.released);
  }
}

class FakeRest {
  requests: Array<{
    priority: string;
    signal?: AbortSignal;
    resolve: (value: QuoteSample) => void;
    reject: (error: unknown) => void;
  }> = [];

  requestQuote(input: { priority: string; signal?: AbortSignal }): Promise<QuoteSample> {
    return new Promise((resolve, reject) => {
      if (input.signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      const onAbort = () => reject(new Error("aborted"));
      input.signal?.addEventListener("abort", onAbort, { once: true });
      this.requests.push({ priority: input.priority, signal: input.signal, resolve, reject });
    });
  }
}

class ImmediateScheduler {
  private nextGeneration = 0;
  private readonly active = new Map<string, number>();
  intervals: number[] = [];

  activate(id: string, interval: 2_000 | 5_000 | 10_000): number {
    const generation = ++this.nextGeneration;
    this.active.set(id, generation);
    this.intervals.push(interval);
    return generation;
  }

  updateInterval(id: string, generation: number, interval: 2_000 | 5_000 | 10_000): boolean {
    if (this.active.get(id) !== generation) return false;
    this.intervals.push(interval);
    return true;
  }

  submit(id: string, generation: number, request: RenderRequest): boolean {
    if (this.active.get(id) !== generation) return false;
    void Promise.resolve(request.render()).then((image) => request.commit(image));
    return true;
  }

  remove(id: string, generation: number): boolean {
    if (this.active.get(id) !== generation) return false;
    this.active.delete(id);
    return true;
  }
}

function makeAdapter(id = "stock"): MarketAdapter<TestSettings> {
  return {
    id,
    market: "domestic",
    toInstrument(settings): CanonicalInstrument {
      if (!settings.symbol) throw new Error("invalid");
      return Object.freeze({
        key: `domestic:${id}:${settings.symbol}`,
        market: "domestic",
        instrumentType: id === "etf" ? "etf" : "stock",
        symbol: settings.symbol,
        displayName: settings.name ?? settings.symbol,
      });
    },
    restDescriptor() {
      return { method: "GET", path: "/test", trId: "REST", query: {} };
    },
    webSocketDescriptor(instrument) {
      return { trId: id === "etf" ? "ETF_WS" : "STOCK_WS", trKey: instrument.symbol };
    },
    parseWebSocket(fields, _instrument, context) {
      return quote("websocket", Number(fields[0]), context.receivedAt);
    },
    parseRest(_payload, _instrument, context) {
      return quote("rest", 1, context.receivedAt);
    },
  };
}

function setup() {
  const settings = new FakeSettingsRepository();
  const clock = new FakeClock();
  const subscriptions = new FakeSubscriptions();
  const rest = new FakeRest();
  const scheduler = new ImmediateScheduler();
  const images: StockActionView[] = [];
  const adapters: string[] = [];
  const controller = new StockActionController<TestSettings>({
    settingsRepository: settings,
    clocks: { domestic: clock, overseas: clock },
    subscriptions,
    restCoordinator: rest,
    renderScheduler: scheduler,
    adapterResolver: (actionSettings) => {
      const id = actionSettings.instrumentType === "etf" ? "etf" : "stock";
      adapters.push(id);
      return makeAdapter(id);
    },
    renderer: (view) => {
      images.push(view);
      return JSON.stringify(view);
    },
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
  return { settings, clock, subscriptions, rest, scheduler, images, adapters, controller };
}

describe("StockActionController automatic policy and lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("readiness 중 disappear가 발생하면 늦은 appear가 구독하거나 렌더하지 않는다", async () => {
    const test = setup();
    const setImage = vi.fn();
    const appearing = test.controller.appear({
      actionId: "a",
      settings: { symbol: "005930" },
      actionPort: { setImage },
    });
    const disappearing = test.controller.disappear("a");

    test.settings.resolve();
    await Promise.all([appearing, disappearing]);

    expect(test.subscriptions.subscriptions).toHaveLength(0);
    expect(test.rest.requests).toHaveLength(0);
    expect(setImage).not.toHaveBeenCalled();
  });

  it("ETF 설정은 ETF 어댑터로 구독한다", async () => {
    const test = setup();
    test.settings.resolve();

    await test.controller.appear({
      actionId: "etf",
      settings: { symbol: "069500", instrumentType: "etf" },
      actionPort: { setImage: vi.fn() },
    });

    expect(test.adapters).toContain("etf");
    expect(test.subscriptions.subscriptions[0]?.descriptor).toEqual({
      trId: "ETF_WS",
      trKey: "069500",
    });
  });

  it("자동 장중은 WS만 시작하고 5초 무데이터 뒤 fallback REST를 시작한다", async () => {
    const test = setup();
    test.settings.resolve();
    await test.controller.appear({
      actionId: "a",
      settings: { symbol: "005930" },
      actionPort: { setImage: vi.fn() },
    });

    expect(test.subscriptions.subscriptions).toHaveLength(1);
    expect(test.rest.requests).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(test.rest.requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(test.rest.requests.map((request) => request.priority)).toEqual(["fallback"]);
  });

  it("5초 전에 유효한 WS 데이터가 오면 fallback을 시작하지 않는다", async () => {
    const test = setup();
    test.settings.resolve();
    await test.controller.appear({
      actionId: "a",
      settings: { symbol: "005930" },
      actionPort: { setImage: vi.fn() },
    });

    test.subscriptions.state("live");
    test.subscriptions.data(70_000);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(test.rest.requests).toHaveLength(0);
    expect(test.images.at(-1)?.connection).toBe("LIVE");
    expect(test.images.at(-1)?.quote?.price).toBe(70_000);
  });

  it("live ack만으로는 5초 fallback grace를 취소하지 않는다", async () => {
    const test = setup();
    test.settings.resolve();
    await test.controller.appear({
      actionId: "a",
      settings: { symbol: "005930" },
      actionPort: { setImage: vi.fn() },
    });

    test.subscriptions.state("live");
    await vi.advanceTimersByTimeAsync(5_000);

    expect(test.rest.requests).toHaveLength(1);
  });

  it("WS가 fallback보다 늦게 시작돼도 이후 늦은 REST 결과를 폐기한다", async () => {
    const test = setup();
    test.settings.resolve();
    await test.controller.appear({
      actionId: "a",
      settings: { symbol: "005930" },
      actionPort: { setImage: vi.fn() },
    });
    await vi.advanceTimersByTimeAsync(5_000);

    test.subscriptions.data(71_000);
    test.rest.requests[0]!.resolve(quote("rest", 69_000));
    await Promise.resolve();
    await Promise.resolve();

    expect(test.images.at(-1)?.connection).toBe("LIVE");
    expect(test.images.at(-1)?.quote?.price).toBe(71_000);
  });

  it("설정 변경은 이전 세대의 늦은 WS와 REST 결과를 차단한다", async () => {
    const test = setup();
    test.settings.resolve();
    const setImage = vi.fn();
    await test.controller.appear({
      actionId: "a",
      settings: { symbol: "005930", name: "old" },
      actionPort: { setImage },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    const oldSubscription = test.subscriptions.subscriptions[0]!;

    await test.controller.updateSettings("a", { symbol: "000660", name: "new" });
    await oldSubscription.observer.onData?.({ fields: ["1"], receivedAt: Date.now() });
    test.rest.requests[0]!.resolve(quote("rest", 2));
    await Promise.resolve();
    await Promise.resolve();

    expect(oldSubscription.released).toBe(true);
    expect(test.images.some((view) => view.instrument.symbol === "000660")).toBe(true);
    expect(test.images.at(-1)?.instrument.symbol).toBe("000660");
  });

  it("자격증명이 없으면 fatal 화면만 즉시 표시하고 네트워크를 시작하지 않는다", async () => {
    const test = setup();
    test.settings.resolve({ appKey: undefined, appSecret: undefined });
    const setImage = vi.fn();

    await test.controller.appear({
      actionId: "a",
      settings: { symbol: "005930" },
      actionPort: { setImage },
    });
    await Promise.resolve();

    expect(test.subscriptions.subscriptions).toHaveLength(0);
    expect(test.rest.requests).toHaveLength(0);
    expect(test.images.at(-1)?.error?.code).toBe("NO_CREDENTIALS");
  });

  it.each(["desired", "stale", "parked", "rejected"] as const)(
    "유효 WS 이후 %s 상태는 즉시 fallback REST를 시작한다",
    async (state) => {
      const test = setup();
      test.settings.resolve();
      await test.controller.appear({
        actionId: "a",
        settings: { symbol: "005930" },
        actionPort: { setImage: vi.fn() },
      });
      test.subscriptions.data(70_000);

      test.subscriptions.state(state);
      await Promise.resolve();

      expect(test.rest.requests.map((request) => request.priority)).toEqual(["fallback"]);
    },
  );

  it("초기 rejected도 grace를 기다리지 않고 fallback을 시작한다", async () => {
    const test = setup();
    test.settings.resolve();
    await test.controller.appear({
      actionId: "a",
      settings: { symbol: "005930" },
      actionPort: { setImage: vi.fn() },
    });

    test.subscriptions.state("rejected");
    await Promise.resolve();

    expect(test.rest.requests.map((request) => request.priority)).toEqual(["fallback"]);
  });

  it("REST 전용 장중은 즉시 initial 요청 후 설정 간격으로 fallback을 반복한다", async () => {
    const test = setup();
    test.settings.resolve({
      preferences: {
        dataMode: "rest-only",
        renderIntervalMs: 2_000,
        backupPollIntervalMs: 15_000,
      },
    });
    await test.controller.appear({
      actionId: "a",
      settings: { symbol: "005930" },
      actionPort: { setImage: vi.fn() },
    });

    expect(test.subscriptions.subscriptions).toHaveLength(0);
    expect(test.rest.requests.map((request) => request.priority)).toEqual(["initial"]);
    test.rest.requests[0]!.resolve(quote("rest", 70_000));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(test.rest.requests.map((request) => request.priority)).toEqual(["initial", "fallback"]);
  });

  it("장 마감은 모드와 관계없이 세션별 initial REST 한 번만 수행한다", async () => {
    const test = setup();
    test.clock.current = snapshot("CLOSED", 4_000);
    test.settings.resolve();
    await test.controller.appear({
      actionId: "a",
      settings: { symbol: "005930" },
      actionPort: { setImage: vi.fn() },
    });

    expect(test.subscriptions.subscriptions).toHaveLength(0);
    expect(test.rest.requests.map((request) => request.priority)).toEqual(["initial"]);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(test.rest.requests).toHaveLength(1);
  });

  it("수동 갱신은 중복 요청을 singleflight하고 자동 정책의 5초 grace를 유지한다", async () => {
    const test = setup();
    test.settings.resolve();
    await test.controller.appear({
      actionId: "a",
      settings: { symbol: "005930" },
      actionPort: { setImage: vi.fn() },
    });

    const first = test.controller.manualRefresh("a");
    const second = test.controller.manualRefresh("a");
    await vi.advanceTimersByTimeAsync(0);
    expect(test.rest.requests.map((request) => request.priority)).toEqual(["manual"]);
    expect(test.images.at(-1)?.refreshing).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(test.rest.requests.map((request) => request.priority)).toEqual(["manual", "fallback"]);
    test.rest.requests[0]!.resolve(quote("rest", 72_000));
    await Promise.all([first, second]);
  });

  it("fallback 실패 시 데이터가 없으면 BROKEN 오류 화면을 표시한다", async () => {
    const test = setup();
    test.settings.resolve();
    await test.controller.appear({
      actionId: "a",
      settings: { symbol: "005930" },
      actionPort: { setImage: vi.fn() },
    });
    await vi.advanceTimersByTimeAsync(5_000);

    test.rest.requests[0]!.reject(new Error("network"));
    await Promise.resolve();
    await Promise.resolve();

    expect(test.images.at(-1)?.connection).toBe("BROKEN");
    expect(test.images.at(-1)?.error?.code).toBe("NETWORK");
  });
});
