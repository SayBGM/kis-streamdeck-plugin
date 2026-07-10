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
});
