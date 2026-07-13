import { describe, expect, it } from "vitest";
import {
  parsePiCommand,
  type PiResponse,
  validatePiCommand,
} from "../protocol.js";

describe("PI protocol", () => {
  it.each([
    { type: "settings/request", requestId: "r1" },
    { type: "credentials/save", requestId: "r2", appKey: "key", appSecret: "secret" },
    { type: "credentials/clear", requestId: "r3" },
    {
      type: "preferences/save",
      requestId: "r4",
      preferences: {
        dataMode: "automatic",
        uiUpdateMode: "realtime",
        renderIntervalMs: 700,
        backupPollIntervalMs: 30_000,
      },
    },
    { type: "diagnostics/request", requestId: "r5" },
    { type: "auth/retry", requestId: "r6" },
    { type: "ws/reconnect", requestId: "r7" },
    { type: "quote/refresh", requestId: "r8" },
  ])("accepts the $type command", (command) => {
    expect(validatePiCommand(command)).toBe(true);
    expect(parsePiCommand(command)).toEqual(command);
  });

  it.each([500, 600, 700, 800, 900, 1_000])(
    "accepts the shared throttled interval %dms",
    (renderIntervalMs) => {
      const command = {
        type: "preferences/save",
        requestId: "valid-interval",
        preferences: {
          dataMode: "automatic",
          uiUpdateMode: "throttled",
          renderIntervalMs,
          backupPollIntervalMs: 30_000,
        },
      };

      expect(validatePiCommand(command)).toBe(true);
      expect(parsePiCommand(command)).toEqual(command);
    },
  );

  it.each([499, 550, 1_100, 2_000])(
    "rejects the unsupported render interval %dms",
    (renderIntervalMs) => {
      const command = {
        type: "preferences/save",
        requestId: "invalid-interval",
        preferences: {
          dataMode: "automatic",
          uiUpdateMode: "throttled",
          renderIntervalMs,
          backupPollIntervalMs: 30_000,
        },
      };

      expect(validatePiCommand(command)).toBe(false);
      expect(parsePiCommand(command)).toBeNull();
    },
  );

  it("requires uiUpdateMode in preference payloads", () => {
    const command = {
      type: "preferences/save",
      requestId: "missing-mode",
      preferences: {
        dataMode: "automatic",
        renderIntervalMs: 700,
        backupPollIntervalMs: 30_000,
      },
    };

    expect(validatePiCommand(command)).toBe(false);
    expect(parsePiCommand(command)).toBeNull();
  });

  it("rejects an invalid uiUpdateMode", () => {
    const command = {
      type: "preferences/save",
      requestId: "invalid-mode",
      preferences: {
        dataMode: "automatic",
        uiUpdateMode: "automatic",
        renderIntervalMs: 700,
        backupPollIntervalMs: 30_000,
      },
    };

    expect(validatePiCommand(command)).toBe(false);
    expect(parsePiCommand(command)).toBeNull();
  });

  it.each([
    { type: "settings/request", requestId: "r1", token: "secret" },
    { type: "diagnostics/request", requestId: "r2", rawPayload: "secret" },
    { type: "credentials/clear", requestId: "r3", appSecret: "secret" },
    { type: "credentials/save", requestId: "r4", appKey: "key", accessToken: "secret" },
    { type: "preferences/save", requestId: "r5", preferences: { dataMode: "invalid" } },
    { type: "unknown", requestId: "r6" },
  ])("rejects unknown or excess sensitive fields", (command) => {
    expect(validatePiCommand(command)).toBe(false);
    expect(parsePiCommand(command)).toBeNull();
  });

  it("exposes only masked credential state in successful settings responses", () => {
    const response: PiResponse = {
      requestId: "r1",
      ok: true,
      snapshot: {
        schemaVersion: 2,
        snapshotEpoch: "protocol-epoch",
        snapshotSequence: 1,
        settingsRevision: 7,
        credentialsConfigured: true,
        maskedAppKey: "ABC••••XYZ",
        preferences: {
          dataMode: "automatic",
          uiUpdateMode: "realtime",
          renderIntervalMs: 1_000,
          backupPollIntervalMs: 30_000,
        },
        diagnostics: {
          auth: { configured: true, credentialGeneration: 1 },
          websocket: {
            state: "open",
            demand: 1,
            heartbeatPending: false,
            reconnectAttempts: 0,
          },
          subscriptions: {
            total: 1,
            states: { live: 1 },
            queuedControls: 0,
            rotationActive: false,
            rotationQueued: 0,
          },
          restBackup: {
            queuedRequests: 0,
            sharedRequests: 0,
            activeTransports: 0,
            cacheEntries: 0,
            startsInRateWindow: 0,
            failures: 0,
          },
          render: {
            uiUpdateMode: "realtime",
            configuredIntervalMs: 1_000,
            effectiveIntervalMs: 50,
            activeTargets: 1,
            queuedTargets: 0,
            submitted: 0,
            coalesced: 0,
            renders: 0,
            commits: 0,
            semanticSkips: 0,
            imageSkips: 0,
            supersededSkips: 0,
            staleDrops: 0,
            failures: 0,
            cacheEntries: 0,
          },
          recentErrors: { events: [], counters: {} },
        },
      },
    };

    expect(JSON.stringify(response)).not.toMatch(/appSecret|accessToken|approval/i);
  });

  it("does not execute accessor properties while rejecting commands", () => {
    let getterReads = 0;
    const command = {
      type: "settings/request",
      get requestId() {
        getterReads += 1;
        return "r1";
      },
    };

    expect(parsePiCommand(command)).toBeNull();
    expect(getterReads).toBe(0);
  });

  it("rejects objects with custom prototypes", () => {
    const command = Object.assign(
      Object.create({ token: "prototype-secret", toJSON: () => "secret" }),
      { type: "settings/request", requestId: "r1" },
    );

    expect(parsePiCommand(command)).toBeNull();
    expect(validatePiCommand(command)).toBe(false);
  });

  it("returns fresh null-prototype copies of allowlisted command fields", () => {
    const preferences = {
      dataMode: "automatic",
      uiUpdateMode: "throttled",
      renderIntervalMs: 700,
      backupPollIntervalMs: 30_000,
    };
    const command = {
      type: "preferences/save",
      requestId: "r1",
      preferences,
    };

    const parsed = parsePiCommand(command);

    expect(parsed).not.toBe(command);
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(parsed).toEqual(command);
    if (parsed?.type !== "preferences/save") {
      throw new Error("unexpected parsed command");
    }
    expect(parsed.preferences).not.toBe(preferences);
    expect(Object.getPrototypeOf(parsed.preferences)).toBeNull();
  });

  it("does not preserve values inherited from Object.prototype", () => {
    Object.defineProperty(Object.prototype, "piProtocolSecret", {
      configurable: true,
      value: "prototype-secret",
    });
    try {
      const parsed = parsePiCommand({ type: "settings/request", requestId: "r1" });

      expect(parsed).not.toBeNull();
      expect("piProtocolSecret" in (parsed as object)).toBe(false);
    } finally {
      delete (Object.prototype as { piProtocolSecret?: string }).piProtocolSecret;
    }
  });
});
