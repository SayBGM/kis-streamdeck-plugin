import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState } from "../connection-supervisor.js";
import {
  SubscriptionSupervisor,
  type SubscriptionDescriptor,
} from "../subscription-supervisor.js";

type MessageListener = (raw: string) => void | Promise<void>;
type StateListener = (state: ConnectionState) => void | Promise<void>;

class FakeConnection {
  state: ConnectionState = "open";
  retains = 0;
  releases = 0;
  reconnects = 0;
  sendResult = true;
  readonly sent: Array<{ trType: "1" | "2"; trId: string; trKey: string }> = [];
  private readonly messageListeners = new Set<MessageListener>();
  private readonly stateListeners = new Set<StateListener>();

  retain(): Promise<void> {
    this.retains += 1;
    return Promise.resolve();
  }

  release(): void {
    this.releases += 1;
  }

  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  sendKisControl(command: { trType: "1" | "2"; trId: string; trKey: string }): boolean {
    if (!this.sendResult) return false;
    this.sent.push(command);
    return true;
  }

  forceReconnect(): void {
    this.reconnects += 1;
  }

  emitRaw(raw: string): void {
    for (const listener of [...this.messageListeners]) void listener(raw);
  }

  emitState(state: ConnectionState): void {
    this.state = state;
    for (const listener of [...this.stateListeners]) void listener(state);
  }
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function control(trId: string, trKey: string, msgCd = "OPSP0000"): string {
  return JSON.stringify({
    header: { tr_id: trId },
    body: { msg_cd: msgCd, output: { tr_key: trKey } },
  });
}

function domesticData(symbol: string): string {
  return `0|H0UNCNT0|001|${symbol}^100^1`;
}

function overseasData(key: string, ticker: string): string {
  return `0|HDFSCNT0|001|${key}^${ticker}^100`;
}

describe("SubscriptionSupervisor", () => {
  let connection: FakeConnection;
  let supervisor: SubscriptionSupervisor;
  let now: number;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 0;
    connection = new FakeConnection();
    supervisor = new SubscriptionSupervisor({
      connection,
      now: () => now,
      setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    });
  });

  afterEach(() => {
    supervisor.destroy();
    vi.useRealTimers();
  });

  function advance(milliseconds: number): void {
    now += milliseconds;
    vi.advanceTimersByTime(milliseconds);
  }

