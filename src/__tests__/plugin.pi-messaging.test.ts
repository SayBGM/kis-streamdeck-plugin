import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorType } from "../types/index.js";

const {
  onDidReceiveGlobalSettings,
  onDidAppear,
  onSendToPlugin,
  registerAction,
  getGlobalSettings,
  setGlobalSettings,
  connect,
  setLevel,
  clearAccessTokenCache,
  hydrateAccessTokenFromGlobalSettings,
  onAccessTokenUpdated,
  clearCredentials,
  updateSettings,
  runConnectionTest,
} = vi.hoisted(() => ({
  onDidReceiveGlobalSettings: vi.fn(),
  onDidAppear: vi.fn(),
  onSendToPlugin: vi.fn(),
  registerAction: vi.fn(),
  getGlobalSettings: vi.fn(),
  setGlobalSettings: vi.fn(),
  connect: vi.fn(),
  setLevel: vi.fn(),
  clearAccessTokenCache: vi.fn(),
  hydrateAccessTokenFromGlobalSettings: vi.fn(),
  onAccessTokenUpdated: vi.fn(),
  clearCredentials: vi.fn(),
  updateSettings: vi.fn(),
  runConnectionTest: vi.fn(),
}));

type PropertyInspectorMock = {
  action: { id: string };
  sendToPropertyInspector: ReturnType<typeof vi.fn>;
};

type ActionMock = {
  id: string;
  manifestId: string;
  getSettings: ReturnType<typeof vi.fn>;
};

let currentPropertyInspector: PropertyInspectorMock | undefined;

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
      onDidAppear,
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
  hydrateAccessTokenFromGlobalSettings,
  onAccessTokenUpdated,
}));

vi.mock("../property-inspector/connection-test.js", () => ({
  runConnectionTest,
}));

