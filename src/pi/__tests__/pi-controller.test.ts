import { describe, expect, it, vi } from "vitest";
import { DiagnosticsStore } from "../../core/diagnostics-store.js";
import { KisError } from "../../core/errors.js";
import { CredentialSession } from "../../kis/credential-session.js";
import { SettingsRepository } from "../../settings/settings-repository.js";
import type { GlobalSettingsV2 } from "../../settings/schema.js";
import type { GlobalSettings, Market } from "../../types/index.js";
import {
  PiController,
  type PiControllerOptions,
  type PiOutboundMessage,
} from "../pi-controller.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function createHarness(initial: GlobalSettings = {}) {
  let disk = structuredClone(initial);
  const getGlobalSettings = vi.fn(async () => structuredClone(disk));
  const setGlobalSettings = vi.fn(async (settings: GlobalSettingsV2) => {
    disk = structuredClone(settings);
  });
  const settingsRepository = new SettingsRepository(
    { getGlobalSettings, setGlobalSettings },
    { retryDelays: [], sleep: async () => undefined },
  );
  const credentialSession = new CredentialSession(settingsRepository, {
    fetch: vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "issued-secret-token", expires_in: 3600 }),
    })),
  });
  const sent: Array<{ contextId: string; message: PiOutboundMessage }> = [];
  const connection = {
    state: "open" as const,
    demand: 2,
    approvalIdentity: { credentialGeneration: 3 },
    getDiagnostics: vi.fn(() => ({
      state: "open" as const,
      demand: 2,
      lastActivityAt: 123,
      heartbeatPending: false,
      reconnectAttempts: 1,
    })),
    refreshApprovalKey: vi.fn(async () => true),
    forceReconnect: vi.fn(),
  };
  const subscriptions = {
    getDiagnostics: vi.fn(() => ({
      total: 4,
      states: { live: 3, parked: 1 },
      queuedControls: 1,
      rotationActive: true,
      rotationQueued: 2,
    })),
  };
  const rest = {
    getDiagnostics: vi.fn(() => ({
      queuedRequests: 2,
      sharedRequests: 3,
      activeTransports: 1,
      cacheEntries: 5,
      startsInRateWindow: 4,
    })),
  };
  const render = {
    getDiagnostics: vi.fn(() => ({
      activeTargets: 2,
      queuedTargets: 1,
      submitted: 10,
      coalesced: 4,
      renders: 6,
      commits: 5,
      semanticSkips: 1,
      imageSkips: 1,
      supersededSkips: 1,
      staleDrops: 1,
      failures: 0,
    })),
  };
  const diagnostics = new DiagnosticsStore();
  const manualRefresh = vi.fn(async (_market: Market, _actionId: string) => undefined);
  const controller = new PiController({
    settingsRepository,
    credentialSession,
    connection,
    subscriptions,
    rest,
    render,
    diagnostics,
    manualRefresh,
    sender: {
      send: vi.fn(async (contextId, message) => {
        sent.push({ contextId, message });
      }),
    },
  });
  return {
    controller,
    settingsRepository,
    credentialSession,
    connection,
    subscriptions,
    rest,
    render,
    diagnostics,
    manualRefresh,
    sent,
    get disk() { return structuredClone(disk); },
    getGlobalSettings,
    setGlobalSettings,
  };
}

function lastResponse(harness: ReturnType<typeof createHarness>) {
  return harness.sent.at(-1)?.message;
}