  it("shares one physical domestic subscription and fans raw data out to every handle", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const descriptor: SubscriptionDescriptor = { trId: "H0UNCNT0", trKey: "005930" };

    const a = supervisor.subscribe(descriptor, { onData: first });
    const b = supervisor.subscribe(descriptor, { onData: second });
    await flush();

    expect(connection.retains).toBe(1);
    expect(connection.sent).toEqual([{ trType: "1", ...descriptor }]);
    connection.emitRaw(control(descriptor.trId, descriptor.trKey));
    connection.emitRaw(domesticData("005930"));

    expect(first).toHaveBeenCalledWith(expect.objectContaining({ descriptor, fields: ["005930", "100", "1"] }));
    expect(second).toHaveBeenCalledTimes(1);
    expect(a.snapshot?.state).toBe("live");
    expect(b.snapshot?.refCount).toBe(2);
  });

  it("routes overseas data by exact realtime key and ticker suffix, but never routes PINGPONG or control JSON", async () => {
    const exact = vi.fn();
    const suffix = vi.fn();
    supervisor.subscribe({ trId: "HDFSCNT0", trKey: "DNASPLTR" }, { onData: exact });
    supervisor.subscribe({ trId: "HDFSCNT0", trKey: "RBAQPLTR" }, { onData: suffix });
    await flush();

    connection.emitRaw("PINGPONG exact-frame");
    connection.emitRaw(control("HDFSCNT0", "DNASPLTR"));
    connection.emitRaw(overseasData("DNASPLTR", "PLTR"));

    expect(exact).toHaveBeenCalledTimes(1);
    expect(suffix).toHaveBeenCalledTimes(1);
  });

  it("serializes control frames, waits 100ms between sends, and requeues a false transport send", async () => {
    const one = { trId: "H0UNCNT0", trKey: "000001" } as const;
    const two = { trId: "H0UNCNT0", trKey: "000002" } as const;
    supervisor.subscribe(one);
    supervisor.subscribe(two);
    await flush();

    expect(connection.sent).toEqual([{ trType: "1", ...one }]);
    connection.emitRaw(control(one.trId, one.trKey));
    expect(connection.sent).toHaveLength(1);
    advance(99);
    expect(connection.sent).toHaveLength(1);
    advance(1);
    expect(connection.sent).toEqual([{ trType: "1", ...one }, { trType: "1", ...two }]);

    connection.emitRaw(control(two.trId, two.trKey));
    connection.sendResult = false;
    const three = { trId: "H0UNCNT0", trKey: "000003" } as const;
    supervisor.subscribe(three);
    await flush();
    advance(100);
    expect(connection.sent).toHaveLength(2);
    connection.sendResult = true;
    advance(100);
    expect(connection.sent.at(-1)).toEqual({ trType: "1", ...three });
  });

  it("forces a fresh transport after a five second control timeout without losing the desired subscription", async () => {
    const descriptor = { trId: "H0UNCNT0", trKey: "005930" } as const;
    const handle = supervisor.subscribe(descriptor);
    await flush();

    advance(5_000);

    expect(connection.reconnects).toBe(1);
    expect(handle.snapshot?.state).toBe("desired");
    expect(connection.sent).toHaveLength(1);
    connection.emitState("reconnect_wait");
    connection.emitState("open");
    expect(connection.sent).toHaveLength(2);
  });

  it("returns live and pending subscriptions to desired on connection loss before resubscribing", async () => {
    const descriptor = { trId: "H0UNCNT0", trKey: "005930" } as const;
    const handle = supervisor.subscribe(descriptor);
    await flush();
    connection.emitRaw(control(descriptor.trId, descriptor.trKey));
    expect(handle.snapshot?.state).toBe("live");

    connection.emitState("reconnect_wait");
    expect(handle.snapshot?.state).toBe("desired");
    connection.emitState("open");
    advance(100);

    expect(connection.sent.at(-1)).toEqual({ trType: "1", ...descriptor });
  });

  it("unsubscribes only after the final shared reference is released and then releases one connection demand", async () => {
    const descriptor = { trId: "H0UNCNT0", trKey: "005930" } as const;
    const first = supervisor.subscribe(descriptor);
    const second = supervisor.subscribe(descriptor);
    await flush();
    connection.emitRaw(control(descriptor.trId, descriptor.trKey));

    first.release();
    expect(connection.sent).toHaveLength(1);
    second.release();
    advance(100);
    expect(connection.sent.at(-1)).toEqual({ trType: "2", ...descriptor });
    connection.emitRaw(control(descriptor.trId, descriptor.trKey, "OPSP0002"));

    expect(connection.releases).toBe(1);
    expect(first.snapshot).toBeUndefined();
    expect(second.snapshot).toBeUndefined();
  });

  it("keeps a reappearing reference when it arrives while the final unsubscribe is awaiting acknowledgement", async () => {
    const descriptor = { trId: "H0UNCNT0", trKey: "005930" } as const;
    const onData = vi.fn();
    const first = supervisor.subscribe(descriptor);
    await flush();
    connection.emitRaw(control(descriptor.trId, descriptor.trKey));

    first.release();
    const reappeared = supervisor.subscribe(descriptor, { onData });
    advance(100);
    expect(connection.sent.at(-1)).toEqual({ trType: "2", ...descriptor });
    connection.emitRaw(control(descriptor.trId, descriptor.trKey, "OPSP0002"));
    advance(100);
    expect(connection.sent.at(-1)).toEqual({ trType: "1", ...descriptor });
    connection.emitRaw(control(descriptor.trId, descriptor.trKey));
    connection.emitRaw(domesticData(descriptor.trKey));

    expect(reappeared.snapshot?.state).toBe("live");
    expect(onData).toHaveBeenCalledTimes(1);
    expect(connection.retains).toBe(1);
  });

  it("marks an active subscription stale after twenty seconds and ignores late data after release", async () => {
    const onState = vi.fn();
    const onData = vi.fn();
    const descriptor = { trId: "H0UNCNT0", trKey: "005930" } as const;
    const handle = supervisor.subscribe(descriptor, { onState, onData });
    await flush();
    connection.emitRaw(control(descriptor.trId, descriptor.trKey));
    connection.emitRaw(domesticData("005930"));

    advance(20_000);
    expect(handle.snapshot?.state).toBe("stale");
    expect(onState).toHaveBeenCalledWith(expect.objectContaining({ state: "stale" }));

    handle.release();
    expect(connection.sent.at(-1)).toEqual({ trType: "2", ...descriptor });
    connection.emitRaw(control(descriptor.trId, descriptor.trKey, "OPSP0002"));
    connection.emitRaw(domesticData("005930"));

    expect(onData).toHaveBeenCalledTimes(1);
    expect(connection.releases).toBe(1);
  });

  it("retargets all references only after the old key unsubscribe acknowledgement", async () => {
    const oldDescriptor = { trId: "HDFSCNT0", trKey: "RBAQPLTR" } as const;
    const nextDescriptor = { trId: "HDFSCNT0", trKey: "DNASPLTR" } as const;
    const data = vi.fn();
    const first = supervisor.subscribe(oldDescriptor, { onData: data });
    const second = supervisor.subscribe(oldDescriptor);
    await flush();
    connection.emitRaw(control(oldDescriptor.trId, oldDescriptor.trKey));

    const retargeted = supervisor.retargetAll(oldDescriptor, nextDescriptor);
    advance(100);
    expect(connection.sent.at(-1)).toEqual({ trType: "2", ...oldDescriptor });
    expect(first.snapshot?.descriptor).toEqual(oldDescriptor);
    connection.emitRaw(control(oldDescriptor.trId, oldDescriptor.trKey, "OPSP0002"));
    await retargeted;
    advance(100);

    expect(first.snapshot?.descriptor).toEqual(nextDescriptor);
    expect(second.snapshot?.descriptor).toEqual(nextDescriptor);
    expect(connection.retains).toBe(1);
    expect(connection.releases).toBe(0);
    expect(connection.sent.at(-1)).toEqual({ trType: "1", ...nextDescriptor });
    connection.emitRaw(control(oldDescriptor.trId, oldDescriptor.trKey));
    expect(first.snapshot?.state).toBe("pending");
    connection.emitRaw(control(nextDescriptor.trId, nextDescriptor.trKey));
    connection.emitRaw(overseasData(oldDescriptor.trKey, "PLTR"));
    connection.emitRaw(overseasData(nextDescriptor.trKey, "PLTR"));
    expect(data).toHaveBeenCalledTimes(1);
  });

  it("returns a safe error for a descriptor with an accessor instead of invoking the accessor", () => {
    const descriptor = {} as { trId: string; trKey: string };
    Object.defineProperty(descriptor, "trId", {
      enumerable: true,
      get: () => { throw new Error("must not execute"); },
    });
    Object.defineProperty(descriptor, "trKey", { enumerable: true, value: "005930" });

    expect(() => supervisor.subscribe(descriptor)).toThrow(expect.objectContaining({
      code: "SETTINGS",
      scope: "websocket",
    }));
  });

  it("returns a safe error when descriptor proxy reflection throws", () => {
    const descriptor = new Proxy({ trId: "H0UNCNT0", trKey: "005930" }, {
      getPrototypeOf: () => { throw new Error("must not execute outside the boundary"); },
    });

    expect(() => supervisor.subscribe(descriptor)).toThrow(expect.objectContaining({
      code: "SETTINGS",
      scope: "websocket",
    }));
  });

  it("parks the 42nd physical subscription and rotates it in after the oldest live key is released", async () => {
    const descriptors = Array.from({ length: 42 }, (_, index) => ({
      trId: "H0UNCNT0",
      trKey: String(index).padStart(6, "0"),
    }));
    for (const descriptor of descriptors) supervisor.subscribe(descriptor);
    await flush();

    for (let index = 0; index < 41; index += 1) {
      const command = connection.sent.at(-1)!;
      connection.emitRaw(control(command.trId, command.trKey));
      if (index < 40) advance(100);
    }
    expect(supervisor.getSnapshot(descriptors[41])?.state).toBe("parked");

    // Lease timer는 실제 clock과 분리해 실행한다. stale 판정은 이 테스트의 대상이 아니다.
    vi.advanceTimersByTime(60_000);
    advance(100);
    expect(connection.sent.at(-1)).toEqual({ trType: "2", ...descriptors[0] });
    connection.emitRaw(control(descriptors[0].trId, descriptors[0].trKey, "OPSP0002"));
    advance(100);

    expect(connection.sent.at(-1)).toEqual({ trType: "1", ...descriptors[41] });
  });

  async function settleInitialLiveSubscriptions(count: number): Promise<Array<{ trId: string; trKey: string }>> {
    const descriptors = Array.from({ length: count }, (_, index) => ({
      trId: "H0UNCNT0",
      trKey: String(index).padStart(6, "0"),
    }));
    for (const descriptor of descriptors) supervisor.subscribe(descriptor);
    await flush();
    for (let index = 0; index < 41; index += 1) {
      const command = connection.sent.at(-1)!;
      connection.emitRaw(control(command.trId, command.trKey));
      if (index < 40) advance(100);
    }
    return descriptors;
  }

  async function completeLease(descriptors: Array<{ trId: string; trKey: string }>, replacements: number): Promise<void> {
    vi.advanceTimersByTime(60_000);
    advance(100);
    for (let index = 0; index < replacements; index += 1) {
      expect(connection.sent.at(-1)).toEqual({ trType: "2", ...descriptors[index] });
      connection.emitRaw(control(descriptors[index].trId, descriptors[index].trKey, "OPSP0002"));
      advance(100);
      expect(connection.sent.at(-1)).toEqual({ trType: "1", ...descriptors[41 + index] });
      connection.emitRaw(control(descriptors[41 + index].trId, descriptors[41 + index].trKey));
      if (index < replacements - 1) advance(100);
    }
  }

  it("rotates the oldest 9 live subscriptions for 50 unique desired keys without overlapping leases", async () => {
    const descriptors = await settleInitialLiveSubscriptions(50);

    vi.advanceTimersByTime(60_000);
    advance(100);
    expect(connection.sent.at(-1)).toEqual({ trType: "2", ...descriptors[0] });
    (supervisor as unknown as { startRotationLease(): void }).startRotationLease();
    expect(connection.sent.at(-1)).toEqual({ trType: "2", ...descriptors[0] });

    connection.emitRaw(control(descriptors[0].trId, descriptors[0].trKey, "OPSP0002"));
    advance(100);
    expect(connection.sent.at(-1)).toEqual({ trType: "1", ...descriptors[41] });
    connection.emitRaw(control(descriptors[41].trId, descriptors[41].trKey));
    advance(100);
    for (let index = 1; index < 9; index += 1) {
      expect(connection.sent.at(-1)).toEqual({ trType: "2", ...descriptors[index] });
      connection.emitRaw(control(descriptors[index].trId, descriptors[index].trKey, "OPSP0002"));
      advance(100);
      expect(connection.sent.at(-1)).toEqual({ trType: "1", ...descriptors[41 + index] });
      connection.emitRaw(control(descriptors[41 + index].trId, descriptors[41 + index].trKey));
      if (index < 8) advance(100);
    }
  });

  it("rotates all 41 lease pairs in order for 82 unique desired keys", async () => {
    const descriptors = await settleInitialLiveSubscriptions(82);
    await completeLease(descriptors, 41);
  });
});
