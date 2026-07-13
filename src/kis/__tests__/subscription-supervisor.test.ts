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

  get listenerCount(): number {
    return this.messageListeners.size + this.stateListeners.size;
  }

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

function kisControl(trId: string, trKey: string, msgCd = "OPSP0000"): string {
  return JSON.stringify({
    header: { tr_id: trId, tr_key: trKey, encrypt: "N" },
    body: {
      rt_cd: msgCd === "OPSP0000" || msgCd === "OPSP0002" ? "0" : "1",
      msg_cd: msgCd,
      msg1: "SUBSCRIBE SUCCESS",
    },
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
      monotonicNow: () => now,
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

  it("prefers an active overseas exact realtime key over ticker fallback", async () => {
    const exact = vi.fn();
    const suffix = vi.fn();
    supervisor.subscribe({ trId: "HDFSCNT0", trKey: "DNASPLTR" }, { onData: exact });
    supervisor.subscribe({ trId: "HDFSCNT0", trKey: "RBAQPLTR" }, { onData: suffix });
    await flush();

    connection.emitRaw("PINGPONG exact-frame");
    connection.emitRaw(control("HDFSCNT0", "DNASPLTR"));
    connection.emitRaw(overseasData("DNASPLTR", "PLTR"));

    expect(exact).toHaveBeenCalledTimes(1);
    expect(suffix).not.toHaveBeenCalled();
  });

  it("uses strict four-character-prefix overseas fallback only for one active physical key", async () => {
    const exactSymbol = vi.fn();
    const suffixOnly = vi.fn();
    const ambiguous = vi.fn();
    supervisor.subscribe({ trId: "HDFSCNT0", trKey: "DNASPLTR" }, { onData: exactSymbol });
    supervisor.subscribe({ trId: "HDFSCNT0", trKey: "RBAQPLTR" }, { onData: ambiguous });
    await flush();
    connection.emitRaw(control("HDFSCNT0", "DNASPLTR"));
    advance(100);
    connection.emitRaw(control("HDFSCNT0", "RBAQPLTR"));

    connection.emitRaw(overseasData("UNKNOWN", "PLTR"));
    expect(exactSymbol).not.toHaveBeenCalled();
    expect(ambiguous).not.toHaveBeenCalled();

    const single = new SubscriptionSupervisor({
      connection,
      now: () => now,
      monotonicNow: () => now,
      setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    });
    single.subscribe({ trId: "HDFSCNT0", trKey: "DNASA" }, { onData: suffixOnly });
    advance(100);
    connection.emitRaw(control("HDFSCNT0", "DNASA"));
    connection.emitRaw(overseasData("UNKNOWN", "A"));
    expect(suffixOnly).toHaveBeenCalledTimes(1);
    single.destroy();

    const noSuffixConnection = new FakeConnection();
    const noSuffix = new SubscriptionSupervisor({
      connection: noSuffixConnection,
      now: () => now,
      monotonicNow: () => now,
      setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    });
    const denied = vi.fn();
    noSuffix.subscribe({ trId: "HDFSCNT0", trKey: "DNASAA" }, { onData: denied });
    await flush();
    noSuffixConnection.emitRaw(control("HDFSCNT0", "DNASAA"));
    noSuffixConnection.emitRaw(overseasData("UNKNOWN", "A"));
    expect(denied).not.toHaveBeenCalled();
    noSuffix.destroy();
  });

  it("does not acknowledge a keyless control reply and reconnects at the control timeout", async () => {
    const descriptor = { trId: "H0UNCNT0", trKey: "005930" } as const;
    const handle = supervisor.subscribe(descriptor);
    await flush();
    connection.emitRaw(JSON.stringify({
      header: { tr_id: descriptor.trId },
      body: { msg_cd: "OPSP0000" },
    }));

    expect(handle.snapshot?.state).toBe("pending");
    advance(5_000);
    expect(connection.reconnects).toBe(1);
  });

  it("accepts the KIS control key from the response header without reconnecting", async () => {
    const descriptor = { trId: "H0UNCNT0", trKey: "005930" } as const;
    const handle = supervisor.subscribe(descriptor);
    await flush();

    connection.emitRaw(kisControl(descriptor.trId, descriptor.trKey));

    expect(handle.snapshot?.state).toBe("live");
    advance(5_000);
    expect(connection.reconnects).toBe(0);
  });

  it("does not acknowledge a different KIS header control key", async () => {
    const descriptor = { trId: "H0UNCNT0", trKey: "005930" } as const;
    const handle = supervisor.subscribe(descriptor);
    await flush();

    connection.emitRaw(kisControl(descriptor.trId, "000660"));

    expect(handle.snapshot?.state).toBe("pending");
    advance(5_000);
    expect(connection.reconnects).toBe(1);
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

  async function settleInitialLiveHandles(count: number): Promise<{
    descriptors: Array<{ trId: string; trKey: string }>;
    handles: ReturnType<SubscriptionSupervisor["subscribe"]>[];
  }> {
    const descriptors = Array.from({ length: count }, (_, index) => ({
      trId: "H0UNCNT0",
      trKey: String(index).padStart(6, "0"),
    }));
    const handles = descriptors.map((descriptor) => supervisor.subscribe(descriptor));
    await flush();
    for (let index = 0; index < 41; index += 1) {
      const command = connection.sent.at(-1)!;
      connection.emitRaw(control(command.trId, command.trKey));
      if (index < 40) advance(100);
    }
    return { descriptors, handles };
  }

  function beginRotationLease(): void {
    vi.advanceTimersByTime(60_000);
    advance(100);
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

  it("promotes the oldest parked key when a live subscription is rejected", async () => {
    const descriptors = Array.from({ length: 42 }, (_, index) => ({
      trId: "H0UNCNT0",
      trKey: String(index).padStart(6, "0"),
    }));
    for (const descriptor of descriptors) supervisor.subscribe(descriptor);
    await flush();
    connection.emitRaw(control(descriptors[0].trId, descriptors[0].trKey, "ERROR"));

    expect(supervisor.getSnapshot(descriptors[0])?.state).toBe("rejected");
    expect(supervisor.getSnapshot(descriptors[41])?.state).toBe("desired");
    for (let index = 1; index < 41; index += 1) {
      advance(100);
      expect(connection.sent.at(-1)).toEqual({ trType: "1", ...descriptors[index] });
      connection.emitRaw(control(descriptors[index].trId, descriptors[index].trKey));
    }
    advance(100);
    expect(connection.sent.at(-1)).toEqual({ trType: "1", ...descriptors[41] });
  });

  it("promotes the oldest parked key after a live final-reference release is acknowledged", async () => {
    const descriptors = Array.from({ length: 42 }, (_, index) => ({
      trId: "H0UNCNT0",
      trKey: String(index).padStart(6, "0"),
    }));
    const first = supervisor.subscribe(descriptors[0]);
    for (const descriptor of descriptors.slice(1)) supervisor.subscribe(descriptor);
    await flush();
    for (let index = 0; index < 41; index += 1) {
      const command = connection.sent.at(-1)!;
      connection.emitRaw(control(command.trId, command.trKey));
      if (index < 40) advance(100);
    }

    first.release();
    advance(100);
    expect(connection.sent.at(-1)).toEqual({ trType: "2", ...descriptors[0] });
    connection.emitRaw(control(descriptors[0].trId, descriptors[0].trKey, "OPSP0002"));
    advance(100);

    expect(connection.sent.at(-1)).toEqual({ trType: "1", ...descriptors[41] });
  });

  it("cancels a current rotation pair when its outgoing final reference is released", async () => {
    const { descriptors, handles } = await settleInitialLiveHandles(42);
    beginRotationLease();
    expect(connection.sent.at(-1)).toEqual({ trType: "2", ...descriptors[0] });

    handles[0].release();
    connection.emitRaw(control(descriptors[0].trId, descriptors[0].trKey, "OPSP0002"));

    expect(handles[0].snapshot).toBeUndefined();
    expect(connection.releases).toBe(1);
  });

  it("cancels a queued outgoing rotation pair before its unsubscribe is sent", async () => {
    const { descriptors, handles } = await settleInitialLiveHandles(50);
    beginRotationLease();
    expect(connection.sent.at(-1)).toEqual({ trType: "2", ...descriptors[0] });

    handles[1].release();
    connection.emitRaw(control(descriptors[0].trId, descriptors[0].trKey, "OPSP0002"));
    advance(100);
    expect(connection.sent.at(-1)).toEqual({ trType: "2", ...descriptors[1] });
    connection.emitRaw(control(descriptors[1].trId, descriptors[1].trKey, "OPSP0002"));
    advance(100);
    expect(connection.sent.at(-1)).toEqual({ trType: "1", ...descriptors[0] });
  });

  it("retargets a current outgoing key without leaving rotation blocked", async () => {
    const { descriptors } = await settleInitialLiveHandles(42);
    const next = { trId: "H0UNCNT0", trKey: "900000" } as const;
    beginRotationLease();
    const retargeted = supervisor.retargetAll(descriptors[0], next);
    connection.emitRaw(control(descriptors[0].trId, descriptors[0].trKey, "OPSP0002"));
    await retargeted;
    advance(100);
    expect(connection.sent.at(-1)).toEqual({ trType: "1", ...next });
    connection.emitRaw(control(next.trId, next.trKey));

    (supervisor as unknown as { startRotationLease(): void }).startRotationLease();
    advance(100);
    expect(connection.sent.at(-1)).toEqual({ trType: "2", ...descriptors[1] });
  });

  it("removes a current incoming key and lets the outgoing key resume normally", async () => {
    const { descriptors, handles } = await settleInitialLiveHandles(42);
    beginRotationLease();
    handles[41].release();
    expect(handles[41].snapshot).toBeUndefined();
    expect(connection.releases).toBe(1);

    connection.emitRaw(control(descriptors[0].trId, descriptors[0].trKey, "OPSP0002"));
    advance(100);
    expect(connection.sent.at(-1)).toEqual({ trType: "1", ...descriptors[0] });
  });

  it("keeps a retargeted parked source parked without sending a 42nd subscribe", async () => {
    const { descriptors } = await settleInitialLiveHandles(42);
    const next = { trId: "H0UNCNT0", trKey: "900041" } as const;
    const sentBefore = connection.sent.length;

    await supervisor.retargetAll(descriptors[41], next);

    expect(supervisor.getSnapshot(next)?.state).toBe("parked");
    expect(connection.sent).toHaveLength(sentBefore);
  });

  it("promotes the oldest parked key after a live source merges into an existing live target", async () => {
    const { descriptors } = await settleInitialLiveHandles(43);
    const retargeted = supervisor.retargetAll(descriptors[0], descriptors[1]);
    advance(100);
    expect(connection.sent.at(-1)).toEqual({ trType: "2", ...descriptors[0] });
    connection.emitRaw(control(descriptors[0].trId, descriptors[0].trKey, "OPSP0002"));
    await retargeted;
    advance(100);

    expect(connection.sent.at(-1)).toEqual({ trType: "1", ...descriptors[41] });
  });

  it("promotes a parked merge target after the live source is removed", async () => {
    const { descriptors } = await settleInitialLiveHandles(43);
    const retargeted = supervisor.retargetAll(descriptors[0], descriptors[41]);
    advance(100);
    connection.emitRaw(control(descriptors[0].trId, descriptors[0].trKey, "OPSP0002"));
    await retargeted;
    advance(100);

    expect(supervisor.getSnapshot(descriptors[41])?.state).toBe("pending");
    expect(connection.sent.at(-1)).toEqual({ trType: "1", ...descriptors[41] });
  });

  it("keeps a retargeted rotation incoming key parked until a capacity slot exists", async () => {
    const { descriptors } = await settleInitialLiveHandles(42);
    const next = { trId: "H0UNCNT0", trKey: "900042" } as const;
    beginRotationLease();
    const sentBefore = connection.sent.length;

    await supervisor.retargetAll(descriptors[41], next);

    expect(supervisor.getSnapshot(next)?.state).toBe("parked");
    expect(connection.sent).toHaveLength(sentBefore);
  });

  it("cancels a queued target unsubscribe before merging a retargeted source into it", async () => {
    const source = { trId: "H0UNCNT0", trKey: "000001" } as const;
    const target = { trId: "H0UNCNT0", trKey: "000002" } as const;
    const sourceHandle = supervisor.subscribe(source);
    const targetHandle = supervisor.subscribe(target);
    await flush();
    connection.emitRaw(control(source.trId, source.trKey));
    advance(100);
    connection.emitRaw(control(target.trId, target.trKey));

    const retargeted = supervisor.retargetAll(source, target);
    advance(100);
    expect(connection.sent.at(-1)).toEqual({ trType: "2", ...source });
    targetHandle.release();
    connection.emitRaw(control(source.trId, source.trKey, "OPSP0002"));
    await retargeted;

    expect(sourceHandle.descriptor).toEqual(target);
    expect(sourceHandle.snapshot?.refCount).toBe(1);
    advance(100);
    expect(connection.sent.at(-1)).not.toEqual({ trType: "2", ...target });
  });

  it("does not let a target unsubscribe acknowledgement delete source handles after current unsubscribe separation", async () => {
    const source = { trId: "H0UNCNT0", trKey: "000011" } as const;
    const target = { trId: "H0UNCNT0", trKey: "000012" } as const;
    const sourceHandle = supervisor.subscribe(source);
    const targetHandle = supervisor.subscribe(target);
    await flush();
    connection.emitRaw(control(source.trId, source.trKey));
    advance(100);
    connection.emitRaw(control(target.trId, target.trKey));

    targetHandle.release();
    advance(100);
    expect(connection.sent.at(-1)).toEqual({ trType: "2", ...target });
    const retargeted = supervisor.retargetAll(source, target);
    connection.emitRaw(control(target.trId, target.trKey, "OPSP0002"));
    advance(100);
    expect(connection.sent.at(-1)).toEqual({ trType: "2", ...source });
    connection.emitRaw(control(source.trId, source.trKey, "OPSP0002"));
    await retargeted;
    advance(100);
    expect(connection.sent.at(-1)).toEqual({ trType: "1", ...target });
    connection.emitRaw(control(target.trId, target.trKey));

    expect(sourceHandle.descriptor).toEqual(target);
    expect(sourceHandle.snapshot?.state).toBe("live");
    expect(connection.releases).toBe(1);
  });

  it("commits a pending job before an onState listener destroys the supervisor", async () => {
    const descriptor = { trId: "H0UNCNT0", trKey: "005930" } as const;
    const handle = supervisor.subscribe(descriptor, {
      onState: (snapshot) => {
        if (snapshot.state === "pending") supervisor.destroy();
      },
    });
    await flush();
    advance(5_000);

    expect(handle.snapshot).toBeUndefined();
    expect(connection.reconnects).toBe(0);
    expect(connection.releases).toBe(1);
  });

  it("commits retarget transfer before an onState callback destroys the supervisor", async () => {
    const source = { trId: "H0UNCNT0", trKey: "000021" } as const;
    const next = { trId: "H0UNCNT0", trKey: "000022" } as const;
    const handle = supervisor.subscribe(source, {
      onState: (snapshot) => {
        if (snapshot.descriptor.trKey === next.trKey) supervisor.destroy();
      },
    });
    await flush();
    connection.emitRaw(control(source.trId, source.trKey));

    const retargeted = supervisor.retargetAll(source, next);
    advance(100);
    connection.emitRaw(control(source.trId, source.trKey, "OPSP0002"));
    await retargeted;

    expect(handle.snapshot).toBeUndefined();
    expect(connection.retains).toBe(1);
    expect(connection.releases).toBe(1);
  });

  it("uses monotonic spacing so a wall-clock rollback cannot stall the next control frame", async () => {
    const first = { trId: "H0UNCNT0", trKey: "000031" } as const;
    const second = { trId: "H0UNCNT0", trKey: "000032" } as const;
    supervisor.subscribe(first);
    await flush();
    connection.emitRaw(control(first.trId, first.trKey));
    now = -3_600_000;
    supervisor.subscribe(second);
    vi.advanceTimersByTime(100);

    expect(connection.sent.at(-1)).toEqual({ trType: "1", ...second });
  });

  it("drops oversized field payloads before split and never delivers them", async () => {
    const descriptor = { trId: "H0UNCNT0", trKey: "005930" } as const;
    const onData = vi.fn();
    supervisor.subscribe(descriptor, { onData });
    await flush();
    connection.emitRaw(control(descriptor.trId, descriptor.trKey));
    connection.emitRaw(`0|H0UNCNT0|001|${Array.from({ length: 129 }, () => "x").join("^")}`);

    expect(onData).not.toHaveBeenCalled();
  });

  it("records a frozen safe diagnostic when a subscription is rejected", async () => {
    const diagnostics = { record: vi.fn(), increment: vi.fn() };
    const isolatedConnection = new FakeConnection();
    const isolated = new SubscriptionSupervisor({
      connection: isolatedConnection,
      now: () => now,
      monotonicNow: () => now,
      diagnostics,
      setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    });
    const descriptor = { trId: "H0UNCNT0", trKey: "005930" } as const;
    isolated.subscribe(descriptor);
    await flush();
    isolatedConnection.emitRaw(control(descriptor.trId, descriptor.trKey, "ERROR"));

    expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({
      code: "SUBSCRIPTION_REJECTED",
      scope: "websocket",
    }));
    expect(Object.isFrozen(diagnostics.record.mock.calls[0][0])).toBe(true);
    expect(diagnostics.increment).toHaveBeenCalledWith("subscriptionRejects");
    isolated.destroy();
  });

  it("rolls back constructor listeners when the second interval cannot be armed", () => {
    const isolatedConnection = new FakeConnection();
    let intervalCalls = 0;
    const clearInterval = vi.fn(() => { throw new Error("stale interval clear failed"); });

    expect(() => new SubscriptionSupervisor({
      connection: isolatedConnection,
      setInterval: () => {
        intervalCalls += 1;
        if (intervalCalls === 2) throw new Error("rotation timer unavailable");
        return { id: intervalCalls };
      },
      clearInterval,
    })).toThrow(expect.objectContaining({ code: "SETTINGS" }));

    expect(isolatedConnection.listenerCount).toBe(0);
    expect(clearInterval).toHaveBeenCalledTimes(1);
  });

  it("does not retain a stale timeout handle when a host timer fires synchronously", async () => {
    const isolatedConnection = new FakeConnection();
    const synchronous = new SubscriptionSupervisor({
      connection: isolatedConnection,
      now: () => now,
      monotonicNow: () => now,
      setTimeout: (callback) => {
        callback();
        return { synchronous: true };
      },
      clearTimeout: vi.fn(),
    });
    const descriptor = { trId: "H0UNCNT0", trKey: "000099" } as const;
    synchronous.subscribe(descriptor);
    await flush();

    expect(isolatedConnection.reconnects).toBe(1);
    expect(synchronous.getSnapshot(descriptor)?.state).toBe("desired");
    synchronous.destroy();
  });

  it("wakes a rejected source retarget after its pending removing target finishes unsubscribe", async () => {
    const source = { trId: "H0UNCNT0", trKey: "000111" } as const;
    const target = { trId: "H0UNCNT0", trKey: "000112" } as const;
    const sourceHandle = supervisor.subscribe(source);
    await flush();
    connection.emitRaw(control(source.trId, source.trKey, "ERROR"));
    const targetHandle = supervisor.subscribe(target);
    advance(100);
    targetHandle.release();

    const retargeted = supervisor.retargetAll(source, target);
    connection.emitRaw(control(target.trId, target.trKey));
    advance(100);
    expect(connection.sent.at(-1)).toEqual({ trType: "2", ...target });
    connection.emitRaw(control(target.trId, target.trKey, "OPSP0002"));
    await retargeted;
    advance(100);

    expect(connection.sent.at(-1)).toEqual({ trType: "1", ...target });
    expect(sourceHandle.descriptor).toEqual(target);
  });

  it("commits rejected diagnostics before a rejected-state callback destroys the supervisor", async () => {
    const diagnostics = { record: vi.fn(), increment: vi.fn() };
    const isolatedConnection = new FakeConnection();
    const isolated = new SubscriptionSupervisor({
      connection: isolatedConnection,
      diagnostics,
      setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    });
    const descriptor = { trId: "H0UNCNT0", trKey: "000113" } as const;
    isolated.subscribe(descriptor, {
      onState: (snapshot) => {
        if (snapshot.state === "rejected") isolated.destroy();
      },
    });
    await flush();
    isolatedConnection.emitRaw(control(descriptor.trId, descriptor.trKey, "ERROR"));

    expect(diagnostics.record).toHaveBeenCalledTimes(1);
    expect(diagnostics.increment).toHaveBeenCalledWith("subscriptionRejects");
  });

  it("keeps ACK state progress and destroy cleanup when clear callbacks throw", async () => {
    const isolatedConnection = new FakeConnection();
    const throwing = new SubscriptionSupervisor({
      connection: isolatedConnection,
      clearTimeout: () => { throw new Error("clear timeout failed"); },
      clearInterval: () => { throw new Error("clear interval failed"); },
    });
    const descriptor = { trId: "H0UNCNT0", trKey: "000114" } as const;
    const handle = throwing.subscribe(descriptor);
    await flush();

    expect(() => isolatedConnection.emitRaw(control(descriptor.trId, descriptor.trKey))).not.toThrow();
    expect(handle.snapshot?.state).toBe("live");
    expect(() => throwing.destroy()).not.toThrow();
    expect(isolatedConnection.listenerCount).toBe(0);
  });

  it("wakes a target-identity waiter when the removing target reappears", async () => {
    const source = { trId: "H0UNCNT0", trKey: "000121" } as const;
    const target = { trId: "H0UNCNT0", trKey: "000122" } as const;
    const sourceHandle = supervisor.subscribe(source);
    await flush();
    connection.emitRaw(control(source.trId, source.trKey, "ERROR"));
    const targetHandle = supervisor.subscribe(target);
    advance(100);
    targetHandle.release();
    const retargeted = supervisor.retargetAll(source, target);

    const reappeared = supervisor.subscribe(target);
    await retargeted;
    expect(sourceHandle.descriptor).toEqual(target);
    expect(sourceHandle.snapshot?.refCount).toBe(2);
    connection.emitRaw(control(target.trId, target.trKey));
    advance(100);
    expect(connection.sent.at(-1)).not.toEqual({ trType: "2", ...target });
    reappeared.release();
  });

  it("settles and detaches a waiting retarget when its source is finally released", async () => {
    const source = { trId: "H0UNCNT0", trKey: "000131" } as const;
    const target = { trId: "H0UNCNT0", trKey: "000132" } as const;
    const sourceHandle = supervisor.subscribe(source);
    await flush();
    connection.emitRaw(control(source.trId, source.trKey, "ERROR"));
    const targetHandle = supervisor.subscribe(target);
    advance(100);
    targetHandle.release();
    const retargeted = supervisor.retargetAll(source, target);

    sourceHandle.release();
    await expect(retargeted).resolves.toBeUndefined();
    expect(sourceHandle.snapshot).toBeUndefined();
  });

  it("commits target waiter wake before a reappeared target callback destroys the supervisor", async () => {
    const source = { trId: "H0UNCNT0", trKey: "000141" } as const;
    const target = { trId: "H0UNCNT0", trKey: "000142" } as const;
    const sourceHandle = supervisor.subscribe(source);
    await flush();
    connection.emitRaw(control(source.trId, source.trKey, "ERROR"));
    const targetHandle = supervisor.subscribe(target);
    advance(100);
    targetHandle.release();
    const retargeted = supervisor.retargetAll(source, target);

    supervisor.subscribe(target, {
      onState: (snapshot) => {
        if (snapshot.refCount === 2) supervisor.destroy();
      },
    });
    await retargeted;

    expect(sourceHandle.snapshot).toBeUndefined();
    expect(connection.listenerCount).toBe(0);
  });
});
