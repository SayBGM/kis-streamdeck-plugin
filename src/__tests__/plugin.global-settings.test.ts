import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const calls: string[] = [];
  const onDidReceiveGlobalSettings = vi.fn();
  const registerAction = vi.fn((action: { kind?: string; controller?: unknown }) => {
    calls.push(`register:${action.kind}`);
  });
  const getGlobalSettings = vi.fn(async () => ({}));
  const setGlobalSettings = vi.fn(async () => undefined);
  const connect = vi.fn(async () => { calls.push("connect"); });
  const initialize = vi.fn(async () => { calls.push("initialize"); });
  const refreshGlobalSettings = vi.fn(async () => undefined);
  const domesticController = { kind: "domestic-controller" };
  const overseasController = { kind: "overseas-controller" };
  const runtime = {
    domesticController,
    overseasController,
    initialize,
    refreshGlobalSettings,
  };
  const createPluginRuntime = vi.fn((_options: {
    settingsPersistence: {
      getGlobalSettings(): Promise<Record<string, unknown>>;
      setGlobalSettings(settings: Record<string, unknown>): Promise<void>;
    };
  }) => runtime);
  const settingsApi = {
    useExperimentalMessageIdentifiers: false,
    onDidReceiveGlobalSettings,
    getGlobalSettings,
    setGlobalSettings,
  };
  return {
    calls,
    onDidReceiveGlobalSettings,
    registerAction,
    getGlobalSettings,
    setGlobalSettings,
    connect,
    initialize,
    refreshGlobalSettings,
    domesticController,
    overseasController,
    runtime,
    createPluginRuntime,
    settingsApi,
  };
});

vi.mock("@elgato/streamdeck", () => ({
  default: {
    logger: {
      setLevel: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    settings: mocks.settingsApi,
    actions: { registerAction: mocks.registerAction },
    connect: mocks.connect,
  },
}));

vi.mock("../runtime/plugin-runtime.js", () => ({
  createPluginRuntime: mocks.createPluginRuntime,
}));

vi.mock("../actions/domestic-stock.js", () => ({
  DomesticStockAction: class {
    readonly kind = "domestic";
    constructor(readonly controller: unknown) {}
  },
}));

vi.mock("../actions/overseas-stock.js", () => ({
  OverseasStockAction: class {
    readonly kind = "overseas";
    constructor(readonly controller: unknown) {}
  },
}));

describe("plugin runtime integration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.calls.length = 0;
    mocks.settingsApi.useExperimentalMessageIdentifiers = false;
    mocks.connect.mockImplementation(async () => { mocks.calls.push("connect"); });
    mocks.initialize.mockImplementation(async () => { mocks.calls.push("initialize"); });
    mocks.refreshGlobalSettings.mockResolvedValue(undefined);
    mocks.onDidReceiveGlobalSettings.mockImplementation((handler: unknown) => handler);
  });

  afterEach(() => vi.clearAllMocks());

  it("enables experimental settings identifiers before connecting", async () => {
    let enabledAtConnect = false;
    mocks.connect.mockImplementation(async () => {
      enabledAtConnect = mocks.settingsApi.useExperimentalMessageIdentifiers;
      mocks.calls.push("connect");
    });

    await import("../plugin.js");
    await vi.waitFor(() => expect(mocks.initialize).toHaveBeenCalledOnce());

    expect(enabledAtConnect).toBe(true);
  });

  it("creates one runtime and injects its controllers into registered actions", async () => {
    await import("../plugin.js");

    expect(mocks.createPluginRuntime).toHaveBeenCalledOnce();
    const persistence = mocks.createPluginRuntime.mock.calls[0]?.[0]
      ?.settingsPersistence;
    await persistence.getGlobalSettings();
    await persistence.setGlobalSettings({ schemaVersion: 2 });
    expect(mocks.getGlobalSettings).toHaveBeenCalledOnce();
    expect(mocks.setGlobalSettings).toHaveBeenCalledWith({ schemaVersion: 2 });

    const registered = mocks.registerAction.mock.calls.map(([action]) => action);
    expect(registered[0].controller).toBe(mocks.domesticController);
    expect(registered[1].controller).toBe(mocks.overseasController);
  });

  it("routes a global settings change through the runtime fresh-read transaction", async () => {
    await import("../plugin.js");
    const listener = mocks.onDidReceiveGlobalSettings.mock.calls[0]?.[0] as
      | (() => void)
      | undefined;

    listener?.();
    await vi.waitFor(() => expect(mocks.refreshGlobalSettings).toHaveBeenCalledOnce());
  });

  it("registers actions before connect and initializes only after connect resolves", async () => {
    let resolveConnected!: () => void;
    const connected = new Promise<void>((resolve) => { resolveConnected = resolve; });
    mocks.connect.mockImplementation(() => {
      mocks.calls.push("connect");
      return connected;
    });

    await import("../plugin.js");
    expect(mocks.calls).toEqual(["register:domestic", "register:overseas", "connect"]);
    expect(mocks.initialize).not.toHaveBeenCalled();

    resolveConnected();
    await vi.waitFor(() => expect(mocks.initialize).toHaveBeenCalledOnce());
    expect(mocks.calls.at(-1)).toBe("initialize");
  });

  it("does not initialize when the Stream Deck connection fails", async () => {
    mocks.connect.mockRejectedValueOnce(new Error("connect failed"));

    await import("../plugin.js");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.initialize).not.toHaveBeenCalled();
  });
});
