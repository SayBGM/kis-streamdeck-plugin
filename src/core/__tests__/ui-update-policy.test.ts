import { describe, expect, it } from "vitest";
import {
  effectiveRenderIntervalMs,
  isEffectiveRenderIntervalMs,
  isThrottledRenderIntervalMs,
  isUiUpdateMode,
  REALTIME_RENDER_INTERVAL_MS,
  THROTTLED_RENDER_INTERVALS_MS,
} from "../ui-update-policy.js";

describe("UI update policy", () => {
  it("exposes the realtime and throttled interval contract", () => {
    expect(REALTIME_RENDER_INTERVAL_MS).toBe(50);
    expect(THROTTLED_RENDER_INTERVALS_MS).toEqual([
      500,
      600,
      700,
      800,
      900,
      1_000,
    ]);
  });

  it.each(["realtime", "throttled"])("accepts the %s UI update mode", (value) => {
    expect(isUiUpdateMode(value)).toBe(true);
  });

  it.each([undefined, null, "automatic", "", 50])(
    "rejects the invalid UI update mode %s",
    (value) => {
      expect(isUiUpdateMode(value)).toBe(false);
    },
  );

  it.each([500, 600, 700, 800, 900, 1_000])(
    "accepts the throttled interval %dms",
    (value) => {
      expect(isThrottledRenderIntervalMs(value)).toBe(true);
    },
  );

  it.each([50, 499, 550, 1_100, 2_000, 5_000, 10_000, "500"])(
    "rejects the non-throttled interval %s",
    (value) => {
      expect(isThrottledRenderIntervalMs(value)).toBe(false);
    },
  );

  it.each([50, 500, 600, 700, 800, 900, 1_000])(
    "accepts the effective interval %dms",
    (value) => {
      expect(isEffectiveRenderIntervalMs(value)).toBe(true);
    },
  );

  it.each([49, 51, 499, 550, 1_100, 2_000, "50"])(
    "rejects the invalid effective interval %s",
    (value) => {
      expect(isEffectiveRenderIntervalMs(value)).toBe(false);
    },
  );

  it("uses 50ms in realtime mode regardless of the stored throttled interval", () => {
    expect(effectiveRenderIntervalMs({
      uiUpdateMode: "realtime",
      renderIntervalMs: 1_000,
    })).toBe(50);
  });

  it("uses the stored interval in throttled mode", () => {
    expect(effectiveRenderIntervalMs({
      uiUpdateMode: "throttled",
      renderIntervalMs: 700,
    })).toBe(700);
  });
});
