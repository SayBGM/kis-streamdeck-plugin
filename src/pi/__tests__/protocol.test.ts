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
        renderIntervalMs: 5_000,
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
        settingsRevision: 7,
        credentialsConfigured: true,
        maskedAppKey: "ABC••••XYZ",
        preferences: {
          dataMode: "automatic",
          renderIntervalMs: 2_000,
          backupPollIntervalMs: 30_000,
        },
        diagnostics: { events: [], counters: {} },
      },
    };

    expect(JSON.stringify(response)).not.toMatch(/appSecret|accessToken|approval/i);
  });
});