vi.mock("../utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function createAction(
  id: string,
  manifestId: string,
  settings: Record<string, unknown>
): ActionMock {
  return {
    id,
    manifestId,
    getSettings: vi.fn().mockResolvedValue(settings),
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

describe("plugin property inspector messaging", () => {
  beforeEach(() => {
    vi.resetModules();
    onDidReceiveGlobalSettings.mockReset();
    onDidAppear.mockReset();
    onSendToPlugin.mockReset();
    registerAction.mockReset();
    getGlobalSettings.mockReset();
    setGlobalSettings.mockReset();
    connect.mockReset();
    setLevel.mockReset();
    clearAccessTokenCache.mockReset();
    hydrateAccessTokenFromGlobalSettings.mockReset();
    onAccessTokenUpdated.mockReset();
    clearCredentials.mockReset();
    updateSettings.mockReset();
    runConnectionTest.mockReset();

    currentPropertyInspector = undefined;

    connect.mockResolvedValue(undefined);
    getGlobalSettings.mockResolvedValue({});
    runConnectionTest.mockResolvedValue({
      type: "kis.connectionTestResult",
      requestId: "req-1",
      ok: true,
      message: "ok",
    });
    onDidReceiveGlobalSettings.mockImplementation((handler: unknown) => handler);
    onDidAppear.mockImplementation((handler: unknown) => handler);
    onSendToPlugin.mockImplementation((handler: unknown) => handler);
  });

  it("passes the PI payload into the connection test and replies to the matching inspector", async () => {
    await import("../plugin.js");
    await flushMicrotasks();

    const inspectSend = vi.fn();
    currentPropertyInspector = {
      action: { id: "action-1" },
      sendToPropertyInspector: inspectSend,
    };

    const handler = onSendToPlugin.mock.calls[0]?.[0] as (ev: {
      action: ActionMock;
      payload: Record<string, unknown>;
    }) => void;

    handler({
      action: createAction(
        "action-1",
        "com.kis.streamdeck.domestic-stock",
        { stockCode: "005930" }
      ),
      payload: {
        type: "kis.connectionTest",
        requestId: "req-1",
        stockCode: "005930",
      },
    });
    await flushMicrotasks();

    expect(runConnectionTest).toHaveBeenCalledWith(
      {
        type: "kis.connectionTest",
        requestId: "req-1",
        stockCode: "005930",
      },
      {},
      {
        actionManifestId: "com.kis.streamdeck.domestic-stock",
        actionSettings: { stockCode: "005930" },
      }
    );
    expect(inspectSend).toHaveBeenCalledWith({
      type: "kis.connectionTestResult",
      requestId: "req-1",
      ok: true,
      message: "ok",
    });
  });

  it("queues the response when ui.current changes and flushes it when the origin inspector returns", async () => {
    const deferred = createDeferred<{
      type: string;
      requestId: string;
      ok: boolean;
      message: string;
    }>();
    runConnectionTest.mockReturnValue(deferred.promise);

    await import("../plugin.js");
    await flushMicrotasks();

    const firstInspectorSend = vi.fn();
    const secondInspectorSend = vi.fn();

    currentPropertyInspector = {
      action: { id: "action-1" },
      sendToPropertyInspector: firstInspectorSend,
    };

    const handler = onSendToPlugin.mock.calls[0]?.[0] as (ev: {
      action: ActionMock;
      payload: Record<string, unknown>;
    }) => void;

    handler({
      action: createAction(
        "action-1",
        "com.kis.streamdeck.domestic-stock",
        { stockCode: "005930" }
      ),
      payload: {
        type: "kis.connectionTest",
        requestId: "req-routing",
      },
    });
    await flushMicrotasks();

    currentPropertyInspector = {
      action: { id: "action-2" },
      sendToPropertyInspector: secondInspectorSend,
    };

    deferred.resolve({
      type: "kis.connectionTestResult",
      requestId: "req-routing",
      ok: true,
      message: "ok",
    });
    await flushMicrotasks();

    expect(firstInspectorSend).not.toHaveBeenCalled();
    expect(secondInspectorSend).not.toHaveBeenCalled();

    currentPropertyInspector = {
      action: { id: "action-1" },
      sendToPropertyInspector: firstInspectorSend,
    };

    const didAppearHandler = onDidAppear.mock.calls[0]?.[0] as (ev: {
      action: { id: string };
    }) => void;
    didAppearHandler({ action: { id: "action-1" } });
    await flushMicrotasks();

    expect(firstInspectorSend).toHaveBeenCalledWith({
      type: "kis.connectionTestResult",
      requestId: "req-routing",
      ok: true,
      message: "ok",
    });
    expect(secondInspectorSend).not.toHaveBeenCalled();
  });

  it("queues a network error when the inspector is absent and flushes it on appear", async () => {
    runConnectionTest.mockRejectedValue(new Error("boom"));

    await import("../plugin.js");
    await flushMicrotasks();

    const inspectSend = vi.fn();
    currentPropertyInspector = undefined;

    const handler = onSendToPlugin.mock.calls[0]?.[0] as (ev: {
      action: ActionMock;
      payload: Record<string, unknown>;
    }) => void;

    handler({
      action: createAction(
        "action-1",
        "com.kis.streamdeck.overseas-stock",
        { ticker: "AAPL", exchange: "NAS" }
      ),
      payload: {
        type: "kis.connectionTest",
        requestId: "req-error",
      },
    });
    await flushMicrotasks();

    expect(inspectSend).not.toHaveBeenCalled();

    currentPropertyInspector = {
      action: { id: "action-1" },
      sendToPropertyInspector: inspectSend,
    };

    const didAppearHandler = onDidAppear.mock.calls[0]?.[0] as (ev: {
      action: { id: string };
    }) => void;
    didAppearHandler({ action: { id: "action-1" } });
    await flushMicrotasks();

    expect(inspectSend).toHaveBeenCalledWith({
      type: "kis.connectionTestResult",
      requestId: "req-error",
      ok: false,
      errorType: ErrorType.NETWORK_ERROR,
      message: "연결 테스트를 완료하지 못했습니다. 잠시 후 다시 시도하세요.",
    });
  });
});
