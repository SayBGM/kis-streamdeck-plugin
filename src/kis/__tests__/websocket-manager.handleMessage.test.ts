import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("ws", () => {
  const MockWebSocket = vi.fn().mockImplementation(() => ({
    readyState: 3,
    on: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
    terminate: vi.fn(),
    removeAllListeners: vi.fn(),
  }));
  (MockWebSocket as unknown as Record<string, number>).OPEN = 1;
  (MockWebSocket as unknown as Record<string, number>).CLOSED = 3;
  return { default: MockWebSocket };
});

vi.mock("../auth.js", () => ({
  getApprovalKey: vi.fn().mockResolvedValue("mock-approval-key"),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

type KISWebSocketManagerPrivate = {
  subscribe: (
    trId: string,
    trKey: string,
    callback: (trId: string, trKey: string, dataFields: string[]) => void,
    onSuccess?: (trId: string, trKey: string) => void,
    onConnectionState?: (trId: string, trKey: string, state: "LIVE" | "BACKUP" | "BROKEN") => void,
  ) => Promise<void>;
  handleMessage: (rawData: string) => void;
  subscriptions: Map<string, unknown>;
};

describe("KISWebSocketManager.handleMessage()", () => {
  let manager: KISWebSocketManagerPrivate;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../websocket-manager.js");
    manager = mod.kisWebSocket as unknown as KISWebSocketManagerPrivate;
    manager.subscriptions.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should dispatch data callbacks without emitting redundant LIVE state on each tick", async () => {
    const onData = vi.fn();
    const onConnectionState = vi.fn();

    await manager.subscribe("H0UNCNT0", "005930", onData, undefined, onConnectionState);
    manager.handleMessage("0|H0UNCNT0|1|005930^75000^unused");

    expect(onData).toHaveBeenCalledTimes(1);
    expect(onConnectionState).not.toHaveBeenCalled();
  });
});
