import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorType } from "../types/index.js";

const onDidReceiveGlobalSettings = vi.fn();
const onSendToPlugin = vi.fn();
const registerAction = vi.fn();
const getGlobalSettings = vi.fn();
const setGlobalSettings = vi.fn();
const connect = vi.fn();
const setLevel = vi.fn();
const sendToPropertyInspector = vi.fn();

const clearAccessTokenCache = vi.fn();
const hydrateAccessTokenFromGlobalSettings = vi.fn();
const onAccessTokenUpdated = vi.fn();
const getApprovalKey = vi.fn();
const clearCredentials = vi.fn();
const updateSettings = vi.fn();

let currentPropertyInspector:
  | { sendToPropertyInspector: typeof sendToPropertyInspector }
  | undefined;

vi.mock("@elgato/streamdeck", () => ({
  default: {
    logger: { setLevel },
    settings: {
      onDidReceiveGlobalSettings,
      getGlobalSettings,
      setGlobalSettings,
    },
    actions: {
      registerAction,
    },
    ui: {
      onSendToPlugin,
      get current() {
        return currentPropertyInspector;
      },
    },
    connect,
  },
  LogLevel: {
    DEBUG: "DEBUG",
  },
}));

vi.mock("../kis/websocket-manager.js", () => ({
  kisWebSocket: {
    clearCredentials,
    updateSettings,
  },
}));

vi.mock("../actions/domestic-stock.js", () => ({
  DomesticStockAction: class {},
}));

vi.mock("../actions/overseas-stock.js", () => ({
  OverseasStockAction: class {},
}));

vi.mock("../kis/settings-store.js", () => ({
  kisGlobalSettings: {
    set: vi.fn(),
  },
}));

vi.mock("../kis/auth.js", () => ({
  clearAccessTokenCache,
  getApprovalKey,
  hydrateAccessTokenFromGlobalSettings,
  onAccessTokenUpdated,
}));

vi.mock("../utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("plugin property inspector messaging", () => {
  beforeEach(() => {
    vi.resetModules();
    onDidReceiveGlobalSettings.mockReset();
    onSendToPlugin.mockReset();
    registerAction.mockReset();
    getGlobalSettings.mockReset();
    setGlobalSettings.mockReset();
    connect.mockReset();
    setLevel.mockReset();
    sendToPropertyInspector.mockReset();
    clearAccessTokenCache.mockReset();
    hydrateAccessTokenFromGlobalSettings.mockReset();
    onAccessTokenUpdated.mockReset();
    getApprovalKey.mockReset();
    clearCredentials.mockReset();
    updateSettings.mockReset();

    currentPropertyInspector = { sendToPropertyInspector };

    connect.mockResolvedValue(undefined);
    getGlobalSettings.mockResolvedValue({});
    getApprovalKey.mockResolvedValue("approval-key");
    onDidReceiveGlobalSettings.mockImplementation((handler: unknown) => handler);
    onSendToPlugin.mockImplementation((handler: unknown) => handler);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("validates explicit credentials from the PI and responds with success", async () => {
    await import("../plugin.js");
    await flushMicrotasks();

    const handler = onSendToPlugin.mock.calls[0]?.[0] as (ev: unknown) => void;
    expect(typeof handler).toBe("function");

    handler({
      payload: {
        type: "kis.connectionTest",
        requestId: "req-1",
        appKey: " app-key ",
        appSecret: " secret-key ",
      },
    });
    await flushMicrotasks();

    expect(getApprovalKey).toHaveBeenCalledWith({
      appKey: "app-key",
      appSecret: "secret-key",
    });
    expect(sendToPropertyInspector).toHaveBeenCalledWith({
      type: "kis.connectionTestResult",
      requestId: "req-1",
      ok: true,
      errorType: undefined,
      message: "KIS API 자격증명을 확인했습니다.",
    });
  });

  it("falls back to saved global settings when the payload omits credentials", async () => {
    getGlobalSettings.mockResolvedValue({
      appKey: "saved-key",
      appSecret: "saved-secret",
    });

    await import("../plugin.js");
    await flushMicrotasks();

    getApprovalKey.mockClear();
    sendToPropertyInspector.mockClear();

    const handler = onSendToPlugin.mock.calls[0]?.[0] as (ev: unknown) => void;
    handler({
      payload: {
        type: "kis.connectionTest",
        requestId: "req-2",
      },
    });
    await flushMicrotasks();

    expect(getApprovalKey).toHaveBeenCalledWith({
      appKey: "saved-key",
      appSecret: "saved-secret",
    });
    expect(sendToPropertyInspector).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "kis.connectionTestResult",
        requestId: "req-2",
        ok: true,
      })
    );
  });

  it("returns a no-credential error when neither payload nor globals contain credentials", async () => {
    await import("../plugin.js");
    await flushMicrotasks();

    const handler = onSendToPlugin.mock.calls[0]?.[0] as (ev: unknown) => void;
    handler({
      payload: {
        type: "kis.connectionTest",
        requestId: "req-3",
      },
    });
    await flushMicrotasks();

    expect(getApprovalKey).not.toHaveBeenCalled();
    expect(sendToPropertyInspector).toHaveBeenCalledWith({
      type: "kis.connectionTestResult",
      requestId: "req-3",
      ok: false,
      errorType: ErrorType.NO_CREDENTIAL,
      message: "App Key와 App Secret을 입력한 뒤 다시 시도하세요.",
    });
  });

  it("maps approval key auth failures to AUTH_FAIL", async () => {
    getApprovalKey.mockRejectedValue(new Error("approval_key 발급 실패 (401): invalid"));

    await import("../plugin.js");
    await flushMicrotasks();

    const handler = onSendToPlugin.mock.calls[0]?.[0] as (ev: unknown) => void;
    handler({
      payload: {
        type: "kis.connectionTest",
        requestId: "req-4",
        appKey: "bad-key",
        appSecret: "bad-secret",
      },
    });
    await flushMicrotasks();

    expect(sendToPropertyInspector).toHaveBeenCalledWith({
      type: "kis.connectionTestResult",
      requestId: "req-4",
      ok: false,
      errorType: ErrorType.AUTH_FAIL,
      message: "App Key 또는 App Secret을 확인하세요.",
    });
  });
});
