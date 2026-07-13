import { describe, expect, it, vi } from "vitest";
import type { GlobalSettings } from "../../types/index.js";
import { domesticStockAdapter } from "../../markets/market-adapter.js";
import { fingerprintCredentials } from "../../kis/credential-session.js";
import type { SocketLike } from "../../kis/connection-supervisor.js";
import type { SettingsListener } from "../../settings/settings-repository.js";
import {
  createPluginRuntime,
  PluginRuntime,
  type PluginRuntimeServices,
} from "../plugin-runtime.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

type SocketListener = (...args: unknown[]) => void;

class RuntimeFakeSocket implements SocketLike {
  readyState = 0;
  terminateCalls = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, SocketListener[]>();

  on(event: string, listener: SocketListener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  send(data: string): void { this.sent.push(data); }
  terminate(): void { this.terminateCalls += 1; this.readyState = 3; }
  ping(): void {}

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 24; index += 1) await Promise.resolve();
}

function configuredSettings(
  appKey: string,
  appSecret: string,
  credentialGeneration: number,
): GlobalSettings {
  return {
    schemaVersion: 2,
    settingsRevision: credentialGeneration,
    appKey,
    appSecret,
    credentialFingerprint: fingerprintCredentials(appKey, appSecret),
    credentialGeneration,
    accessTokenVersion: credentialGeneration,
    preferences: {
      dataMode: "automatic",
      uiUpdateMode: "throttled",
      renderIntervalMs: 1_000,
      backupPollIntervalMs: 15_000,
    },
  };
}

function fakeServices(): PluginRuntimeServices {
  const settingsRepository = {
    initialize: vi.fn(async () => ({ settings: {}, status: {} })),
    update: vi.fn(async () => ({ settings: {}, status: {} })),
    subscribe: vi.fn(() => vi.fn()),
  };
  return {
    settingsRepository: settingsRepository as never,
    credentialSession: {
      initialize: vi.fn(async () => ({ configured: false })),
      reconcile: vi.fn(async () => ({ configured: false })),
    } as never,
    connectionSupervisor: {
      applyCredentialIdentity: vi.fn(),
      destroy: vi.fn(),
    } as never,
    subscriptionSupervisor: { destroy: vi.fn() } as never,
    restCoordinator: {} as never,
    renderScheduler: { destroy: vi.fn() } as never,
    clocks: {
      domestic: { stop: vi.fn() },
      overseas: { stop: vi.fn() },
    } as never,
    domesticController: { destroy: vi.fn(async () => undefined) } as never,
    overseasController: { destroy: vi.fn(async () => undefined) } as never,
    diagnostics: { report: vi.fn(() => ({ events: [], counters: {} })) } as never,
    piController: { destroy: vi.fn() } as never,
  };
}

