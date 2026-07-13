export type UiUpdateMode = "realtime" | "throttled";

export const REALTIME_RENDER_INTERVAL_MS = 50 as const;

export const THROTTLED_RENDER_INTERVALS_MS = [
  500,
  600,
  700,
  800,
  900,
  1_000,
] as const;

export type ThrottledRenderIntervalMs =
  (typeof THROTTLED_RENDER_INTERVALS_MS)[number];

export type EffectiveRenderIntervalMs =
  | typeof REALTIME_RENDER_INTERVAL_MS
  | ThrottledRenderIntervalMs;

export function isUiUpdateMode(value: unknown): value is UiUpdateMode {
  return value === "realtime" || value === "throttled";
}

export function isThrottledRenderIntervalMs(
  value: unknown,
): value is ThrottledRenderIntervalMs {
  return THROTTLED_RENDER_INTERVALS_MS.some((intervalMs) => intervalMs === value);
}

export function isEffectiveRenderIntervalMs(
  value: unknown,
): value is EffectiveRenderIntervalMs {
  return value === REALTIME_RENDER_INTERVAL_MS || isThrottledRenderIntervalMs(value);
}

export function effectiveRenderIntervalMs(preferences: {
  readonly uiUpdateMode: UiUpdateMode;
  readonly renderIntervalMs: ThrottledRenderIntervalMs;
}): EffectiveRenderIntervalMs {
  return preferences.uiUpdateMode === "realtime"
    ? REALTIME_RENDER_INTERVAL_MS
    : preferences.renderIntervalMs;
}
