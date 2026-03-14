import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const onDidReceiveGlobalSettings = vi.fn();
const onDidAppear = vi.fn();
const onSendToPlugin = vi.fn();
const registerAction = vi.fn();
const getGlobalSettings = vi.fn();
const setGlobalSettings = vi.fn();
const connect = vi.fn();
const setLevel = vi.fn();

const clearAccessTokenCache = vi.fn();
const hydrateAccessTokenFromGlobalSettings = vi.fn();
const onAccessTokenUpdated = vi.fn();
const clearCredentials = vi.fn();
const updateSettings = vi.fn();

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
      action: undefined,
      sendToPropertyInspector: vi.fn(),
    },
    connect,
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

vi.mock("../utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe("plugin global settings handling", () => {
  beforeEach(() => {
    vi.resetModules();
    onDidReceiveGlobalSettings.mockReset();
    onDidAppear.mockReset();
    registerAction.mockReset();
    onSendToPlugin.mockReset();
    getGlobalSettings.mockReset();
    setGlobalSettings.mockReset();
    connect.mockReset();
    setLevel.mockReset();
    clearAccessTokenCache.mockReset();
    hydrateAccessTokenFromGlobalSettings.mockReset();
    onAccessTokenUpdated.mockReset();
    clearCredentials.mockReset();
    updateSettings.mockReset();

    connect.mockResolvedValue(undefined);
    getGlobalSettings.mockResolvedValue({});
    onDidReceiveGlobalSettings.mockImplementation((handler: unknown) => handler);
    onDidAppear.mockImplementation((handler: unknown) => handler);
    onSendToPlugin.mockImplementation((handler: unknown) => handler);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("clears cached auth and websocket state when credentials are removed", async () => {
    await import("../plugin.js");
    await Promise.resolve();

    const handler = onDidReceiveGlobalSettings.mock.calls[0]?.[0] as (ev: unknown) => void;
    expect(typeof handler).toBe("function");

    clearAccessTokenCache.mockClear();
    clearCredentials.mockClear();
    updateSettings.mockClear();

    handler({ settings: {} });

    expect(clearAccessTokenCache).toHaveBeenCalledTimes(1);
    expect(clearCredentials).toHaveBeenCalledTimes(1);
    expect(updateSettings).not.toHaveBeenCalled();
  });
});
