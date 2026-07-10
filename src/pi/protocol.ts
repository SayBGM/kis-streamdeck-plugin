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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPreferences(value: unknown): value is PiPreferences {
  if (!isRecord(value) || !hasExactKeys(value, [
    "dataMode",
    "renderIntervalMs",
    "backupPollIntervalMs",
  ])) {
    return false;
  }
  return (
    (value.dataMode === "automatic" || value.dataMode === "rest-only") &&
    (value.renderIntervalMs === 2_000 ||
      value.renderIntervalMs === 5_000 ||
      value.renderIntervalMs === 10_000) &&
    (value.backupPollIntervalMs === 15_000 ||
      value.backupPollIntervalMs === 30_000 ||
      value.backupPollIntervalMs === 60_000)
  );
}

export function validatePiCommand(value: unknown): value is PiCommand {
  if (!isRecord(value) || !isRequestId(value.requestId) || typeof value.type !== "string") {
    return false;
  }

  if (SIMPLE_COMMAND_TYPES.has(value.type)) {
    return hasExactKeys(value, ["type", "requestId"]);
  }

  if (value.type === "credentials/save") {
    const allowedKeys = value.appSecret === undefined
      ? ["type", "requestId", "appKey"]
      : ["type", "requestId", "appKey", "appSecret"];
    return (
      hasExactKeys(value, allowedKeys) &&
      typeof value.appKey === "string" &&
      value.appKey.trim().length > 0 &&
      (value.appSecret === undefined || typeof value.appSecret === "string")
    );
  }

  if (value.type === "preferences/save") {
    return (
      hasExactKeys(value, ["type", "requestId", "preferences"]) &&
      isPreferences(value.preferences)
    );
  }

  return false;
}

export function parsePiCommand(value: unknown): PiCommand | null {
  return validatePiCommand(value) ? value : null;
}
