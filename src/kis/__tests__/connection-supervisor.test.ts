import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalKeyLease } from "../credential-session.js";
import {
  ConnectionSupervisor,
  type SocketLike,
} from "../connection-supervisor.js";

type Listener = (...args: unknown[]) => void;

class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  closeCalls = 0;
  terminateCalls = 0;
  pingCalls = 0;
  throwOnSend = false;
  private readonly listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  send(data: string): void {
    if (this.throwOnSend) throw new Error("send failed");
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
  }

  terminate(): void {
    this.terminateCalls += 1;
    this.readyState = 3;
  }

  ping(): void {
    this.pingCalls += 1;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

function lease(
  approvalKey = "approval-1",
  credentialGeneration = 1,
): ApprovalKeyLease {
  return Object.freeze({
    approvalKey,
    credentialGeneration,
    credentialFingerprint: `fingerprint-${credentialGeneration}`,
  });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("ConnectionSupervisor", () => {
  let sockets: FakeSocket[];
  let getApprovalKey: ReturnType<typeof vi.fn>;
  let now: number;
  let supervisor: ConnectionSupervisor;
  let timeoutDelays: number[];
  let intervals: Array<{ callback: () => void; milliseconds: number }>;

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    now = 0;
    timeoutDelays = [];
    intervals = [];
    getApprovalKey = vi.fn().mockResolvedValue(lease());
    supervisor = new ConnectionSupervisor({
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      credentials: { getApprovalKey },
      now: () => now,
      random: () => 0.5,
      setTimeout: (callback, milliseconds) => {
        timeoutDelays.push(milliseconds);
        return setTimeout(callback, milliseconds);
      },
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      setInterval: (callback, milliseconds) => {
        intervals.push({ callback, milliseconds });
        return setInterval(callback, milliseconds);
      },
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
      url: "ws://test.invalid",
    });
  });

  afterEach(() => {
    supervisor.destroy();
    vi.useRealTimers();
  });

  async function retainAndOpen(): Promise<FakeSocket> {
    void supervisor.retain();
    await flush();
    const socket = sockets[0];
    expect(socket).toBeDefined();
    socket.readyState = 1;
    socket.emit("open");
    await flush();
    return socket;
  }

  function advance(milliseconds: number): void {
    now += milliseconds;
    vi.advanceTimersByTime(milliseconds);
  }

  it("transitions idle → connecting → open only after the current socket opens", async () => {
    expect(supervisor.state).toBe("idle");

    void supervisor.retain();
    expect(supervisor.state).toBe("connecting");
    await flush();
    expect(sockets).toHaveLength(1);

    sockets[0].readyState = 1;
    sockets[0].emit("open");
    await flush();

    expect(supervisor.state).toBe("open");
    expect(supervisor.demand).toBe(1);
  });

  it("settles the retain promise without creating a socket when a connecting listener releases demand", async () => {
    supervisor.onState((state) => {
      if (state === "connecting") supervisor.release();
    });

    const retained = supervisor.retain();
    await flush();

    await expect(retained).rejects.toMatchObject({ code: "NETWORK" });
    expect(supervisor.state).toBe("idle");
    expect(sockets).toHaveLength(0);
  });

  it("settles the retain promise without creating a socket when a connecting listener destroys it", async () => {
    supervisor.onState((state) => {
      if (state === "connecting") supervisor.destroy();
    });

    const retained = supervisor.retain();
    await flush();

    await expect(retained).rejects.toMatchObject({ code: "SETTINGS" });
    expect(supervisor.state).toBe("stopped");
    expect(sockets).toHaveLength(0);
  });

  it("does not start heartbeat timers after an open listener releases demand", async () => {
    supervisor.onState((state) => {
      if (state === "open") supervisor.release();
    });

    const retained = supervisor.retain();
    await flush();
    sockets[0].readyState = 1;
    sockets[0].emit("open");
    await flush();

    await expect(retained).resolves.toBeUndefined();
    expect(supervisor.state).toBe("idle");
    expect(sockets[0].terminateCalls).toBe(1);
    expect(intervals.some(({ milliseconds }) => milliseconds === 15_000)).toBe(false);
  });

  it("does not start heartbeat timers after an open listener destroys it", async () => {
    supervisor.onState((state) => {
      if (state === "open") supervisor.destroy();
    });

    const retained = supervisor.retain();
    await flush();
    sockets[0].readyState = 1;
    sockets[0].emit("open");
    await flush();

    await expect(retained).resolves.toBeUndefined();
    expect(supervisor.state).toBe("stopped");
    expect(sockets[0].terminateCalls).toBe(1);
    expect(intervals.some(({ milliseconds }) => milliseconds === 15_000)).toBe(false);
  });

  it("shares one connect attempt for multiple retained consumers", async () => {
    void supervisor.retain();
    void supervisor.retain();
    await flush();

    expect(getApprovalKey).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(1);
    expect(supervisor.demand).toBe(2);
  });

  it("returns to idle and cancels transport timers when demand reaches zero", async () => {
    const socket = await retainAndOpen();

    supervisor.release();

    expect(supervisor.state).toBe("idle");
    expect(socket.closeCalls + socket.terminateCalls).toBeGreaterThan(0);
    advance(60_000);
    expect(sockets).toHaveLength(1);
  });

  it("cannot be retained, restarted, or sent after destroy", async () => {
    const socket = await retainAndOpen();
    supervisor.destroy();

    expect(supervisor.state).toBe("stopped");
    expect(supervisor.sendRaw("late")).toBe(false);
    await expect(supervisor.retain()).rejects.toMatchObject({ code: "SETTINGS" });
    expect(socket.closeCalls + socket.terminateCalls).toBeGreaterThan(0);
  });

  it("keeps exactly one reconnect timer and applies capped ±10% backoff", async () => {
    const socket = await retainAndOpen();
    socket.emit("close");
    expect(supervisor.state).toBe("reconnect_wait");
    supervisor.forceReconnect("duplicate");
    expect(timeoutDelays.at(-1)).toBe(5_000);

    advance(4_999);
    expect(sockets).toHaveLength(1);
    advance(1);
    await flush();
    expect(supervisor.state).toBe("connecting");
    expect(sockets).toHaveLength(2);

    const second = sockets[1];
    second.readyState = 1;
    second.emit("open");
    second.emit("close");
    advance(10_000);
    await flush();
    expect(sockets).toHaveLength(3);
  });

  it("coalesces error and close from the same socket into one reconnect", async () => {
    const socket = await retainAndOpen();
    socket.emit("error", new Error("network"));
    socket.emit("close");

    advance(5_000);
    await flush();
    expect(sockets).toHaveLength(2);
  });

  it("ignores a cancelled reconnect callback after a newer reconnect timer is armed", async () => {
    const localSockets: FakeSocket[] = [];
    const reconnectCallbacks: Array<() => void> = [];
    let local: ConnectionSupervisor;
    local = new ConnectionSupervisor({
      socketFactory: () => {
        const socket = new FakeSocket();
        localSockets.push(socket);
        return socket;
      },
      credentials: { getApprovalKey: vi.fn().mockResolvedValue(lease()) },
      now: () => now,
      random: () => 0.5,
      setTimeout: (callback, milliseconds) => {
        if (
          (milliseconds === 5_000 || milliseconds === 10_000) &&
          local.state === "reconnect_wait"
        ) {
          reconnectCallbacks.push(callback);
          return { reconnectCallbacks: reconnectCallbacks.length };
        }
        return setTimeout(callback, milliseconds);
      },
      clearTimeout: () => undefined,
      setInterval,
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    });

    void local.retain();
    await flush();
    localSockets[0].readyState = 1;
    localSockets[0].emit("open");
    localSockets[0].emit("close");
    local.release();

    void local.retain();
    await flush();
    localSockets[1].readyState = 1;
    localSockets[1].emit("open");
    localSockets[1].emit("close");
    expect(reconnectCallbacks).toHaveLength(2);

    reconnectCallbacks[0]();
    await flush();
    expect(localSockets).toHaveLength(2);
    expect(local.state).toBe("reconnect_wait");

    reconnectCallbacks[1]();
    await flush();
    expect(localSockets).toHaveLength(3);
    local.destroy();
  });

  it("caps reconnect backoff at 60 seconds", async () => {
    let socket = await retainAndOpen();
    for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
      socket.emit("close");
      advance(delay);
      await flush();
      socket = sockets.at(-1)!;
      socket.readyState = 1;
      socket.emit("open");
    }
    expect(sockets).toHaveLength(7);
  });

  it("ignores open, close, message and timeout events from a superseded socket", async () => {
    const first = await retainAndOpen();
    first.emit("close");
    advance(5_000);
    await flush();
    const second = sockets[1];
    const messages = vi.fn();
    supervisor.onMessage(messages);

    first.readyState = 1;
    first.emit("open");
    first.emit("message", "late");
    first.emit("close");
    expect(supervisor.state).toBe("connecting");
    expect(messages).not.toHaveBeenCalled();

    second.readyState = 1;
    second.emit("open");
    expect(supervisor.state).toBe("open");
  });

  it("reconnects after a 10 second connect timeout", async () => {
    void supervisor.retain();
    await flush();
    advance(10_000);

    expect(sockets[0].terminateCalls).toBe(1);
    expect(supervisor.state).toBe("reconnect_wait");
    advance(5_000);
    await flush();
    expect(sockets).toHaveLength(2);
  });

  it("does not reset reconnect backoff until 30 seconds of open liveness", async () => {
    const first = await retainAndOpen();
    first.emit("close");
    advance(5_000);
    await flush();
    const second = sockets[1];
    second.readyState = 1;
    second.emit("open");
    // Keep the socket live; this test isolates the 30s stable-liveness reset
    // from the separately tested idle heartbeat timeout.
    advance(14_000);
    second.emit("message", "activity");
    advance(14_000);
    second.emit("message", "activity");
    advance(1_999);
    second.emit("close");
    advance(10_000);
    await flush();
    expect(sockets).toHaveLength(3);

    const third = sockets[2];
    third.readyState = 1;
    third.emit("open");
    advance(14_000);
    third.emit("message", "activity");
    advance(14_000);
    third.emit("message", "activity");
    advance(2_000);
    third.emit("close");
    advance(5_000);
    await flush();
    expect(sockets).toHaveLength(4);
  });

  it("does not reset reconnect backoff when the 30 second check coincides with an unanswered ping", async () => {
    const first = await retainAndOpen();
    first.emit("close");
    advance(5_000);
    await flush();
    const second = sockets[1];
    second.readyState = 1;
    second.emit("open");

    advance(14_999);
    second.emit("message", "recent activity");
    advance(1);
    advance(14_999);
    advance(1);
    expect(second.pingCalls).toBe(1);

    advance(5_000);
    expect(supervisor.state).toBe("reconnect_wait");
    advance(9_999);
    await flush();
    expect(sockets).toHaveLength(2);
    advance(1);
    await flush();
    expect(sockets).toHaveLength(3);
  });

  it("resets reconnect backoff after activity confirms liveness before the 30 second check", async () => {
    const first = await retainAndOpen();
    first.emit("close");
    advance(5_000);
    await flush();
    const second = sockets[1];
    second.readyState = 1;
    second.emit("open");

    advance(14_000);
    second.emit("message", "activity");
    advance(14_000);
    second.emit("message", "activity");
    advance(2_000);
    second.emit("close");

    advance(5_000);
    await flush();
    expect(sockets).toHaveLength(3);
  });

  it("resets reconnect backoff when pong confirms liveness after the 30 second check", async () => {
    const first = await retainAndOpen();
    first.emit("close");
    advance(5_000);
    await flush();
    const second = sockets[1];
    second.readyState = 1;
    second.emit("open");

    advance(14_999);
    second.emit("message", "recent activity");
    advance(1);
    advance(14_999);
    advance(1);
    expect(second.pingCalls).toBe(1);
    second.emit("pong");
    second.emit("close");

    advance(5_000);
    await flush();
    expect(sockets).toHaveLength(3);
  });

  it("echoes JSON and text PINGPONG frames byte-for-byte", async () => {
    const socket = await retainAndOpen();
    const json = '{"header":{"tr_id":"PINGPONG"},"body":{"x":1}}';
    socket.emit("message", json);
    socket.emit("message", "PINGPONG hello");

    expect(socket.sent).toEqual([json, "PINGPONG hello"]);
  });

  it("pings after 15 seconds idle and reconnects only when no pong or activity arrives", async () => {
    const socket = await retainAndOpen();
    advance(15_000);
    expect(socket.pingCalls).toBe(1);
    socket.emit("message", "ordinary-data");
    advance(5_000);
    expect(supervisor.state).toBe("open");

    advance(10_000);
    expect(socket.pingCalls).toBe(2);
    advance(5_000);
    expect(supervisor.state).toBe("reconnect_wait");
  });

  it("updates heartbeat liveness from a native pong", async () => {
    const socket = await retainAndOpen();
    advance(15_000);
    socket.emit("pong");
    advance(5_000);

    expect(supervisor.state).toBe("open");
  });

  it("keeps an open connection on approval refresh failure and discards lower-generation results", async () => {
    const socket = await retainAndOpen();
    getApprovalKey.mockReset().mockResolvedValueOnce(lease("old", 0));

    await expect(supervisor.refreshApprovalKey()).resolves.toBe(false);
    expect(supervisor.approvalIdentity).toMatchObject({ credentialGeneration: 1 });
    expect(socket.sent).toHaveLength(0);

    getApprovalKey.mockRejectedValueOnce(new Error("offline"));
    await expect(supervisor.refreshApprovalKey()).resolves.toBe(false);
    expect(supervisor.state).toBe("open");
  });

  it("singleflights concurrent refresh calls with the in-flight initial acquisition", async () => {
    let resolveApproval!: (value: ApprovalKeyLease) => void;
    const pendingApproval = new Promise<ApprovalKeyLease>((resolve) => {
      resolveApproval = resolve;
    });
    getApprovalKey.mockReset().mockReturnValue(pendingApproval);

    void supervisor.retain();
    await flush();
    const firstRefresh = supervisor.refreshApprovalKey();
    const secondRefresh = supervisor.refreshApprovalKey();
    expect(getApprovalKey).toHaveBeenCalledTimes(1);

    resolveApproval(lease("approval-current", 2));
    await expect(Promise.all([firstRefresh, secondRefresh])).resolves.toEqual([true, true]);
    await flush();
    expect(sockets).toHaveLength(1);
    expect(supervisor.approvalIdentity).toEqual({ credentialGeneration: 2 });
  });

  it("refreshes approval keys on the 30 minute timer without exposing the key", async () => {
    await retainAndOpen();
    const refreshTimer = intervals.find(
      ({ milliseconds }) => milliseconds === 30 * 60_000,
    );
    expect(refreshTimer).toBeDefined();
    getApprovalKey.mockResolvedValueOnce(lease("approval-2", 2));

    refreshTimer!.callback();
    await flush();

    expect(getApprovalKey).toHaveBeenCalledTimes(2);
    expect(supervisor.approvalIdentity).toEqual({ credentialGeneration: 2 });
  });

  it("keeps approval keys private while sending KIS control frames", async () => {
    const socket = await retainAndOpen();
    expect(supervisor.approvalIdentity).toEqual({ credentialGeneration: 1 });
    expect(supervisor.sendKisControl({ trType: "1", trId: "TR", trKey: "KEY" })).toBe(true);

    expect(socket.sent).toEqual([JSON.stringify({
      header: {
        approval_key: "approval-1",
        custtype: "P",
        tr_type: "1",
        "content-type": "utf-8",
      },
      body: { input: { tr_id: "TR", tr_key: "KEY" } },
    })]);
  });

  it("fails a raw send safely and begins recovery", async () => {
    const socket = await retainAndOpen();
    socket.throwOnSend = true;

    expect(supervisor.sendRaw("frame")).toBe(false);
    expect(supervisor.state).toBe("reconnect_wait");
  });

  it("contains invalid random sources and throwing timers", async () => {
    const localSockets: FakeSocket[] = [];
    const timerFailure = new ConnectionSupervisor({
      socketFactory: () => {
        const socket = new FakeSocket();
        localSockets.push(socket);
        return socket;
      },
      credentials: { getApprovalKey: vi.fn().mockResolvedValue(lease()) },
      random: () => Number.NaN,
      setTimeout: () => { throw new Error("timer unavailable"); },
      clearTimeout: () => undefined,
      setInterval,
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    });

    await expect(timerFailure.retain()).rejects.toMatchObject({ code: "NETWORK" });
    expect(timerFailure.state).toBe("idle");
    expect(localSockets).toHaveLength(1);
    timerFailure.destroy();
  });

  it("isolates throwing and rejected message/state listeners", async () => {
    const stateGood = vi.fn();
    const messageGood = vi.fn();
    supervisor.onState(() => { throw new Error("observer"); });
    supervisor.onState(stateGood);
    supervisor.onMessage(() => Promise.reject(new Error("observer")));
    supervisor.onMessage(messageGood);
    const socket = await retainAndOpen();
    socket.emit("message", "data");
    await flush();

    expect(stateGood).toHaveBeenCalled();
    expect(messageGood).toHaveBeenCalledWith("data");
  });
});
