import { describe, expect, it } from "vitest";
import { KisError } from "../../core/errors.js";
import {
  actionSettingsEqual,
  migrateDomesticStockSettings,
  migrateGlobalSettings,
  migrateOverseasStockSettings,
} from "../schema.js";

function expectSettingsFailure(run: () => unknown): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(KisError);
  expect(caught).toMatchObject({
    code: "SETTINGS",
    scope: "settings",
    retryable: false,
  });
}

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
    ["hybrid", "2001oops", "automatic", 2_000],
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
    ["31oops", 30_000],
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

  it.each([
    ["missing credential fingerprint", undefined, "token-fingerprint"],
    ["mismatched fingerprints", "credential-fingerprint", "token-fingerprint"],
  ])("removes tokens with %s", (_label, credentialFingerprint, accessTokenFingerprint) => {
    const migrated = migrateGlobalSettings({
      credentialFingerprint,
      accessToken: "token",
      accessTokenExpiry: 123,
      accessTokenFingerprint,
      accessTokenVersion: 7,
    });

    expect(migrated).not.toHaveProperty("accessToken");
    expect(migrated).not.toHaveProperty("accessTokenExpiry");
    expect(migrated).not.toHaveProperty("accessTokenFingerprint");
    expect(migrated.accessTokenVersion).toBe(0);
  });

  it("is idempotent for normalized v2 settings", () => {
    const extension = { nested: ["keep"] };
    const once = migrateGlobalSettings({
      schemaVersion: 2,
      settingsRevision: 4,
      credentialGeneration: 2,
      accessTokenVersion: 3,
      preferences: {
        dataMode: "rest-only",
        renderIntervalMs: 10_000,
        backupPollIntervalMs: 60_000,
        extension,
      },
      external: "keep",
    });

    expect(once.preferences.extension).toEqual({ nested: ["keep"] });
    expect(once.preferences.extension).not.toBe(extension);
    expect(once.accessTokenVersion).toBe(0);
    expect(migrateGlobalSettings(once)).toEqual(once);
  });

  it("preserves preference extensions while overwriting known fields canonically", () => {
    const preferences = {
      dataMode: "invalid",
      renderIntervalMs: 1234,
      backupPollIntervalMs: 1234,
      extension: { enabled: true },
    };

    const migrated = migrateGlobalSettings({
      updateMode: "hybrid",
      throttleMs: "5001",
      pollIntervalSec: "31",
      preferences,
    });

    expect(migrated.preferences).toEqual({
      dataMode: "automatic",
      renderIntervalMs: 10_000,
      backupPollIntervalMs: 60_000,
      extension: { enabled: true },
    });
    expect(migrated.preferences).not.toBe(preferences);
    expect(migrated.preferences.extension).not.toBe(preferences.extension);
    expect(preferences).toEqual({
      dataMode: "invalid",
      renderIntervalMs: 1234,
      backupPollIntervalMs: 1234,
      extension: { enabled: true },
    });
  });

  it("does not execute accessors while rejecting unsafe input", () => {
    let getterReads = 0;
    const input = {};
    Object.defineProperty(input, "appKey", {
      enumerable: true,
      get() {
        getterReads += 1;
        return "secret";
      },
    });

    expectSettingsFailure(() => migrateGlobalSettings(input));

    expect(getterReads).toBe(0);
  });

  it("rejects objects with custom prototypes", () => {
    const input = Object.assign(
      Object.create({ inheritedSecret: "secret" }),
      { external: "value" },
    );

    expectSettingsFailure(() => migrateGlobalSettings(input));
  });

  it("rejects symbol and non-enumerable properties", () => {
    const withSymbol = { external: "value", [Symbol("secret")]: "secret" };
    const withNonEnumerable = { external: "value" };
    Object.defineProperty(withNonEnumerable, "secret", {
      enumerable: false,
      value: "secret",
    });

    expectSettingsFailure(() => migrateGlobalSettings(withSymbol));
    expectSettingsFailure(() => migrateGlobalSettings(withNonEnumerable));
  });

  it("preserves __proto__ as an own key on null-prototype clones", () => {
    const input = JSON.parse(
      '{"__proto__":{"safe":"value"},"external":[{"nested":true}]}',
    ) as Record<string, unknown>;

    const migrated = migrateGlobalSettings(input);

    expect(Object.getPrototypeOf(migrated)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(migrated, "__proto__")).toBe(true);
    expect(migrated.__proto__).toEqual({ safe: "value" });
    expect(Object.getPrototypeOf(migrated.__proto__ as object)).toBeNull();
    expect(migrated.external).toEqual([{ nested: true }]);
    expect(migrated.external).not.toBe(input.external);
  });

  it("fails safely for cyclic input", () => {
    const cyclic: Record<string, unknown> = { external: "value" };
    cyclic.self = cyclic;

    expectSettingsFailure(() => migrateGlobalSettings(cyclic));
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

  it("returns false without overflowing for cyclic settings", () => {
    const left: Record<string, unknown> = { ticker: "AAPL" };
    const right: Record<string, unknown> = { ticker: "AAPL" };
    left.self = left;
    right.self = right;

    expect(actionSettingsEqual(left, right)).toBe(false);
    expect(actionSettingsEqual(left, left)).toBe(false);
  });
});