describe("PiController", () => {
  it("waits for v1 migration and exposes only masked credential state", async () => {
    const harness = createHarness({
      appKey: "ABCDEFGH1234",
      appSecret: "never-return-this-secret",
      accessToken: "never-return-this-token",
      accessTokenExpiry: 9_999_999,
      updateMode: "hybrid",
      throttleMs: "3000",
    });

    await harness.controller.handleCommand("ctx-1", "domestic", {
      type: "settings/request",
      requestId: "settings-1",
    });

    expect(lastResponse(harness)).toMatchObject({
      requestId: "settings-1",
      ok: true,
      snapshot: {
        schemaVersion: 2,
        credentialsConfigured: true,
        maskedAppKey: "ABC••••234",
        preferences: { dataMode: "automatic", renderIntervalMs: 5_000 },
      },
    });
    const serialized = JSON.stringify(lastResponse(harness));
    expect(serialized).not.toContain("never-return-this-secret");
    expect(serialized).not.toContain("never-return-this-token");
    expect(serialized).not.toMatch(/appSecret|accessToken|approvalKey|credentialFingerprint/i);
    expect(harness.disk).toMatchObject({ schemaVersion: 2 });
    harness.controller.destroy();
  });

  it("retains the existing secret when save omits it and acknowledges the reconciled revision", async () => {
    const harness = createHarness({ appKey: "OLD-KEY", appSecret: "kept-secret" });
    await harness.settingsRepository.initialize();
    await harness.credentialSession.reconcile();
    const revision = harness.settingsRepository.getSnapshot().settings.settingsRevision;
    const save = vi.spyOn(harness.credentialSession, "saveCredentials");

    await harness.controller.handleCommand("ctx-1", "domestic", {
      type: "credentials/save",
      requestId: "save-1",
      appKey: "NEW-KEY",
      settingsRevision: revision,
    });

    expect(harness.disk).toMatchObject({
      appKey: "NEW-KEY",
      appSecret: "kept-secret",
      credentialFingerprint: expect.any(String),
    });
    expect(save).toHaveBeenCalledWith("NEW-KEY", "kept-secret", revision);
    expect(lastResponse(harness)).toMatchObject({
      requestId: "save-1",
      ok: true,
      snapshot: { credentialsConfigured: true, maskedAppKey: "NEW••••KEY" },
    });
    expect(JSON.stringify(lastResponse(harness))).not.toContain("kept-secret");
    harness.controller.destroy();
  });

  it("applies only allowlisted preference presets and rejects a stale revision", async () => {
    const harness = createHarness();
    await harness.settingsRepository.initialize();
    const revision = harness.settingsRepository.getSnapshot().settings.settingsRevision;

    await harness.controller.handleCommand("ctx-1", "domestic", {
      type: "preferences/save",
      requestId: "prefs-1",
      settingsRevision: revision,
      preferences: {
        dataMode: "rest-only",
        renderIntervalMs: 10_000,
        backupPollIntervalMs: 60_000,
      },
    });
    expect(lastResponse(harness)).toMatchObject({
      requestId: "prefs-1",
      ok: true,
      snapshot: {
        preferences: {
          dataMode: "rest-only",
          renderIntervalMs: 10_000,
          backupPollIntervalMs: 60_000,
        },
      },
    });

    await harness.controller.handleCommand("ctx-1", "domestic", {
      type: "preferences/save",
      requestId: "prefs-stale",
      settingsRevision: revision,
      preferences: {
        dataMode: "automatic",
        renderIntervalMs: 2_000,
        backupPollIntervalMs: 15_000,
      },
    });
    expect(lastResponse(harness)).toMatchObject({
      requestId: "prefs-stale",
      ok: false,
      error: { code: "SETTINGS", retryable: true },
    });
    harness.controller.destroy();
  });

  it("returns safe error acknowledgements for invalid commands and read failures", async () => {
    const harness = createHarness();
    harness.getGlobalSettings.mockRejectedValue(new Error("disk / secret/path failed"));

    await harness.controller.handleCommand("ctx-1", "domestic", {
      type: "unknown",
      requestId: "bad-1",
      appSecret: "leak-me",
    });
    expect(lastResponse(harness)).toMatchObject({
      requestId: "invalid",
      ok: false,
      error: { code: "PROTOCOL", safeMessage: expect.any(String) },
    });

    await harness.controller.handleCommand("ctx-1", "domestic", {
      type: "settings/request",
      requestId: "read-1",
    });
    expect(lastResponse(harness)).toMatchObject({
      requestId: "read-1",
      ok: false,
      error: { code: "SETTINGS", safeMessage: expect.any(String) },
    });
    expect(JSON.stringify(harness.sent)).not.toMatch(/secret\/path|leak-me/);
    harness.controller.destroy();
  });

  it("pushes diagnostics every two seconds only while PI contexts are visible", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    try {
      await harness.controller.propertyInspectorDidAppear("ctx-1", "domestic");
      const afterAppear = harness.sent.length;
      expect(lastResponse(harness)).toMatchObject({ type: "settings/update" });

      await vi.advanceTimersByTimeAsync(2_000);
      expect(harness.sent).toHaveLength(afterAppear + 1);
      expect(lastResponse(harness)).toMatchObject({ type: "diagnostics/update" });

      await harness.controller.propertyInspectorDidAppear("ctx-1", "domestic");
      await harness.controller.propertyInspectorDidDisappear("ctx-1");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(lastResponse(harness)).toMatchObject({ type: "diagnostics/update" });

      await harness.controller.propertyInspectorDidDisappear("ctx-1");
      const afterDisappear = harness.sent.length;
      await vi.advanceTimersByTimeAsync(4_000);
      expect(harness.sent).toHaveLength(afterDisappear);
    } finally {
      harness.controller.destroy();
      vi.useRealTimers();
    }
  });

  it("fences a started credential command after its PI context disappears", async () => {
    const harness = createHarness({ appKey: "KEY", appSecret: "SECRET" });
    await harness.controller.propertyInspectorDidAppear("ctx-1", "domestic");
    harness.sent.length = 0;
    const gate = deferred<{ configured: true; credentialGeneration: number; credentialFingerprint: string }>();
    const save = vi.spyOn(harness.credentialSession, "saveCredentials")
      .mockImplementationOnce(() => gate.promise);
    const reconcile = vi.spyOn(harness.credentialSession, "reconcile");
    const revision = harness.settingsRepository.getSnapshot().settings.settingsRevision;

    const pending = harness.controller.handleCommand("ctx-1", "domestic", {
      type: "credentials/save",
      requestId: "save-pending",
      appKey: "NEW",
      appSecret: "NEW-SECRET",
      settingsRevision: revision,
    });
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    await harness.controller.propertyInspectorDidDisappear("ctx-1");
    gate.resolve({
      configured: true,
      credentialGeneration: 2,
      credentialFingerprint: "fingerprint",
    });
    await pending;

    expect(reconcile).not.toHaveBeenCalled();
    expect(harness.sent).toHaveLength(0);
    harness.controller.destroy();
  });

  it("treats an out-of-order disappear as a tombstone for later commands", async () => {
    const harness = createHarness();

    await harness.controller.propertyInspectorDidDisappear("ctx-ghost");
    await harness.controller.handleCommand("ctx-ghost", "domestic", {
      type: "ws/reconnect",
      requestId: "ws-after-disappear",
    });

    expect(harness.connection.forceReconnect).not.toHaveBeenCalled();
    expect(harness.sent).toHaveLength(0);
    harness.controller.destroy();
  });

  it("prevents queued command side effects after controller destruction", async () => {
    const harness = createHarness({ appKey: "KEY", appSecret: "SECRET" });
    await harness.controller.propertyInspectorDidAppear("ctx-1", "domestic");
    harness.sent.length = 0;
    const gate = deferred<unknown>();
    const token = vi.spyOn(harness.credentialSession, "getAccessToken")
      .mockImplementationOnce(() => gate.promise as never);
    const save = vi.spyOn(harness.credentialSession, "saveCredentials");
    const revision = harness.settingsRepository.getSnapshot().settings.settingsRevision;
    const auth = harness.controller.handleCommand("ctx-1", "domestic", {
      type: "auth/retry",
      requestId: "auth-pending",
    });
    await vi.waitFor(() => expect(token).toHaveBeenCalledOnce());
    const update = vi.spyOn(harness.settingsRepository, "update");
    const queuedSave = harness.controller.handleCommand("ctx-1", "domestic", {
      type: "credentials/save",
      requestId: "save-queued",
      appKey: "NEW",
      appSecret: "NEW-SECRET",
      settingsRevision: revision,
    });
    const queuedPreferences = harness.controller.handleCommand("ctx-1", "domestic", {
      type: "preferences/save",
      requestId: "preferences-queued",
      settingsRevision: revision,
      preferences: {
        dataMode: "rest-only",
        renderIntervalMs: 10_000,
        backupPollIntervalMs: 60_000,
      },
    });
    const queuedReconnect = harness.controller.handleCommand("ctx-1", "domestic", {
      type: "ws/reconnect",
      requestId: "ws-queued",
    });
    const queuedRefresh = harness.controller.handleCommand("ctx-1", "domestic", {
      type: "quote/refresh",
      requestId: "quote-queued",
    });
    harness.controller.destroy();
    gate.resolve({});
    await Promise.all([
      auth,
      queuedSave,
      queuedPreferences,
      queuedReconnect,
      queuedRefresh,
    ]);

    expect(harness.connection.refreshApprovalKey).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(harness.connection.forceReconnect).not.toHaveBeenCalled();
    expect(harness.manualRefresh).not.toHaveBeenCalled();
    expect(harness.sent).toHaveLength(0);
  });

  it("singleflights interval ticks and fences a pending tick on disappear", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    try {
      await harness.controller.propertyInspectorDidAppear("ctx-1", "domestic");
      harness.sent.length = 0;
      const firstGate = deferred<never>();
      const readiness = vi.spyOn(harness.settingsRepository, "whenReady")
        .mockImplementationOnce(() => firstGate.promise);

      await vi.advanceTimersByTimeAsync(4_000);
      expect(readiness).toHaveBeenCalledTimes(1);
      firstGate.resolve(undefined as never);
      await vi.waitFor(() => expect(harness.sent).toHaveLength(1));
      expect(lastResponse(harness)).toMatchObject({ type: "diagnostics/update" });

      const secondGate = deferred<never>();
      readiness.mockImplementationOnce(() => secondGate.promise);
      await vi.advanceTimersByTimeAsync(2_000);
      await harness.controller.propertyInspectorDidDisappear("ctx-1");
      const beforeResolve = harness.sent.length;
      secondGate.resolve(undefined as never);
      await Promise.resolve();
      await Promise.resolve();
      expect(harness.sent).toHaveLength(beforeResolve);
    } finally {
      harness.controller.destroy();
      vi.useRealTimers();
    }
  });

  it("sanitizes all live diagnostic sources and caps recent errors", async () => {
    const harness = createHarness({ appKey: "KEY123", appSecret: "secret" });
    for (let index = 0; index < 105; index += 1) {
      harness.diagnostics.record(new KisError({
        code: "NETWORK",
        scope: "rest",
        retryable: true,
        safeMessage: `raw ${index}`,
        metadata: { count: index, accessToken: "hidden" },
      }));
    }
    harness.connection.getDiagnostics.mockReturnValue({
      state: "open",
      demand: 2,
      lastActivityAt: 123,
      heartbeatPending: false,
      reconnectAttempts: 1,
      approvalKey: "hidden",
    } as never);

    await harness.controller.handleCommand("ctx-1", "overseas", {
      type: "diagnostics/request",
      requestId: "diagnostics-1",
    });

    const serialized = JSON.stringify(lastResponse(harness));
    expect(lastResponse(harness)).toMatchObject({
      requestId: "diagnostics-1",
      ok: true,
      snapshot: {
        diagnostics: {
          websocket: { state: "open", heartbeatPending: false },
          subscriptions: { rotationActive: true, rotationQueued: 2 },
          restBackup: { queuedRequests: 2, activeTransports: 1 },
          render: { queuedTargets: 1, cacheEntries: expect.any(Number) },
          recentErrors: { events: expect.any(Array) },
        },
      },
    });
    const message = lastResponse(harness) as { snapshot?: { diagnostics?: { recentErrors?: { events?: unknown[] } } } };
    expect(message.snapshot?.diagnostics?.recentErrors?.events).toHaveLength(100);
    expect(serialized).not.toMatch(/approvalKey|accessToken|appSecret|credentialFingerprint|raw 104|hidden/i);
    harness.controller.destroy();
  });

  it("does not execute accessor-backed diagnostic fields", async () => {
    const harness = createHarness();
    const getter = vi.fn(() => "open");
    const source = Object.defineProperty({}, "state", {
      enumerable: true,
      get: getter,
    });
    harness.connection.getDiagnostics.mockReturnValue(source as never);

    await harness.controller.handleCommand("ctx-1", "domestic", {
      type: "diagnostics/request",
      requestId: "diagnostics-accessor",
    });

    expect(getter).not.toHaveBeenCalled();
    expect(lastResponse(harness)).toMatchObject({
      ok: true,
      snapshot: { diagnostics: { websocket: { state: "open" } } },
    });
    harness.controller.destroy();
  });

  it("routes operational commands to bounded runtime capabilities", async () => {
    const harness = createHarness({ appKey: "KEY", appSecret: "SECRET" });
    await harness.controller.handleCommand("ctx-1", "domestic", {
      type: "auth/retry",
      requestId: "auth-1",
    });
    await harness.controller.handleCommand("ctx-1", "domestic", {
      type: "ws/reconnect",
      requestId: "ws-1",
    });
    await harness.controller.handleCommand("ctx-1", "overseas", {
      type: "quote/refresh",
      requestId: "quote-1",
    });

    expect(harness.connection.refreshApprovalKey).toHaveBeenCalledOnce();
    expect(harness.connection.forceReconnect).toHaveBeenCalledWith("property-inspector");
    expect(harness.manualRefresh).toHaveBeenCalledWith("overseas", "ctx-1");
    expect(harness.sent.filter(({ message }) => "ok" in message && message.ok)).toHaveLength(3);
    expect(JSON.stringify(harness.sent)).not.toContain("issued-secret-token");
    harness.controller.destroy();
  });
});
