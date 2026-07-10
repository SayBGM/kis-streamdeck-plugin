import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MarketSnapshot } from "../../core/market-clock.js";
import { KisError } from "../../core/errors.js";
import type {
  CanonicalInstrument,
  MarketAdapter,
  QuoteSample,
} from "../../markets/market-adapter.js";
import { RenderScheduler, type RenderRequest } from "../../renderer/render-scheduler.js";
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

function snapshot(
  session: MarketSnapshot["session"] = "REG",
  epoch = 1_000,
  market: MarketSnapshot["market"] = "domestic",
): MarketSnapshot {
  return Object.freeze({
    market,
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
  private readonly listeners = new Set<(value: MarketSnapshot) => void>();
  current = snapshot();

  snapshot(): MarketSnapshot {
    return this.current;
  }

  subscribe(listener: (value: MarketSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => this.listeners.delete(listener);
  }

  start(): void {}
  stop(): void {}

  emit(value: MarketSnapshot): void {
    this.current = value;
    for (const listener of [...this.listeners]) listener(value);
  }
}

class FakeSettingsRepository {
  readonly ready = deferred<ReturnType<FakeSettingsRepository["makeSnapshot"]>>();
  private listener?: (value: ReturnType<FakeSettingsRepository["makeSnapshot"]>) => void | Promise<void>;
  current = this.makeSnapshot();

  private makeSnapshot(overrides: Record<string, unknown> = {}, baseKnown = true) {
    const settings = migrateGlobalSettings({
      appKey: "app-key",
      appSecret: "app-secret",
      credentialFingerprint: "fingerprint",
      credentialGeneration: 1,
      ...overrides,
    });
    return Object.freeze({
      settings: Object.freeze(settings),
      status: Object.freeze({ baseKnown, persistenceDegraded: !baseKnown }),
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

  resolve(overrides: Record<string, unknown> = {}, baseKnown = true): void {
    this.current = this.makeSnapshot(overrides, baseKnown);
    this.ready.resolve(this.current);
  }

  emit(overrides: Record<string, unknown>, baseKnown = true): void {
    this.current = this.makeSnapshot(overrides, baseKnown);
    void this.listener?.(this.current);
  }
}

type Observer = {
  onData?: (event: { fields: readonly string[]; receivedAt: number }) => void | Promise<void>;
  onState?: (value: { state: "desired" | "pending" | "live" | "stale" | "parked" | "rejected" }) => void | Promise<void>;
};

class FakeSubscriptions {
  subscriptions: Array<{
    descriptor: { trId: string; trKey: string };
    observer: Observer;
    released: boolean;
    state: "desired" | "pending" | "live" | "stale" | "parked" | "rejected";
  }> = [];
  retargets: Array<{ oldDescriptor: unknown; nextDescriptor: unknown }> = [];

  subscribe(descriptor: { trId: string; trKey: string }, observer: Observer) {
    const entry: FakeSubscriptions["subscriptions"][number] = {
      descriptor,
      observer,
      released: false,
      state: "desired",
    };
    this.subscriptions.push(entry);
    observer.onState?.({ state: "desired" });
    return {
      get descriptor() {
        return descriptor;
      },
      get snapshot() {
        return {
          descriptor,
          state: entry.state,
          generation: 1,
          refCount: 1,
          subscribed: entry.state === "live" || entry.state === "stale",
        };
      },
      release: () => {
        entry.released = true;
      },
    };
  }

  async retargetAll(oldDescriptor: unknown, nextDescriptor: unknown): Promise<void> {
    this.retargets.push({ oldDescriptor, nextDescriptor });
  }

  state(state: "desired" | "pending" | "live" | "stale" | "parked" | "rejected"): void {
    const active = this.active();
    if (!active) return;
    active.state = state;
    void active.observer.onState?.({ state });
  }

  data(price: number): void {
    void this.active()?.observer.onData?.({ fields: [String(price)], receivedAt: Date.now() });
  }

  private active() {
    return [...this.subscriptions].reverse().find((entry) => !entry.released);
  }
}

class SharedPhysicalSubscriptions extends FakeSubscriptions {
  private physical?: {
    descriptor: { trId: string; trKey: string };
    state: "desired" | "pending" | "live" | "stale" | "parked" | "rejected";
    refs: Set<Observer>;
  };

  get refCount(): number {
    return this.physical?.refs.size ?? 0;
  }

  override subscribe(descriptor: { trId: string; trKey: string }, observer: Observer) {
    if (!this.physical) {
      this.physical = { descriptor, state: "desired", refs: new Set() };
    }
    const physical = this.physical;
    physical.refs.add(observer);
    observer.onState?.({ state: physical.state });
    let released = false;
    return {
      get descriptor() {
        return physical.descriptor;
      },
      get snapshot() {
        return {
          descriptor: physical.descriptor,
          state: physical.state,
          generation: 1,
          refCount: physical.refs.size,
          subscribed: physical.state === "live" || physical.state === "stale",
        };
      },
      release: () => {
        if (released) return;
        released = true;
        physical.refs.delete(observer);
      },
    };
  }

  override async retargetAll(oldDescriptor: unknown, nextDescriptor: unknown): Promise<void> {
    const next = nextDescriptor as { trId: string; trKey: string };
    if (
      this.physical?.descriptor.trId === next.trId &&
      this.physical.descriptor.trKey === next.trKey
    ) return;
    this.retargets.push({ oldDescriptor, nextDescriptor });
    if (this.physical) this.physical.descriptor = next;
  }

  emitState(state: "desired" | "pending" | "live" | "stale" | "parked" | "rejected"): void {
    if (!this.physical) return;
    this.physical.state = state;
    for (const observer of [...this.physical.refs]) void observer.onState?.({ state });
  }
}

class FakeRest {
  requests: Array<{
    priority: string;
    signal?: AbortSignal;
    marketSnapshot?: MarketSnapshot;
    resolve: (value: QuoteSample) => void;
    reject: (error: unknown) => void;
  }> = [];

  requestQuote(input: {
    priority: string;
    signal?: AbortSignal;
    marketSnapshot?: MarketSnapshot;
  }): Promise<QuoteSample> {
    return new Promise((resolve, reject) => {
      if (input.signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      const onAbort = () => reject(new Error("aborted"));
      input.signal?.addEventListener("abort", onAbort, { once: true });
      this.requests.push({
        priority: input.priority,
        signal: input.signal,
        marketSnapshot: input.marketSnapshot,
        resolve,
        reject,
      });
    });
  }
}

class ImmediateScheduler {
  private nextGeneration = 0;
  private readonly active = new Map<string, number>();
  intervals: number[] = [];
  requests: Array<Pick<RenderRequest, "category" | "semanticKey">> = [];
  removals: Array<{ id: string; generation: number }> = [];

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
    this.requests.push({ category: request.category, semanticKey: request.semanticKey });
    void Promise.resolve(request.render()).then((image) => request.commit(image));
    return true;
  }

  remove(id: string, generation: number): boolean {
    this.removals.push({ id, generation });
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

function setup(options: {
  adapterResolver?: (settings: TestSettings) => MarketAdapter<TestSettings>;
  subscriptions?: FakeSubscriptions;
  renderScheduler?: RenderScheduler;
  setTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  useDefaultRuntime?: boolean;
} = {}) {
  const settings = new FakeSettingsRepository();
  const clock = new FakeClock();
  const subscriptions = options.subscriptions ?? new FakeSubscriptions();
  const rest = new FakeRest();
  const scheduler = new ImmediateScheduler();
  const images: StockActionView[] = [];
  const adapters: string[] = [];
  const runtime = options.useDefaultRuntime
    ? {}
    : {
        now: () => Date.now(),
        setTimeout: options.setTimeout ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs)),
        clearTimeout: options.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
      };
  const controller = new StockActionController<TestSettings>({
    settingsRepository: settings,
    clocks: { domestic: clock, overseas: clock },
    subscriptions,
    restCoordinator: rest,
    renderScheduler: options.renderScheduler ?? scheduler,
    adapterResolver: options.adapterResolver ?? ((actionSettings) => {
      const id = actionSettings.instrumentType === "etf" ? "etf" : "stock";
      adapters.push(id);
      return makeAdapter(id);
    }),
    renderer: (view) => {
      images.push(view);
      return JSON.stringify(view);
    },
    ...runtime,
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

  it("설정 원본을 읽지 못한 readiness 상태는 SETTINGS fatal로 표시한다", async () => {
    const test = setup();
    test.settings.resolve({}, false);

    await test.controller.appear({
      actionId: "a",
      settings: { symbol: "005930" },
      actionPort: { setImage: vi.fn() },
    });

    expect(test.images.at(-1)?.error?.code).toBe("SETTINGS");
    expect(test.subscriptions.subscriptions).toHaveLength(0);
  });

  it("초기 whenReady 결과보다 최신 repository snapshot으로 새 action을 구성한다", async () => {
    const test = setup();
    test.settings.resolve();
    await test.controller.appear({
      actionId: "first",
      settings: { symbol: "005930" },
      actionPort: { setImage: vi.fn() },
    });
    test.settings.emit({
      preferences: {
        dataMode: "rest-only",
        renderIntervalMs: 5_000,
        backupPollIntervalMs: 15_000,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    const subscriptionCount = test.subscriptions.subscriptions.length;
    const requestCount = test.rest.requests.length;

    await test.controller.appear({
      actionId: "second",
      settings: { symbol: "000660" },
      actionPort: { setImage: vi.fn() },
    });

    expect(test.subscriptions.subscriptions).toHaveLength(subscriptionCount);
    expect(test.rest.requests).toHaveLength(requestCount + 1);
    expect(test.scheduler.intervals.at(-1)).toBe(5_000);
  });

  it.each([
    ["token", {
      accessToken: "new-token",
      accessTokenFingerprint: "fingerprint",
      accessTokenVersion: 7,
    }, 2_000],
    ["revision", { settingsRevision: 99, arbitraryFutureField: "kept" }, 2_000],
    ["render", {
      preferences: {
        dataMode: "automatic",
        renderIntervalMs: 5_000,
        backupPollIntervalMs: 30_000,
      },
    }, 5_000],
  ] as const)(
    "%s-only global 변경은 realtime policy/subscription/grace를 재시작하지 않는다",
    async (_kind, overrides, expectedInterval) => {
      const test = setup();
      test.settings.resolve();
      await test.controller.appear({
        actionId: "a",
        settings: { symbol: "005930" },
        actionPort: { setImage: vi.fn() },
      });
      test.subscriptions.data(70_000);
      const physical = test.subscriptions.subscriptions[0]!;

      test.settings.emit(overrides as Record<string, unknown>);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(test.subscriptions.subscriptions).toHaveLength(1);
      expect(physical.released).toBe(false);
      expect(test.rest.requests).toHaveLength(0);
      expect(test.scheduler.intervals.at(-1)).toBe(expectedInterval);
    },
  );

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

  it.each(["parked", "rejected"] as const)(
    "%s fallback은 즉시 요청 뒤 설정 간격으로 반복한다",
    async (state) => {
      const test = setup();
      test.settings.resolve({
        preferences: {
          dataMode: "automatic",
          renderIntervalMs: 2_000,
          backupPollIntervalMs: 15_000,
        },
      });
      await test.controller.appear({
        actionId: "a",
        settings: { symbol: "005930" },
        actionPort: { setImage: vi.fn() },
      });

      test.subscriptions.state(state);
      expect(test.rest.requests.map((request) => request.priority)).toEqual(["fallback"]);
      test.rest.requests[0]!.resolve(quote("rest", 69_000));
      await vi.advanceTimersByTimeAsync(15_000);

      expect(test.rest.requests.map((request) => request.priority)).toEqual([
        "fallback",
        "fallback",
      ]);
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

  it("subscription port의 동기 예외를 격리하고 fallback으로 전환한다", async () => {
    class ThrowingSubscribe extends FakeSubscriptions {
      subscribe(): ReturnType<FakeSubscriptions["subscribe"]> {
        throw new Error("subscription unavailable");
      }
    }
    const test = setup({ subscriptions: new ThrowingSubscribe() });
    test.settings.resolve();

    await expect(test.controller.appear({
      actionId: "a",
      settings: { symbol: "005930" },
      actionPort: { setImage: vi.fn() },
    })).resolves.toBeUndefined();

    expect(test.rest.requests.map((request) => request.priority)).toEqual(["fallback"]);
    expect(test.images.at(-1)?.connection).toBe("BROKEN");
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
    test.clock.emit(snapshot("CLOSED", 4_000));
    await vi.advanceTimersByTimeAsync(0);
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

  it("수동 요청은 disappear에서 취소되고 늦은 결과가 렌더되지 않는다", async () => {
    const test = setup();
    test.settings.resolve();
    await test.controller.appear({
      actionId: "a",
      settings: { symbol: "005930" },
      actionPort: { setImage: vi.fn() },
    });
    const manual = test.controller.manualRefresh("a");
    await vi.advanceTimersByTimeAsync(0);
    const request = test.rest.requests[0]!;

    await test.controller.disappear("a");

    expect(request.signal?.aborted).toBe(true);
    await manual;
  });

  it("수동 REST 중 더 최신 WS가 오면 수동 결과를 폐기하고 LIVE quote를 유지한다", async () => {
    const test = setup();
    test.settings.resolve();
    await test.controller.appear({
      actionId: "a",
      settings: { symbol: "005930" },
      actionPort: { setImage: vi.fn() },
    });
    test.subscriptions.data(70_000);
    const manual = test.controller.manualRefresh("a");
    await vi.advanceTimersByTimeAsync(0);
    const manualRequest = test.rest.requests.find((request) => request.priority === "manual")!;

    test.subscriptions.data(71_000);
    manualRequest.resolve(quote("rest", 69_000));
    await manual;
    await vi.advanceTimersByTimeAsync(0);

    expect(test.images.at(-1)?.connection).toBe("LIVE");
    expect(test.images.at(-1)?.quote?.price).toBe(71_000);
    expect(test.images.at(-1)?.refreshing).toBe(false);
  });

  it.each([
    ["desired", false],
    ["stale", true],
    ["parked", false],
    ["rejected", false],
  ] as const)(
    "유효 WS 이후 %s 상태는 가격을 보존한 BROKEN 화면으로 즉시 전환한다",
    async (state, stale) => {
      const test = setup();
      test.settings.resolve();
      await test.controller.appear({
        actionId: "a",
        settings: { symbol: "005930" },
        actionPort: { setImage: vi.fn() },
      });
      test.subscriptions.data(70_000);

      test.subscriptions.state(state);
      await vi.advanceTimersByTimeAsync(0);

      expect(test.images.at(-1)?.connection).toBe("BROKEN");
      expect(test.images.at(-1)?.quote?.price).toBe(70_000);
      expect(test.images.at(-1)?.stale).toBe(stale);
      test.rest.requests.at(-1)!.reject(new Error("fallback failed"));
      await vi.advanceTimersByTimeAsync(0);
      expect(test.images.at(-1)?.connection).toBe("BROKEN");
      expect(test.images.at(-1)?.quote?.price).toBe(70_000);
    },
  );

  it.each(["desired", "pending"] as const)(
    "초기 %s 상태는 BROKEN이 아니라 waiting grace를 유지한다",
    async (state) => {
      const test = setup();
      test.settings.resolve();
      await test.controller.appear({
        actionId: "a",
        settings: { symbol: "005930" },
        actionPort: { setImage: vi.fn() },
      });
      test.subscriptions.state(state);
      await vi.advanceTimersByTimeAsync(0);

      expect(test.images.at(-1)?.connection).toBe("waiting");
      expect(test.rest.requests).toHaveLength(0);
    },
  );

  it("invalid instrument fatal scheduler target도 disappear에서 제거한다", async () => {
    const test = setup({
      adapterResolver: () => ({
        ...makeAdapter(),
        toInstrument() {
          throw new KisError({
            code: "INVALID_INSTRUMENT",
            scope: "action",
            retryable: false,
            safeMessage: "안전한 종목 오류",
          });
        },
      }),
    });
    test.settings.resolve();
    await test.controller.appear({
      actionId: "invalid",
      settings: { symbol: "bad" },
      actionPort: { setImage: vi.fn() },
    });
    expect(test.images.at(-1)?.error).toEqual({
      code: "INVALID_INSTRUMENT",
      message: "안전한 종목 오류",
    });

    await test.controller.disappear("invalid");

    expect(test.scheduler.removals).toHaveLength(1);
  });

  it("기본 runtime과 중복 lifecycle 호출도 멱등하게 정리한다", async () => {
    const test = setup({ useDefaultRuntime: true });
    test.settings.resolve();
    await test.controller.updateSettings("missing", { symbol: "000000" });
    await test.controller.appear({
      actionId: "a",
      settings: { symbol: "005930" },
      actionPort: { setImage: vi.fn() },
    });
    await test.controller.appear({
      actionId: "a",
      settings: { symbol: "000660" },
      actionPort: { setImage: vi.fn() },
    });
    await test.controller.destroy();

    const subscriptions = test.subscriptions.subscriptions.length;
    await test.controller.appear({
      actionId: "late",
      settings: { symbol: "005930" },
      actionPort: { setImage: vi.fn() },
    });
    await test.controller.updateSettings("a", { symbol: "035420" });
    await test.controller.destroy();

    expect(test.subscriptions.subscriptions).toHaveLength(subscriptions);
  });
});

describe("StockActionController settings, market and rendering boundaries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("전역 preference 변경은 렌더 간격과 데이터 정책을 재구성한다", async () => {
    const test = setup();
    test.settings.resolve();
    await test.controller.appear({
      actionId: "a",
      settings: { symbol: "005930" },
      actionPort: { setImage: vi.fn() },
    });
    const oldSubscription = test.subscriptions.subscriptions[0]!;

    test.settings.emit({
      preferences: {
        dataMode: "rest-only",
        renderIntervalMs: 5_000,
        backupPollIntervalMs: 15_000,
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(oldSubscription.released).toBe(true);
    expect(test.scheduler.intervals).toEqual([2_000, 5_000]);
    expect(test.rest.requests.map((request) => request.priority)).toEqual(["initial"]);
  });

  it("자격증명 제거는 정책 요청을 취소하고 fatal 이후 네트워크를 재시작하지 않는다", async () => {
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
    const initial = test.rest.requests[0]!;

    test.settings.emit({ appKey: undefined, appSecret: undefined });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(initial.signal?.aborted).toBe(true);
    expect(test.rest.requests).toHaveLength(1);
    expect(test.images.at(-1)?.error?.code).toBe("NO_CREDENTIALS");
  });

  it("자격증명 제거 뒤 clock 이벤트는 네트워크를 재시작하지 않고 복구 시 listener를 다시 연결한다", async () => {
    const test = setup();
    test.settings.resolve();
    await test.controller.appear({
      actionId: "a",
      settings: { symbol: "005930" },
      actionPort: { setImage: vi.fn() },
    });
    const oldSubscription = test.subscriptions.subscriptions[0]!;

    test.settings.emit({ appKey: undefined, appSecret: undefined });
    test.clock.emit(snapshot("CLOSED", 8_000));
    await vi.advanceTimersByTimeAsync(0);
    expect(oldSubscription.released).toBe(true);
    expect(test.rest.requests).toHaveLength(0);

    test.clock.current = snapshot("REG", 9_000);
    test.settings.emit({});
    await vi.advanceTimersByTimeAsync(0);
    expect(test.subscriptions.subscriptions).toHaveLength(2);

    test.clock.emit(snapshot("CLOSED", 10_000));
    await vi.advanceTimersByTimeAsync(0);
    expect(test.rest.requests.map((request) => request.priority)).toEqual(["initial"]);
  });

  it("시장 CLOSED 전환은 WS를 해제하고 해당 세션 initial REST 한 번으로 바꾼다", async () => {
    const test = setup();
    test.settings.resolve();
    await test.controller.appear({
      actionId: "a",
      settings: { symbol: "005930" },
      actionPort: { setImage: vi.fn() },
    });
    const subscription = test.subscriptions.subscriptions[0]!;

    test.clock.emit(snapshot("CLOSED", 9_000));
    await vi.advanceTimersByTimeAsync(0);

    expect(subscription.released).toBe(true);
    expect(test.rest.requests.map((request) => request.priority)).toEqual(["initial"]);
  });

  it("PRE→REG처럼 descriptor가 같은 realtime 전환은 기존 subscription ref를 재사용한다", async () => {
    const test = setup();
    test.clock.current = snapshot("PRE", 1_000);
    test.settings.resolve();
    await test.controller.appear({
      actionId: "a",
      settings: { symbol: "005930" },
      actionPort: { setImage: vi.fn() },
    });
    const original = test.subscriptions.subscriptions[0]!;

    test.clock.emit(snapshot("REG", 2_000));
    await vi.advanceTimersByTimeAsync(0);

    expect(test.subscriptions.subscriptions).toHaveLength(1);
    expect(original.released).toBe(false);
  });

  it.each(["stale", "parked", "rejected"] as const)(
    "동일 descriptor 재사용 시 기존 %s snapshot을 새 세대에 적용해 즉시 fallback한다",
    async (state) => {
      const test = setup();
      test.clock.current = snapshot("PRE", 1_000);
      test.settings.resolve();
      await test.controller.appear({
        actionId: "a",
        settings: { symbol: "005930" },
        actionPort: { setImage: vi.fn() },
      });
      test.subscriptions.state(state);
      test.rest.requests[0]!.resolve(quote("rest", 69_000));
      await vi.advanceTimersByTimeAsync(0);
      const before = test.rest.requests.length;

      test.clock.emit(snapshot("REG", 2_000));
      await vi.advanceTimersByTimeAsync(0);

      expect(test.subscriptions.subscriptions).toHaveLength(1);
      expect(test.rest.requests).toHaveLength(before + 1);
      expect(test.rest.requests.at(-1)?.priority).toBe("fallback");
    },
  );

  it.each(["desired", "pending"] as const)(
    "동일 descriptor 재사용 시 기존 %s snapshot은 새 5초 grace를 지킨다",
    async (state) => {
      const test = setup();
      test.clock.current = snapshot("PRE", 1_000);
      test.settings.resolve();
      await test.controller.appear({
        actionId: "a",
        settings: { symbol: "005930" },
        actionPort: { setImage: vi.fn() },
      });
      test.subscriptions.state(state);

      test.clock.emit(snapshot("REG", 2_000));
      await vi.advanceTimersByTimeAsync(4_999);
      expect(test.rest.requests).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);

      expect(test.rest.requests.map((request) => request.priority)).toEqual(["fallback"]);
    },
  );

  it("REG→AFT에서 descriptor가 바뀌면 새 ref 없이 retargetAll을 사용한다", async () => {
    let key = "DAY";
    const adapter: MarketAdapter<TestSettings> = {
      ...makeAdapter(),
      webSocketDescriptor(instrument) {
        return { trId: "WS", trKey: `${key}:${instrument.symbol}` };
      },
    };
    const test = setup({ adapterResolver: () => adapter });
    test.clock.current = snapshot("REG", 1_000);
    test.settings.resolve();
    await test.controller.appear({
      actionId: "a",
      settings: { symbol: "005930" },
      actionPort: { setImage: vi.fn() },
    });
    const original = test.subscriptions.subscriptions[0]!;

    key = "NIGHT";
    test.clock.emit(snapshot("AFT", 2_000));
    await vi.advanceTimersByTimeAsync(0);

    expect(test.subscriptions.subscriptions).toHaveLength(1);
    expect(original.released).toBe(false);
    expect(test.subscriptions.retargets).toEqual([{
      oldDescriptor: { trId: "WS", trKey: "DAY:005930" },
      nextDescriptor: { trId: "WS", trKey: "NIGHT:005930" },
    }]);
  });

  it("공유 physical subscription에서 한 action의 disappear/cancel/retarget이 다른 action ref를 해치지 않는다", async () => {
    let key = "DAY";
    const adapter: MarketAdapter<TestSettings> = {
      ...makeAdapter(),
      webSocketDescriptor(instrument) {
        return { trId: "WS", trKey: `${key}:${instrument.symbol}` };
      },
    };
    const subscriptions = new SharedPhysicalSubscriptions();
    const test = setup({ adapterResolver: () => adapter, subscriptions });
    test.settings.resolve();
    await test.controller.appear({
      actionId: "a",
      settings: { symbol: "005930" },
      actionPort: { setImage: vi.fn() },
    });
    await test.controller.appear({
      actionId: "b",
      settings: { symbol: "005930" },
      actionPort: { setImage: vi.fn() },
    });
    expect(subscriptions.refCount).toBe(2);

    subscriptions.emitState("stale");
    await vi.advanceTimersByTimeAsync(0);
    expect(test.rest.requests).toHaveLength(2);
    await test.controller.disappear("a");
    expect(subscriptions.refCount).toBe(1);
    expect(test.rest.requests[0]?.signal?.aborted).toBe(true);
    expect(test.rest.requests[1]?.signal?.aborted).toBe(false);

    key = "NIGHT";
    test.clock.emit(snapshot("AFT", 2_000));
    await vi.advanceTimersByTimeAsync(0);

    expect(subscriptions.refCount).toBe(1);
    expect(subscriptions.retargets).toEqual([{
      oldDescriptor: { trId: "WS", trKey: "DAY:005930" },
      nextDescriptor: { trId: "WS", trKey: "NIGHT:005930" },
    }]);
  });

  it("CLOSED→OPEN 새 정책은 이전 WS valid 상태를 버리고 5초 no-data grace를 다시 적용한다", async () => {
    const test = setup();
    test.settings.resolve();
    await test.controller.appear({
      actionId: "a",
      settings: { symbol: "005930" },
      actionPort: { setImage: vi.fn() },
    });
    test.subscriptions.data(70_000);

    test.clock.emit(snapshot("CLOSED", 2_000));
    await vi.advanceTimersByTimeAsync(0);
    test.clock.emit(snapshot("REG", 3_000));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(test.rest.requests.filter((request) => request.priority === "fallback")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(test.rest.requests.filter((request) => request.priority === "fallback")).toHaveLength(1);
  });

  it("미국 ET CLOSED여도 KST 주간 거래 창은 realtime 세션으로 파생한다", async () => {
    vi.setSystemTime(Date.UTC(2026, 0, 5, 3, 0)); // 월요일 12:00 KST
    const overseas = makeAdapter("stock") as MarketAdapter<TestSettings>;
    Object.defineProperty(overseas, "market", { value: "overseas" });
    const test = setup({ adapterResolver: () => overseas });
    test.clock.current = snapshot("CLOSED", 5_000, "overseas");
    test.settings.resolve();

    await test.controller.appear({
      actionId: "us",
      settings: { symbol: "005930" },
      actionPort: { setImage: vi.fn() },
    });

    expect(test.subscriptions.subscriptions).toHaveLength(1);
    expect(test.rest.requests).toHaveLength(0);
    expect(test.images.at(-1)?.session).toBe("REG");
  });

  it("동일 closed identity의 preference 변경은 in-flight 요청을 취소하거나 재요청하지 않는다", async () => {
    const test = setup();
    test.clock.current = snapshot("CLOSED", 5_000);
    test.settings.resolve();
    await test.controller.appear({
      actionId: "a",
      settings: { symbol: "005930" },
      actionPort: { setImage: vi.fn() },
    });
    const request = test.rest.requests[0]!;

    test.settings.emit({
      preferences: {
        dataMode: "rest-only",
        renderIntervalMs: 10_000,
        backupPollIntervalMs: 60_000,
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(request.signal?.aborted).toBe(false);
    expect(test.rest.requests).toHaveLength(1);
  });

  it("closed 세션의 credential generation이 바뀌면 이전 요청을 취소하고 새 identity로 요청한다", async () => {
    const test = setup();
    test.clock.current = snapshot("CLOSED", 5_000);
    test.settings.resolve();
    await test.controller.appear({
      actionId: "a",
      settings: { symbol: "005930" },
      actionPort: { setImage: vi.fn() },
    });
    const oldRequest = test.rest.requests[0]!;

    test.settings.emit({
      credentialGeneration: 2,
      credentialFingerprint: "next-fingerprint",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(oldRequest.signal?.aborted).toBe(true);
    expect(test.rest.requests.map((request) => request.priority)).toEqual([
      "initial",
      "initial",
    ]);
  });

  it("closed 요청 중 baseKnown=false가 되면 key를 폐기하고 동일 credential 복구에서 한 번 재요청한다", async () => {
    const test = setup();
    test.clock.current = snapshot("CLOSED", 5_000);
    test.settings.resolve();
    await test.controller.appear({
      actionId: "a",
      settings: { symbol: "005930" },
      actionPort: { setImage: vi.fn() },
    });
    const oldRequest = test.rest.requests[0]!;

    test.settings.emit({}, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(oldRequest.signal?.aborted).toBe(true);
    expect(test.images.at(-1)?.error?.code).toBe("SETTINGS");

    test.settings.emit({});
    await vi.advanceTimersByTimeAsync(0);
    expect(test.rest.requests).toHaveLength(2);
    test.rest.requests[1]!.resolve(quote("rest", 70_000));
    await vi.advanceTimersByTimeAsync(0);

    expect(test.images.at(-1)?.connection).toBe("BACKUP");
    expect(test.images.at(-1)?.error).toBeUndefined();
  });

  it("60초 정책 tick에서 해외 day/night descriptor를 break-before-make retarget한다", async () => {
    const start = Date.UTC(2026, 0, 5, 6, 29, 30); // 월요일 15:29:30 KST
    vi.setSystemTime(start);
    const cutoff = start + 30_000;
    const overseas: MarketAdapter<TestSettings> = {
      ...makeAdapter("stock"),
      id: "overseas",
      market: "overseas",
      webSocketDescriptor(instrument, nowMs) {
        return { trId: "US", trKey: `${nowMs < cutoff ? "DAY" : "NIGHT"}:${instrument.symbol}` };
      },
    };
    const test = setup({ adapterResolver: () => overseas });
    test.clock.current = snapshot("REG", 5_000, "overseas");
    test.settings.resolve();
    await test.controller.appear({
      actionId: "us",
      settings: { symbol: "005930" },
      actionPort: { setImage: vi.fn() },
    });
    test.subscriptions.data(70_000);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(test.subscriptions.retargets).toEqual([{
      oldDescriptor: { trId: "US", trKey: "DAY:005930" },
      nextDescriptor: { trId: "US", trKey: "NIGHT:005930" },
    }]);
  });

  it("동일 시세의 receivedAt만 바뀌면 같은 semantic key를 제출한다", async () => {
    const test = setup();
    test.settings.resolve();
    await test.controller.appear({
      actionId: "a",
      settings: { symbol: "005930" },
      actionPort: { setImage: vi.fn() },
    });

    test.subscriptions.data(70_000);
    await vi.advanceTimersByTimeAsync(1);
    test.subscriptions.data(70_000);
    await vi.advanceTimersByTimeAsync(0);
    const normal = test.scheduler.requests.filter((request) => request.category === "normal");

    expect(normal).toHaveLength(2);
    expect(normal[0]?.semanticKey).toBe(normal[1]?.semanticKey);
    expect(Object.isFrozen(test.images.at(-1))).toBe(true);
    expect(Object.isFrozen(test.images.at(-1)?.instrument)).toBe(true);
    expect(Object.isFrozen(test.images.at(-1)?.quote)).toBe(true);
  });

  it("BACKUP에서 유효 WS로 회복하면 recovery hold 후 LIVE 일반 view로 돌아간다", async () => {
    const test = setup();
    test.settings.resolve();
    await test.controller.appear({
      actionId: "a",
      settings: { symbol: "005930" },
      actionPort: { setImage: vi.fn() },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    test.rest.requests[0]!.resolve(quote("rest", 69_000));
    await vi.advanceTimersByTimeAsync(0);
    expect(test.images.at(-1)?.connection).toBe("BACKUP");

    test.subscriptions.data(70_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(test.images.at(-1)?.connection).toBe("LIVE");
    expect(test.images.at(-1)?.recovery).toBe(true);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(test.images.at(-1)?.recovery).toBe(false);
  });

  it("실제 scheduler에서 recovery를 2초 이상 보이고 WS 최신 quote로 일반 화면을 복원한다", async () => {
    const renderScheduler = new RenderScheduler({
      now: () => Date.now(),
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });
    const test = setup({ renderScheduler });
    test.settings.resolve();
    const commits: Array<{ at: number; view: StockActionView }> = [];
    await test.controller.appear({
      actionId: "a",
      settings: { symbol: "005930" },
      actionPort: {
        setImage: (image) => {
          commits.push({
            at: Date.now(),
            view: JSON.parse(image) as StockActionView,
          });
        },
      },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    test.rest.requests[0]!.resolve(quote("rest", 69_000));
    await vi.advanceTimersByTimeAsync(2_000);

    test.subscriptions.data(70_000);
    await vi.advanceTimersByTimeAsync(500);
    test.subscriptions.data(71_000);
    await vi.advanceTimersByTimeAsync(1_000);
    test.subscriptions.data(72_000);
    await vi.advanceTimersByTimeAsync(5_000);

    const firstRecovery = commits.find((entry) => entry.view.recovery);
    const firstNormalLive = commits.find((entry) =>
      firstRecovery !== undefined &&
      entry.at > firstRecovery.at &&
      entry.view.connection === "LIVE" &&
      !entry.view.recovery
    );
    expect(firstRecovery).toBeDefined();
    expect(firstNormalLive).toBeDefined();
    expect(firstNormalLive!.at - firstRecovery!.at).toBeGreaterThanOrEqual(2_000);
    expect(firstNormalLive!.view.quote?.price).toBe(72_000);
    renderScheduler.destroy();
  });

  it("recovery timer 등록이 실패하면 recovery 상태에 고정되지 않는다", async () => {
    const test = setup({
      setTimeout: (callback, delayMs) => {
        if (delayMs === 3_000) throw new Error("recovery timer unavailable");
        return setTimeout(callback, delayMs);
      },
    });
    test.settings.resolve();
    await test.controller.appear({
      actionId: "a",
      settings: { symbol: "005930" },
      actionPort: { setImage: vi.fn() },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    test.rest.requests[0]!.resolve(quote("rest", 69_000));
    await vi.advanceTimersByTimeAsync(0);

    test.subscriptions.data(70_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(test.images.at(-1)?.connection).toBe("LIVE");
    expect(test.images.at(-1)?.recovery).toBe(false);
  });

  it("grace timer 등록의 동기 예외는 fallback을 조기 실행하지 않는다", async () => {
    let calls = 0;
    const test = setup({
      setTimeout: (callback, delayMs) => {
        calls += 1;
        if (calls === 2) throw new Error("timer unavailable");
        return setTimeout(callback, delayMs);
      },
    });
    test.settings.resolve();

    await test.controller.appear({
      actionId: "a",
      settings: { symbol: "005930" },
      actionPort: { setImage: vi.fn() },
    });

    expect(test.rest.requests).toHaveLength(0);
  });

  it("retargetAll 동기 예외를 격리하고 즉시 fallback으로 전환한다", async () => {
    class ThrowingSubscriptions extends FakeSubscriptions {
      retargetAll(): Promise<void> {
        throw new Error("retarget unavailable");
      }
    }
    const start = Date.UTC(2026, 0, 5, 6, 29, 30);
    vi.setSystemTime(start);
    const cutoff = start + 30_000;
    const overseas: MarketAdapter<TestSettings> = {
      ...makeAdapter("stock"),
      id: "overseas",
      market: "overseas",
      webSocketDescriptor(instrument, nowMs) {
        return { trId: "US", trKey: `${nowMs < cutoff ? "DAY" : "NIGHT"}:${instrument.symbol}` };
      },
    };
    const subscriptions = new ThrowingSubscriptions();
    const test = setup({ adapterResolver: () => overseas, subscriptions });
    test.clock.current = snapshot("REG", 5_000, "overseas");
    test.settings.resolve();
    await test.controller.appear({
      actionId: "us",
      settings: { symbol: "005930" },
      actionPort: { setImage: vi.fn() },
    });
    test.subscriptions.data(70_000);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(test.rest.requests.some((request) => request.priority === "fallback")).toBe(true);
  });

  it("clearTimeout이 무효여도 disappear 뒤 늦은 timer callback은 세대 검사로 폐기한다", async () => {
    const callbacks: Array<() => void> = [];
    const test = setup({
      setTimeout: (callback) => {
        callbacks.push(callback);
        return callback;
      },
      clearTimeout: () => undefined,
    });
    test.settings.resolve();
    await test.controller.appear({
      actionId: "a",
      settings: { symbol: "005930" },
      actionPort: { setImage: vi.fn() },
    });
    await test.controller.disappear("a");

    for (const callback of callbacks) callback();
    await Promise.resolve();

    expect(test.rest.requests).toHaveLength(0);
  });

  it.each(["throw", "reject"] as const)(
    "setImage %s 실패 뒤 다음 render commit을 계속 처리한다",
    async (failure) => {
      const renderScheduler = new RenderScheduler({
        now: () => Date.now(),
        setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      });
      const test = setup({ renderScheduler });
      test.settings.resolve();
      let attempts = 0;
      const setImage = vi.fn(() => {
        attempts += 1;
        if (attempts !== 1) return undefined;
        if (failure === "throw") throw new Error("sync image failure");
        return Promise.reject(new Error("async image failure"));
      });
      await test.controller.appear({
        actionId: "a",
        settings: { symbol: "005930" },
        actionPort: { setImage },
      });
      await vi.advanceTimersByTimeAsync(1_000);

      test.subscriptions.data(70_000);
      await vi.advanceTimersByTimeAsync(2_000);

      expect(setImage).toHaveBeenCalledTimes(2);
      renderScheduler.destroy();
    },
  );

  it("readiness 대기 중 원본 settings 변경과 accessor를 차단해 한 번 snapshot한 값만 사용한다", async () => {
    const test = setup();
    const mutable = { symbol: "005930" };
    const appearing = test.controller.appear({
      actionId: "snapshot",
      settings: mutable,
      actionPort: { setImage: vi.fn() },
    });
    mutable.symbol = "000660";
    test.settings.resolve();
    await appearing;

    expect(test.subscriptions.subscriptions[0]?.descriptor.trKey).toBe("005930");

    let getterCalls = 0;
    const accessorSettings = Object.create(null) as TestSettings;
    Object.defineProperty(accessorSettings, "symbol", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "035420";
      },
    });
    await expect(test.controller.appear({
      actionId: "accessor",
      settings: accessorSettings,
      actionPort: { setImage: vi.fn() },
    })).rejects.toBeInstanceOf(KisError);
    expect(getterCalls).toBe(0);
  });

  it("lifecycle input proxy/accessor와 유효하지 않은 actionId를 safe KisError로 거부한다", async () => {
    const test = setup();
    test.settings.resolve();
    let portGetterCalls = 0;
    const actionPort = Object.create(null);
    Object.defineProperty(actionPort, "setImage", {
      enumerable: true,
      get() {
        portGetterCalls += 1;
        return vi.fn();
      },
    });
    await expect(test.controller.appear({
      actionId: "port-accessor",
      settings: { symbol: "005930" },
      actionPort,
    })).rejects.toBeInstanceOf(KisError);
    expect(portGetterCalls).toBe(0);

    const proxy = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error("proxy trap");
      },
    });
    await expect(test.controller.appear(proxy as never)).rejects.toBeInstanceOf(KisError);
    await expect(test.controller.manualRefresh("")).rejects.toBeInstanceOf(KisError);
    await expect(test.controller.updateSettings("x".repeat(200), { symbol: "005930" }))
      .rejects.toBeInstanceOf(KisError);
    expect(test.subscriptions.subscriptions).toHaveLength(0);
  });
});
