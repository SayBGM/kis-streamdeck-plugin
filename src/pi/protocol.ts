import type {
  DiagnosticsSnapshot,
} from "../core/diagnostics-store.js";
import type {
  KisErrorCode,
  KisErrorScope,
} from "../core/errors.js";

export type DataMode = "automatic" | "rest-only";
export type RenderIntervalMs = 2_000 | 5_000 | 10_000;
export type BackupPollIntervalMs = 15_000 | 30_000 | 60_000;

export interface PiPreferences {
  dataMode: DataMode;
  renderIntervalMs: RenderIntervalMs;
  backupPollIntervalMs: BackupPollIntervalMs;
}

export type PiCommand =
  | { type: "settings/request"; requestId: string }
  | {
      type: "credentials/save";
      requestId: string;
      appKey: string;
      appSecret?: string;
    }
  | { type: "credentials/clear"; requestId: string }
  | {
      type: "preferences/save";
      requestId: string;
      preferences: PiPreferences;
    }
  | { type: "diagnostics/request"; requestId: string }
  | { type: "auth/retry"; requestId: string }
  | { type: "ws/reconnect"; requestId: string }
  | { type: "quote/refresh"; requestId: string };

export interface SanitizedPiSnapshot {
  schemaVersion: 2;
  settingsRevision: number;
  credentialsConfigured: boolean;
  maskedAppKey?: string;
  preferences: PiPreferences;
  diagnostics: DiagnosticsSnapshot;
}

export interface PiResponseError {
  code: KisErrorCode;
  scope: KisErrorScope;
  retryable: boolean;
  safeMessage: string;
}

export type PiResponse =
  | {
      requestId: string;
      ok: true;
      snapshot?: SanitizedPiSnapshot;
    }
  | {
      requestId: string;
      ok: false;
      error: PiResponseError;
      snapshot?: SanitizedPiSnapshot;
    };

const SIMPLE_COMMAND_TYPES = new Set([
  "settings/request",
  "credentials/clear",
  "diagnostics/request",
  "auth/retry",
  "ws/reconnect",
  "quote/refresh",
]);

function readPlainDataObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return null;
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      return null;
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const data = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable || !("value" in descriptor)) {
        return null;
      }
      data[key] = descriptor.value;
    }
    return data;
  } catch {
    return null;
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function copyNullPrototype<T extends object>(
  entries: ReadonlyArray<readonly [string, unknown]>,
): T {
  const copy = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of entries) {
    copy[key] = value;
  }
  return copy as T;
}

function parsePreferences(value: unknown): PiPreferences | null {
  const data = readPlainDataObject(value);
  if (!data || !hasExactKeys(data, [
    "dataMode",
    "renderIntervalMs",
    "backupPollIntervalMs",
  ])) {
    return null;
  }
  if (!(
    (data.dataMode === "automatic" || data.dataMode === "rest-only") &&
    (data.renderIntervalMs === 2_000 ||
      data.renderIntervalMs === 5_000 ||
      data.renderIntervalMs === 10_000) &&
    (data.backupPollIntervalMs === 15_000 ||
      data.backupPollIntervalMs === 30_000 ||
      data.backupPollIntervalMs === 60_000)
  )) {
    return null;
  }
  return copyNullPrototype<PiPreferences>([
    ["dataMode", data.dataMode],
    ["renderIntervalMs", data.renderIntervalMs],
    ["backupPollIntervalMs", data.backupPollIntervalMs],
  ]);
}

function parseCommand(value: unknown): PiCommand | null {
  const data = readPlainDataObject(value);
  if (!data || !isRequestId(data.requestId) || typeof data.type !== "string") {
    return null;
  }

  if (SIMPLE_COMMAND_TYPES.has(data.type)) {
    if (!hasExactKeys(data, ["type", "requestId"])) return null;
    return copyNullPrototype<PiCommand>([
      ["type", data.type],
      ["requestId", data.requestId],
    ]);
  }

  if (data.type === "credentials/save") {
    const allowedKeys = data.appSecret === undefined
      ? ["type", "requestId", "appKey"]
      : ["type", "requestId", "appKey", "appSecret"];
    if (
      !hasExactKeys(data, allowedKeys) ||
      typeof data.appKey !== "string" ||
      data.appKey.trim().length === 0 ||
      (data.appSecret !== undefined && typeof data.appSecret !== "string")
    ) {
      return null;
    }
    return copyNullPrototype<PiCommand>([
      ["type", data.type],
      ["requestId", data.requestId],
      ["appKey", data.appKey],
      ...(data.appSecret === undefined
        ? []
        : [["appSecret", data.appSecret] as const]),
    ]);
  }

  if (data.type === "preferences/save") {
    if (!hasExactKeys(data, ["type", "requestId", "preferences"])) return null;
    const preferences = parsePreferences(data.preferences);
    if (!preferences) return null;
    return copyNullPrototype<PiCommand>([
      ["type", data.type],
      ["requestId", data.requestId],
      ["preferences", preferences],
    ]);
  }

  return null;
}

export function validatePiCommand(value: unknown): value is PiCommand {
  return parseCommand(value) !== null;
}

export function parsePiCommand(value: unknown): PiCommand | null {
  return parseCommand(value);
}