describe("PluginRuntime", () => {
  it("opens repository readiness before credential bootstrap and deduplicates initialize", async () => {
    const services = fakeServices();
    const order: string[] = [];
    const ready = deferred<unknown>();
    vi.mocked(services.settingsRepository.initialize).mockImplementation(async () => {
      order.push("settings:start");
      const value = await ready.promise;
      order.push("settings:ready");
      return value as never;
    });
    vi.mocked(services.credentialSession.initialize).mockImplementation(async () => {
      order.push("credentials");
      return { configured: false, credentialGeneration: 0 } as never;
    });
    const runtime = new PluginRuntime(services);

    const first = runtime.initialize();
    const second = runtime.initialize();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(order).toEqual(["settings:start"]);

    ready.resolve({ settings: {}, status: {} });
    await first;
    expect(order).toEqual(["settings:start", "settings:ready", "credentials"]);
    expect(services.connectionSupervisor.applyCredentialIdentity).not.toHaveBeenCalled();
  });

  it("does not let a late reconcile return bypass the ordered settings observer", async () => {
    const services = fakeServices();
    vi.mocked(services.credentialSession.reconcile).mockResolvedValueOnce({
      configured: true,
      credentialGeneration: 7,
      credentialFingerprint: "must-not-cross-connection-boundary",
    });
    const runtime = new PluginRuntime(services);

    await runtime.refreshGlobalSettings();

    expect(services.connectionSupervisor.applyCredentialIdentity).not.toHaveBeenCalled();
  });

  it("observes PI-style credential saves and clears without exposing the fingerprint", async () => {
    const services = fakeServices();
    let listener: SettingsListener | undefined;
    const unsubscribe = vi.fn();
    vi.mocked(services.settingsRepository.subscribe).mockImplementation((next) => {
      listener = next;
      return unsubscribe;
    });
    const runtime = new PluginRuntime(services);
    await runtime.initialize();
    vi.mocked(services.connectionSupervisor.applyCredentialIdentity).mockClear();

    const fingerprint = fingerprintCredentials("key-2", "secret-2");
    await listener?.({
      settings: {
        schemaVersion: 2,
        settingsRevision: 4,
        appKey: "key-2",
        appSecret: "secret-2",
        credentialFingerprint: fingerprint,
        credentialGeneration: 2,
        accessTokenVersion: 1,
        preferences: {
          dataMode: "automatic",
          uiUpdateMode: "throttled",
          renderIntervalMs: 1_000,
          backupPollIntervalMs: 15_000,
        },
      },
      status: { baseKnown: true, persistenceDegraded: false },
    });
    expect(services.connectionSupervisor.applyCredentialIdentity).toHaveBeenLastCalledWith({
      configured: true,
      credentialGeneration: 2,
      identityEpoch: 1,
    });

    vi.mocked(services.connectionSupervisor.applyCredentialIdentity).mockClear();
    await listener?.({
      settings: {
        schemaVersion: 2,
        settingsRevision: 5,
        appKey: "key-2",
        appSecret: "secret-2",
        credentialFingerprint: fingerprint,
        credentialGeneration: 2,
        accessToken: "token-only-update",
        accessTokenExpiry: Date.now() + 60_000,
        accessTokenFingerprint: fingerprint,
        accessTokenVersion: 2,
        preferences: {
          dataMode: "automatic",
          uiUpdateMode: "throttled",
          renderIntervalMs: 1_000,
          backupPollIntervalMs: 15_000,
        },
      },
      status: { baseKnown: true, persistenceDegraded: false },
    });
    expect(services.connectionSupervisor.applyCredentialIdentity).not.toHaveBeenCalled();

    const replacementFingerprint = fingerprintCredentials("key-replaced", "secret-replaced");
    await listener?.({
      settings: {
        schemaVersion: 2,
        settingsRevision: 6,
        appKey: "key-replaced",
        appSecret: "secret-replaced",
        credentialFingerprint: replacementFingerprint,
        credentialGeneration: 2,
        accessTokenVersion: 3,
        preferences: {
          dataMode: "automatic",
          uiUpdateMode: "throttled",
          renderIntervalMs: 1_000,
          backupPollIntervalMs: 15_000,
        },
      },
      status: { baseKnown: true, persistenceDegraded: false },
    });
    expect(services.connectionSupervisor.applyCredentialIdentity).toHaveBeenLastCalledWith({
      configured: true,
      credentialGeneration: 2,
      identityEpoch: 2,
    });

    vi.mocked(services.connectionSupervisor.applyCredentialIdentity).mockClear();
    await listener?.({
      settings: {
        schemaVersion: 2,
        settingsRevision: 7,
        credentialGeneration: 3,
        accessTokenVersion: 2,
        preferences: {
          dataMode: "automatic",
          uiUpdateMode: "throttled",
          renderIntervalMs: 1_000,
          backupPollIntervalMs: 15_000,
        },
      },
      status: { baseKnown: true, persistenceDegraded: false },
    });
    expect(services.connectionSupervisor.applyCredentialIdentity).toHaveBeenLastCalledWith({
      configured: false,
      credentialGeneration: 3,
      identityEpoch: 3,
    });
    expect(JSON.stringify(vi.mocked(services.connectionSupervisor.applyCredentialIdentity).mock.calls))
      .not.toContain(fingerprint);

    await runtime.destroy();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("does not invoke credential accessors while deriving the internal identity tuple", async () => {
    const services = fakeServices();
    let listener: SettingsListener | undefined;
    vi.mocked(services.settingsRepository.subscribe).mockImplementation((next) => {
      listener = next;
      return vi.fn();
    });
    const runtime = new PluginRuntime(services);
    await runtime.initialize();
    const appKeyGetter = vi.fn(() => "must-not-be-read");
    const unsafeSettings = {};
    Object.defineProperty(unsafeSettings, "appKey", {
      enumerable: true,
      get: appKeyGetter,
    });

    await listener?.({
      settings: unsafeSettings,
      status: { baseKnown: true, persistenceDegraded: false },
    } as never);

    expect(appKeyGetter).not.toHaveBeenCalled();
    expect(services.connectionSupervisor.applyCredentialIdentity).toHaveBeenLastCalledWith({
      configured: false,
      credentialGeneration: 0,
      identityEpoch: 1,
    });
    await runtime.destroy();
  });

  it("fences the connection immediately for PI credential save and clear commands", async () => {
    let current: GlobalSettings = {};
    const runtime = createPluginRuntime({
      settingsPersistence: {
        getGlobalSettings: vi.fn(async () => current),
        setGlobalSettings: vi.fn(async (settings) => { current = settings; }),
      },
    });
    await runtime.initialize();
    const applyIdentity = vi.spyOn(
      runtime.services.connectionSupervisor,
      "applyCredentialIdentity",
    );
    applyIdentity.mockClear();

    await runtime.piController.handleCommand("pi", "domestic", {
      type: "credentials/save",
      requestId: "save-1",
      settingsRevision: current.settingsRevision ?? 0,
      appKey: "new-key",
      appSecret: "new-secret",
    });
    expect(applyIdentity).toHaveBeenLastCalledWith({
      configured: true,
      credentialGeneration: current.credentialGeneration,
      identityEpoch: expect.any(Number),
    });

    applyIdentity.mockClear();
    await runtime.piController.handleCommand("pi", "domestic", {
      type: "credentials/clear",
      requestId: "clear-1",
      settingsRevision: current.settingsRevision ?? 0,
    });
    expect(applyIdentity).toHaveBeenLastCalledWith({
      configured: false,
      credentialGeneration: current.credentialGeneration,
      identityEpoch: expect.any(Number),
    });
    await runtime.destroy();
  });

  it("replaces an open high-generation socket after an external legacy credential reset", async () => {
    let current: GlobalSettings = configuredSettings("old-key", "old-secret", 10);
    const sockets: RuntimeFakeSocket[] = [];
    let approvalCalls = 0;
    const runtime = createPluginRuntime({
      settingsPersistence: {
        getGlobalSettings: vi.fn(async () => current),
        setGlobalSettings: vi.fn(async (settings) => { current = settings; }),
      },
      credentialSessionOptions: {
        fetch: vi.fn(async () => ({
          ok: true,
          status: 200,
          json: async () => ({ approval_key: ++approvalCalls === 1 ? "old-approval" : "new-approval" }),
        })),
      },
      connectionSupervisorOptions: {
        socketFactory: () => {
          const socket = new RuntimeFakeSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    await runtime.initialize();
    void runtime.services.connectionSupervisor.retain();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(runtime.services.connectionSupervisor.demand).toBe(1);
    expect(runtime.services.connectionSupervisor.state).toBe("connecting");
    expect(approvalCalls).toBe(1);
    sockets[0].readyState = 1;
    sockets[0].emit("open");
    expect(runtime.services.connectionSupervisor.state).toBe("open");

    current = { appKey: "legacy-new-key", appSecret: "legacy-new-secret" };
    await runtime.refreshGlobalSettings();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));

    expect(sockets[0].terminateCalls).toBe(1);
    expect(sockets).toHaveLength(2);
    expect(runtime.services.connectionSupervisor.approvalIdentity)
      .toEqual({ credentialGeneration: 1 });
    expect(current).toMatchObject({
      appKey: "legacy-new-key",
      credentialGeneration: 1,
      credentialFingerprint: fingerprintCredentials("legacy-new-key", "legacy-new-secret"),
    });
    await runtime.destroy();
  });

  it("closes an open high-generation socket without reconnecting after an external legacy clear", async () => {
    let current: GlobalSettings = configuredSettings("old-key", "old-secret", 10);
    const sockets: RuntimeFakeSocket[] = [];
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ approval_key: "old-approval" }),
    }));
    const runtime = createPluginRuntime({
      settingsPersistence: {
        getGlobalSettings: vi.fn(async () => current),
        setGlobalSettings: vi.fn(async (settings) => { current = settings; }),
      },
      credentialSessionOptions: { fetch },
      connectionSupervisorOptions: {
        socketFactory: () => {
          const socket = new RuntimeFakeSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    await runtime.initialize();
    void runtime.services.connectionSupervisor.retain();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].readyState = 1;
    sockets[0].emit("open");

    current = {};
    await runtime.refreshGlobalSettings();
    runtime.services.connectionSupervisor.forceReconnect("must-stay-cleared");
    await flush();

    expect(sockets[0].terminateCalls).toBe(1);
    expect(sockets).toHaveLength(1);
    expect(fetch).toHaveBeenCalledOnce();
    expect(runtime.services.connectionSupervisor.state).toBe("idle");
    expect(runtime.services.connectionSupervisor.demand).toBe(1);
    await runtime.destroy();
  });

  it("serializes a global settings event through a fresh repository read", async () => {
    const services = fakeServices();
    const runtime = new PluginRuntime(services);

    await runtime.refreshGlobalSettings();

    expect(services.settingsRepository.update).toHaveBeenCalledOnce();
    const updater = vi.mocked(services.settingsRepository.update).mock.calls[0]?.[0];
    const marker = { keep: true };
    updater?.(marker as never);
    expect(marker).toEqual({ keep: true });
    expect(services.credentialSession.reconcile).toHaveBeenCalledOnce();
  });

  it("allows startup to retry after a transient credential bootstrap failure", async () => {
    const services = fakeServices();
    vi.mocked(services.credentialSession.initialize)
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce({ configured: false, credentialGeneration: 0 } as never);
    const runtime = new PluginRuntime(services);

    await expect(runtime.initialize()).rejects.toThrow("temporary");
    await expect(runtime.initialize()).resolves.toBeUndefined();

    expect(services.settingsRepository.initialize).toHaveBeenCalledTimes(2);
    expect(services.credentialSession.initialize).toHaveBeenCalledTimes(2);
  });

  it("recovers a failed startup through a later settings refresh reconciliation", async () => {
    const services = fakeServices();
    vi.mocked(services.credentialSession.initialize)
      .mockRejectedValueOnce(new Error("temporary"));
    const runtime = new PluginRuntime(services);

    await expect(runtime.initialize()).rejects.toThrow("temporary");
    await expect(runtime.refreshGlobalSettings()).resolves.toBeUndefined();

    expect(services.settingsRepository.update).toHaveBeenCalledOnce();
    expect(services.credentialSession.reconcile).toHaveBeenCalledOnce();
  });

  it("composes one shared connection, subscription, REST and render service for both controllers", async () => {
    let current: GlobalSettings = {};
    const runtime = createPluginRuntime({
      settingsPersistence: {
        getGlobalSettings: vi.fn(async () => current),
        setGlobalSettings: vi.fn(async (settings) => { current = settings; }),
      },
    });

    expect(runtime.services.domesticController).not.toBe(runtime.services.overseasController);
    expect(runtime.domesticController).toBe(runtime.services.domesticController);
    expect(runtime.overseasController).toBe(runtime.services.overseasController);
    expect(runtime.diagnostics).toBe(runtime.services.diagnostics);
    expect(runtime.services.connectionSupervisor).toBeDefined();
    expect(runtime.services.subscriptionSupervisor).toBeDefined();
    expect(runtime.services.restCoordinator).toBeDefined();
    expect(runtime.services.renderScheduler).toBeDefined();
    expect(runtime.services.piController).toBeDefined();
    expect(runtime.services.clocks.domestic).not.toBe(runtime.services.clocks.overseas);

    await runtime.destroy();
  });

  it("migrates legacy settings and discards an unfingerprinted persisted token on bootstrap", async () => {
    let current: GlobalSettings = {
      appKey: " app-key ",
      appSecret: " app-secret ",
      accessToken: "legacy-token",
      accessTokenExpiry: Date.now() + 60_000_000,
      updateMode: "hybrid",
      throttleMs: "3000",
    };
    const setGlobalSettings = vi.fn(async (settings) => { current = settings; });
    const runtime = createPluginRuntime({
      settingsPersistence: {
        getGlobalSettings: vi.fn(async () => current),
        setGlobalSettings,
      },
    });

    await Promise.all([
      runtime.initialize(),
      runtime.refreshGlobalSettings(),
    ]);

    expect(current).toMatchObject({
      schemaVersion: 2,
      appKey: "app-key",
      appSecret: "app-secret",
      credentialGeneration: 1,
      preferences: {
        dataMode: "automatic",
        uiUpdateMode: "throttled",
        renderIntervalMs: 1_000,
      },
    });
    expect(current.accessToken).toBeUndefined();
    expect(current.accessTokenExpiry).toBeUndefined();
    expect(setGlobalSettings).toHaveBeenCalled();
    const writesAfterBootstrap = setGlobalSettings.mock.calls.length;
    await runtime.refreshGlobalSettings();
    expect(setGlobalSettings).toHaveBeenCalledTimes(writesAfterBootstrap);
    await runtime.destroy();
  });

  it("reconciles externally saved credentials and can issue approval without restart", async () => {
    let current: GlobalSettings = {};
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ approval_key: "approval-after-refresh" }),
    }));
    const runtime = createPluginRuntime({
      settingsPersistence: {
        getGlobalSettings: vi.fn(async () => current),
        setGlobalSettings: vi.fn(async (settings) => { current = settings; }),
      },
      credentialSessionOptions: { fetch },
    });
    await runtime.initialize();
    current = {
      ...current,
      appKey: " external-key ",
      appSecret: " external-secret ",
    };

    await runtime.refreshGlobalSettings();
    const writesAfterReconcile = current.settingsRevision;
    const approval = await runtime.services.credentialSession.getApprovalKey();

    expect(current).toMatchObject({
      appKey: "external-key",
      appSecret: "external-secret",
      credentialGeneration: 1,
      credentialFingerprint: expect.any(String),
    });
    expect(approval).toMatchObject({
      approvalKey: "approval-after-refresh",
      credentialGeneration: 1,
    });
    expect(current.settingsRevision).toBe(writesAfterReconcile);
    await runtime.refreshGlobalSettings();
    expect(current.settingsRevision).toBe(writesAfterReconcile);
    await runtime.destroy();
  });

  it("wires shared auth diagnostics into sanitized PI snapshots", async () => {
    let current: GlobalSettings = { appKey: "key", appSecret: "secret" };
    const messages: unknown[] = [];
    const runtime = createPluginRuntime({
      settingsPersistence: {
        getGlobalSettings: vi.fn(async () => current),
        setGlobalSettings: vi.fn(async (settings) => { current = settings; }),
      },
      credentialSessionOptions: {
        fetch: vi.fn(async () => ({
          ok: false,
          status: 403,
          json: async () => ({ error_description: "raw-secret-response" }),
        })),
      },
      piSender: {
        send: vi.fn(async (_contextId, message) => { messages.push(message); }),
      },
    });
    await runtime.initialize();

    await runtime.services.credentialSession.getAccessToken().catch(() => undefined);
    await runtime.piController.handleCommand("ctx-1", "domestic", {
      type: "settings/request",
      requestId: "settings-1",
    });

    expect(messages.at(-1)).toMatchObject({
      ok: true,
      snapshot: {
        diagnostics: {
          recentErrors: {
            counters: { authFailures: 1 },
            events: [expect.objectContaining({ code: "AUTH_REJECTED", scope: "auth" })],
          },
        },
      },
    });
    expect(JSON.stringify(messages)).not.toContain("raw-secret-response");
    await runtime.destroy();
  });

  it("wires shared REST diagnostics into sanitized PI snapshots", async () => {
    let current: GlobalSettings = { appKey: "key", appSecret: "secret" };
    const messages: unknown[] = [];
    const runtime = createPluginRuntime({
      settingsPersistence: {
        getGlobalSettings: vi.fn(async () => current),
        setGlobalSettings: vi.fn(async (settings) => { current = settings; }),
      },
      credentialSessionOptions: {
        fetch: vi.fn(async () => ({
          ok: true,
          status: 200,
          json: async () => ({ access_token: "issued-token", expires_in: 3600 }),
        })),
        restFetch: vi.fn(async () => ({
          ok: false,
          status: 500,
          json: async () => ({ raw: "raw-secret-response" }),
        })),
      },
      piSender: {
        send: vi.fn(async (_contextId, message) => { messages.push(message); }),
      },
    });
    await runtime.initialize();
    const instrument = domesticStockAdapter.toInstrument({ stockCode: "005930" });

    await runtime.services.restCoordinator.requestQuote({
      adapter: domesticStockAdapter,
      instrument,
      marketSnapshot: runtime.services.clocks.domestic.snapshot(),
      priority: "manual",
    }).catch(() => undefined);
    await runtime.piController.handleCommand("ctx-1", "domestic", {
      type: "settings/request",
      requestId: "settings-1",
    });

    expect(messages.at(-1)).toMatchObject({
      snapshot: {
        diagnostics: {
          restBackup: { failures: 1 },
          recentErrors: {
            counters: { restFailures: 1 },
            events: [expect.objectContaining({ code: "NETWORK", scope: "rest" })],
          },
        },
      },
    });
    expect(JSON.stringify(messages)).not.toContain("raw-secret-response");
    await runtime.destroy();
  });

  it("destroys shared services once and remains idempotent", async () => {
    const services = fakeServices();
    const runtime = new PluginRuntime(services);

    await runtime.destroy();
    await runtime.destroy();

    expect(services.domesticController.destroy).toHaveBeenCalledOnce();
    expect(services.overseasController.destroy).toHaveBeenCalledOnce();
    expect(services.subscriptionSupervisor.destroy).toHaveBeenCalledOnce();
    expect(services.connectionSupervisor.destroy).toHaveBeenCalledOnce();
    expect(services.renderScheduler.destroy).toHaveBeenCalledOnce();
    expect(services.piController.destroy).toHaveBeenCalledOnce();
  });

  it("continues best-effort shared cleanup when one controller rejects", async () => {
    const services = fakeServices();
    vi.mocked(services.domesticController.destroy).mockRejectedValueOnce(new Error("late"));
    const runtime = new PluginRuntime(services);

    await expect(runtime.destroy()).resolves.toBeUndefined();

    expect(services.overseasController.destroy).toHaveBeenCalledOnce();
    expect(services.subscriptionSupervisor.destroy).toHaveBeenCalledOnce();
    expect(services.connectionSupervisor.destroy).toHaveBeenCalledOnce();
    expect(services.renderScheduler.destroy).toHaveBeenCalledOnce();
  });

  it("performs shared synchronous cleanup before awaiting readiness-bound action teardown", async () => {
    const services = fakeServices();
    const gate = deferred<void>();
    const order: string[] = [];
    vi.mocked(services.domesticController.destroy).mockImplementation(async () => {
      order.push("action:start");
      await gate.promise;
      order.push("action:end");
    });
    vi.mocked(services.piController.destroy).mockImplementation(() => { order.push("pi"); });
    vi.mocked(services.subscriptionSupervisor.destroy).mockImplementation(() => { order.push("subscriptions"); });
    vi.mocked(services.connectionSupervisor.destroy).mockImplementation(() => { order.push("connection"); });
    vi.mocked(services.renderScheduler.destroy).mockImplementation(() => { order.push("render"); });
    const runtime = new PluginRuntime(services);

    const pending = runtime.destroy();
    await Promise.resolve();

    expect(order.slice(0, 4)).toEqual(["pi", "subscriptions", "connection", "render"]);
    expect(services.clocks.domestic.stop).toHaveBeenCalledOnce();
    expect(services.clocks.overseas.stop).toHaveBeenCalledOnce();
    expect(order).toContain("action:start");
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    gate.resolve();
    await pending;
    expect(order.at(-1)).toBe("action:end");
    await runtime.destroy();
    expect(services.piController.destroy).toHaveBeenCalledOnce();
  });
});
