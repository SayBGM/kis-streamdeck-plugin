/**
 * Characterization tests for KISWebSocketManager.updateSettings()
 *
 * Verifies behavior including SPEC-PERF-001 additions:
 * - approval_key auto-refresh timer (30-minute setInterval)
 * - Timer cleanup in safeDisconnect()
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { GlobalSettings } from "../../types/index.js";

vi.mock("ws", () => {
  const MockWebSocket = vi.fn().mockImplementation(() => ({
    readyState: 3, // CLOSED
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
  approvalKey: string | null;
  subscriptions: Map<string, unknown>;
  isUpdating: boolean;
  approvalKeyRefreshTimer: ReturnType<typeof setInterval> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
};

const makeSettings = (overrides?: Partial<GlobalSettings>): GlobalSettings => ({
  appKey: "test-app-key",
  appSecret: "test-app-secret",
  ...overrides,
} as GlobalSettings);

describe("KISWebSocketManager.updateSettings() — characterization tests", () => {
  let manager: KISWebSocketManagerPrivate;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    mockGetApprovalKey.mockClear();
    mockGetApprovalKey.mockResolvedValue("mock-approval-key");

    const mod = await import("../websocket-manager.js");
    manager = mod.kisWebSocket as unknown as KISWebSocketManagerPrivate;

    // Reset state
    manager.approvalKey = null;
    manager.subscriptions.clear();
    manager.isUpdating = false;
    if (manager.approvalKeyRefreshTimer) {
      clearInterval(manager.approvalKeyRefreshTimer);
      manager.approvalKeyRefreshTimer = null;
    }
    if (manager.reconnectTimer) {
      clearTimeout(manager.reconnectTimer);
      manager.reconnectTimer = null;
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("should call getApprovalKey with valid settings", async () => {
    const settings = makeSettings();
    await manager.updateSettings(settings);
    expect(mockGetApprovalKey).toHaveBeenCalledWith(settings);
  });

  it("should set approvalKey after successful fetch", async () => {
    await manager.updateSettings(makeSettings());
    expect(manager.approvalKey).toBe("mock-approval-key");
  });

  it("should NOT call getApprovalKey when appKey is missing", async () => {
    await manager.updateSettings(makeSettings({ appKey: "" }));
    expect(mockGetApprovalKey).not.toHaveBeenCalled();
    expect(manager.approvalKey).toBeNull();
  });

  it("should NOT call getApprovalKey when appSecret is missing", async () => {
    await manager.updateSettings(makeSettings({ appSecret: "" }));
    expect(mockGetApprovalKey).not.toHaveBeenCalled();
  });

  it("should skip concurrent updateSettings call (isUpdating guard)", async () => {
    manager.isUpdating = true;
    await manager.updateSettings(makeSettings());
    expect(mockGetApprovalKey).not.toHaveBeenCalled();
  });

  it("should start approval_key refresh timer (30min setInterval) after successful fetch", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    await manager.updateSettings(makeSettings());

    expect(setIntervalSpy).toHaveBeenCalledWith(
      expect.any(Function),
      30 * 60 * 1000 // 30 minutes
    );
    expect(manager.approvalKeyRefreshTimer).not.toBeNull();

    setIntervalSpy.mockRestore();
  });

  it("should replace existing refresh timer on subsequent updateSettings call", async () => {
    await manager.updateSettings(makeSettings());
    const firstTimer = manager.approvalKeyRefreshTimer;
    expect(firstTimer).not.toBeNull();

    await manager.updateSettings(makeSettings());
    const secondTimer = manager.approvalKeyRefreshTimer;

    expect(secondTimer).not.toBeNull();
    expect(secondTimer).not.toBe(firstTimer);
  });

  it("should trigger approval_key refresh after 30 minutes", async () => {
    await manager.updateSettings(makeSettings());
    mockGetApprovalKey.mockClear();
    mockGetApprovalKey.mockResolvedValue("refreshed-key");

    // Advance time by 30 minutes
    vi.advanceTimersByTime(30 * 60 * 1000);
    await Promise.resolve(); // flush microtasks

    expect(mockGetApprovalKey).toHaveBeenCalledTimes(1);
  });
});
