import { describe, expect, it } from "vitest";
import {
  actionSettingsEqual,
  migrateDomesticStockSettings,
  migrateGlobalSettings,
  migrateOverseasStockSettings,
} from "../schema.js";

describe("migrateGlobalSettings", () => {
  it("creates v2 defaults without mutating input and preserves external fields", () => {
    const input = {
      appKey: "key",
      appSecret: "secret",
      external: { nested: ["keep"] },
    };
    const before = structuredClone(input);

    const migrated = migrateGlobalSettings(input);

    expect(migrated).toEqual({
      appKey: "key",
      appSecret: "secret",
      external: { nested: ["keep"] },
      schemaVersion: 2,
      settingsRevision: 0,
      credentialGeneration: 0,
      accessTokenVersion: 0,
      preferences: {
        dataMode: "automatic",
        renderIntervalMs: 2_000,
        backupPollIntervalMs: 30_000,
      },
    });
    expect(input).toEqual(before);
    expect(migrated.external).not.toBe(input.external);
  });

  it.each([
    [undefined, undefined, "automatic", 2_000],
    ["websocket", "5001", "automatic", 2_000],
    ["hybrid", "invalid", "automatic", 2_000],
    ["hybrid", "2000", "automatic", 2_000],
    ["hybrid", "2001", "automatic", 5_000],
    ["hybrid", "5000", "automatic", 5_000],
    ["hybrid", "5001", "automatic", 10_000],
    ["poll", "5001", "rest-only", 2_000],
  ] as const)(
    "maps legacy mode %s with throttle %s to %s/%d",
    (updateMode, throttleMs, dataMode, renderIntervalMs) => {
      const migrated = migrateGlobalSettings({ updateMode, throttleMs });

      expect(migrated.preferences.dataMode).toBe(dataMode);
      expect(migrated.preferences.renderIntervalMs).toBe(renderIntervalMs);
    },
  );

  it.each([
    [undefined, 30_000],
    ["invalid", 30_000],
    ["15", 15_000],
    ["16", 30_000],
    ["30", 30_000],
    ["31", 60_000],
  ] as const)("maps poll interval %s to %dms", (pollIntervalSec, expected) => {
    const migrated = migrateGlobalSettings({ pollIntervalSec });

    expect(migrated.preferences.backupPollIntervalMs).toBe(expected);
  });

  it("removes legacy fields and old tokens that have no token fingerprint", () => {
    const migrated = migrateGlobalSettings({
      updateMode: "hybrid",
      pollIntervalSec: "15",
      throttleMs: "5000",
      accessToken: "old-token",
      accessTokenExpiry: 123,
    });

    expect(migrated).not.toHaveProperty("updateMode");
    expect(migrated).not.toHaveProperty("pollIntervalSec");
    expect(migrated).not.toHaveProperty("throttleMs");
    expect(migrated).not.toHaveProperty("accessToken");
    expect(migrated).not.toHaveProperty("accessTokenExpiry");
  });

  it("treats an empty token fingerprint as missing", () => {
    const migrated = migrateGlobalSettings({
      accessToken: "old-token",
      accessTokenExpiry: 123,
      accessTokenFingerprint: "   ",
    });

    expect(migrated).not.toHaveProperty("accessToken");
    expect(migrated).not.toHaveProperty("accessTokenExpiry");
    expect(migrated).not.toHaveProperty("accessTokenFingerprint");
  });

  it("keeps fingerprint-bound tokens and normalizes unsafe counters", () => {
    const migrated = migrateGlobalSettings({
      credentialFingerprint: "credential-fingerprint",
      accessToken: "token",
      accessTokenExpiry: 123,
      accessTokenFingerprint: "credential-fingerprint",
      settingsRevision: Number.MAX_SAFE_INTEGER + 1,
      credentialGeneration: -1,
      accessTokenVersion: 7,
    });

    expect(migrated).toMatchObject({
      credentialFingerprint: "credential-fingerprint",
      accessToken: "token",
      accessTokenExpiry: 123,
      accessTokenFingerprint: "credential-fingerprint",
      settingsRevision: 0,
      credentialGeneration: 0,
      accessTokenVersion: 7,
    });
  });

  it("is idempotent for normalized v2 settings", () => {
    const once = migrateGlobalSettings({
      schemaVersion: 2,
      settingsRevision: 4,
      credentialGeneration: 2,
      accessTokenVersion: 3,
      preferences: {
        dataMode: "rest-only",
        renderIntervalMs: 10_000,
        backupPollIntervalMs: 60_000,
      },
      external: "keep",
    });

    expect(migrateGlobalSettings(once)).toEqual(once);
  });
});

describe("action settings migrations", () => {
  it("normalizes a domestic alphanumeric ETF and preserves current fields", () => {
    const migrated = migrateDomesticStockSettings({
      stockCode: " 0210a0 ",
      instrumentType: "etf",
      stockName: " ETF 이름 ",
      external: "keep",
    });

    expect(migrated).toEqual({
      stockCode: "0210A0",
      instrumentType: "etf",
      stockName: "ETF 이름",
      external: "keep",
      schemaVersion: 2,
    });
  });

  it("normalizes a US ticker and exchange", () => {
    expect(migrateOverseasStockSettings({
      ticker: " brk.b ",
      exchange: " nas ",
      stockName: " Berkshire ",
    })).toEqual({
      ticker: "BRK.B",
      exchange: "NAS",
      stockName: "Berkshire",
      schemaVersion: 2,
    });
  });

  it("compares action settings structurally without depending on key order", () => {
    expect(actionSettingsEqual(
      { schemaVersion: 2, ticker: "AAPL", exchange: "NAS", stockName: "Apple" },
      { stockName: "Apple", exchange: "NAS", ticker: "AAPL", schemaVersion: 2 },
    )).toBe(true);
    expect(actionSettingsEqual(
      { schemaVersion: 2, ticker: "AAPL" },
      { schemaVersion: 2, ticker: "MSFT" },
    )).toBe(false);
  });
});
