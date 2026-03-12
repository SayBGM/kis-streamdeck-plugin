import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalSettings } from "../../types/index.js";

const socketInstances: MockWebSocket[] = [];

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static CONNECTING = 0;

  readyState = MockWebSocket.CONNECTING;
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
  });
  terminate = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
  });
  removeAllListeners = vi.fn(() => {
    this.handlers.clear();
  });
  ping = vi.fn();

  constructor(_url: string) {
    socketInstances.push(this);
  }

  on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    const existing = this.handlers.get(event) ?? [];
    existing.push(handler);
    this.handlers.set(event, existing);
    return this;
  });

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }
}

vi.mock("ws", () => ({
  default: MockWebSocket,
}));

const mockGetApprovalKey = vi.fn().mockResolvedValue("mock-approval-key");
vi.mock("../auth.js", () => ({
  getApprovalKey: (...args: unknown[]) => mockGetApprovalKey(...args),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../../types/index.js", () => ({
  KIS_WS_URL: "wss://mock.example.com",
  TR_ID_DOMESTIC: "H0STCNT0",
  TR_ID_OVERSEAS: "HDFSCNT0",
}));

type KISWebSocketManagerPrivate = {
  updateSettings: (settings: GlobalSettings) => Promise<void>;
  subscribe: (
    trId: string,
    trKey: string,
    callback: (trId: string, trKey: string, dataFields: string[]) => void,
    onSuccess?: (trId: string, trKey: string) => void,
    onConnectionState?: (
      trId: string,
      trKey: string,
      state: "LIVE" | "BACKUP" | "BROKEN"
    ) => void,
  ) => Promise<void>;
  destroy: () => void;
  subscriptions: Map<string, unknown>;
};

const makeSettings = (): GlobalSettings =>
  ({
    appKey: "test-app-key",
    appSecret: "test-app-secret",
  }) as GlobalSettings;

describe("KISWebSocketManager heartbeat recovery", () => {
  let manager: KISWebSocketManagerPrivate;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    socketInstances.length = 0;
    mockGetApprovalKey.mockClear();
    mockGetApprovalKey.mockResolvedValue("mock-approval-key");

    const mod = await import("../websocket-manager.js");
    manager = mod.kisWebSocket as unknown as KISWebSocketManagerPrivate;
    manager.destroy();
    manager.subscriptions.clear();
  });

  afterEach(() => {
    manager.destroy();
    vi.restoreAllMocks();
    vi.useRealTimers();
    socketInstances.length = 0;
  });

  it("reconnects when heartbeat pong is not received after wake-like stall", async () => {
    await manager.updateSettings(makeSettings());

    const onConnectionState = vi.fn();
    const subscribePromise = manager.subscribe(
      "H0STCNT0",
      "005930",
      vi.fn(),
      undefined,
      onConnectionState,
    );

    const firstSocket = socketInstances[0];
    expect(firstSocket).toBeDefined();

    firstSocket.readyState = MockWebSocket.OPEN;
    firstSocket.emit("open");
    await subscribePromise;

    expect(firstSocket.send).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(15_000);
    expect(firstSocket.ping).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5_000);
    expect(firstSocket.terminate).toHaveBeenCalledTimes(1);
    expect(onConnectionState).toHaveBeenCalledWith("H0STCNT0", "005930", "BROKEN");

    vi.advanceTimersByTime(5_000);
    expect(socketInstances).toHaveLength(2);

    const recoveredSocket = socketInstances[1];
    recoveredSocket.readyState = MockWebSocket.OPEN;
    recoveredSocket.emit("open");

    expect(recoveredSocket.send).toHaveBeenCalledTimes(1);
  });

  it("does not send duplicate subscribe frames for the same symbol", async () => {
    await manager.updateSettings(makeSettings());

    const firstSubscribe = manager.subscribe(
      "H0STCNT0",
      "005930",
      vi.fn(),
    );

    const socket = socketInstances[0];
    expect(socket).toBeDefined();

    socket.readyState = MockWebSocket.OPEN;
    socket.emit("open");
    await firstSubscribe;

    expect(socket.send).toHaveBeenCalledTimes(1);

    socket.emit(
      "message",
      JSON.stringify({
        header: { tr_id: "H0STCNT0" },
        body: {
          msg_cd: "OPSP0000",
          msg1: "OK",
          output: { tr_key: "005930" },
        },
      }),
    );

    await manager.subscribe("H0STCNT0", "005930", vi.fn());

    expect(socket.send).toHaveBeenCalledTimes(1);
  });

  it("keeps the connection when pong arrives before timeout", async () => {
    await manager.updateSettings(makeSettings());

    const subscribePromise = manager.subscribe(
      "H0STCNT0",
      "005930",
      vi.fn(),
    );

    const socket = socketInstances[0];
    expect(socket).toBeDefined();

    socket.readyState = MockWebSocket.OPEN;
    socket.emit("open");
    await subscribePromise;

    vi.advanceTimersByTime(15_000);
    expect(socket.ping).toHaveBeenCalledTimes(1);

    socket.emit("pong");
    vi.advanceTimersByTime(6_000);

    expect(socket.terminate).not.toHaveBeenCalled();
    expect(socketInstances).toHaveLength(1);
  });
});
