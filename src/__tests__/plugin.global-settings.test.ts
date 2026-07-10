import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const calls: string[] = [];
  const onDidReceiveGlobalSettings = vi.fn();
  const registerAction = vi.fn((action: {
    kind?: string;
    controller?: unknown;
    diagnostics?: unknown;
  }) => {
    calls.push(`register:${action.kind}`);
  });
  const getGlobalSettings = vi.fn(async () => ({}));
  const setGlobalSettings = vi.fn(async () => undefined);
  const connect = vi.fn(async () => { calls.push("connect"); });
  const initialize = vi.fn(async () => { calls.push("initialize"); });
  const refreshGlobalSettings = vi.fn(async () => undefined);
  const domesticController = { kind: "domestic-controller" };
  const overseasController = { kind: "overseas-controller" };
  const diagnostics = { kind: "diagnostics" };
  const piController = {
    propertyInspectorDidAppear: vi.fn(async () => undefined),
    propertyInspectorDidDisappear: vi.fn(async () => undefined),
    handleCommand: vi.fn(async () => undefined),
  };
  const runtime = {
    domesticController,
    overseasController,
    diagnostics,
    piController,
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
  const ui = {
    action: undefined as { id: string } | undefined,
    onDidAppear: vi.fn(),
    onDidDisappear: vi.fn(),
    onSendToPlugin: vi.fn(),
    sendToPropertyInspector: vi.fn(async () => undefined),
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
    diagnostics,
    runtime,
    createPluginRuntime,
    settingsApi,
    ui,
    piController,
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
    ui: mocks.ui,
    connect: mocks.connect,
  },
}));

vi.mock("../runtime/plugin-runtime.js", () => ({
  createPluginRuntime: mocks.createPluginRuntime,
}));

vi.mock("../actions/domestic-stock.js", () => ({
  DomesticStockAction: class {
    readonly kind = "domestic";
    constructor(readonly controller: unknown, readonly diagnostics: unknown) {}
  },
}));

vi.mock("../actions/overseas-stock.js", () => ({
  OverseasStockAction: class {
    readonly kind = "overseas";
    constructor(readonly controller: unknown, readonly diagnostics: unknown) {}
  },
}));

describe("plugin runtime integration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.calls.length = 0;
    mocks.settingsApi.useExperimentalMessageIdentifiers = false;
    mocks.ui.action = undefined;
    mocks.connect.mockImplementation(async () => { mocks.calls.push("connect"); });
    mocks.initialize.mockImplementation(async () => { mocks.calls.push("initialize"); });
    mocks.refreshGlobalSettings.mockResolvedValue(undefined);
    mocks.onDidReceiveGlobalSettings.mockImplementation((handler: unknown) => handler);
    mocks.ui.onDidAppear.mockImplementation((handler: unknown) => handler);
    mocks.ui.onDidDisappear.mockImplementation((handler: unknown) => handler);
    mocks.ui.onSendToPlugin.mockImplementation((handler: unknown) => handler);
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
    expect(registered[0].diagnostics).toBe(mocks.diagnostics);
    expect(registered[1].diagnostics).toBe(mocks.diagnostics);
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

  it("routes SDK 2.1 Property Inspector events to the command controller", async () => {
    await import("../plugin.js");
    const appear = mocks.ui.onDidAppear.mock.calls[0]?.[0] as ((event: unknown) => void) | undefined;
    const message = mocks.ui.onSendToPlugin.mock.calls[0]?.[0] as ((event: unknown) => void) | undefined;
    const disappear = mocks.ui.onDidDisappear.mock.calls[0]?.[0] as ((event: unknown) => void) | undefined;
    const action = {
      id: "domestic-1",
      manifestId: "com.kis.streamdeck.domestic-stock",
    };

    appear?.({ action });
    message?.({ action, payload: { type: "settings/request", requestId: "r1" } });
    disappear?.({ action });

    await vi.waitFor(() => {
      expect(mocks.piController.propertyInspectorDidAppear).toHaveBeenCalledWith(
        "domestic-1",
        "domestic",
      );
      expect(mocks.piController.handleCommand).toHaveBeenCalledWith(
        "domestic-1",
        "domestic",
        { type: "settings/request", requestId: "r1" },
      );
      expect(mocks.piController.propertyInspectorDidDisappear).toHaveBeenCalledWith("domestic-1");
    });
  });

  it("sends PI responses only to the currently visible matching context", async () => {
    await import("../plugin.js");
    const options = mocks.createPluginRuntime.mock.calls[0]?.[0] as {
      piSender?: { send(contextId: string, payload: unknown): Promise<void> };
    };
    mocks.ui.action = { id: "ctx-active" };

    await options.piSender?.send("ctx-old", { ok: true });
    expect(mocks.ui.sendToPropertyInspector).not.toHaveBeenCalled();
    await options.piSender?.send("ctx-active", { ok: true });
    expect(mocks.ui.sendToPropertyInspector).toHaveBeenCalledWith({ ok: true });
  });

  it("does not initialize when the Stream Deck connection fails", async () => {
    mocks.connect.mockRejectedValueOnce(new Error("connect failed"));

    await import("../plugin.js");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.initialize).not.toHaveBeenCalled();
  });
});
