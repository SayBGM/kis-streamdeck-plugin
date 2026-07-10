import { describe, expect, it, vi } from "vitest";
import type { GlobalSettings } from "../../types/index.js";
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

function fakeServices(): PluginRuntimeServices {
  const settingsRepository = {
    initialize: vi.fn(async () => ({ settings: {}, status: {} })),
    update: vi.fn(async () => ({ settings: {}, status: {} })),
  };
  return {
    settingsRepository: settingsRepository as never,
    credentialSession: {
      initialize: vi.fn(async () => ({ configured: false })),
      reconcile: vi.fn(async () => ({ configured: false })),
    } as never,
    connectionSupervisor: { destroy: vi.fn() } as never,
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
      preferences: { dataMode: "automatic", renderIntervalMs: 5_000 },
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
});
