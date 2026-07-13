import type { DiagnosticsSnapshot } from "../core/diagnostics-store.js";
import type {
  KisErrorCode,
  KisErrorScope,
} from "../core/errors.js";
import {
  isThrottledRenderIntervalMs,
  isUiUpdateMode,
  type EffectiveRenderIntervalMs,
  type ThrottledRenderIntervalMs,
  type UiUpdateMode,
} from "../core/ui-update-policy.js";
import type { ConnectionState } from "../kis/connection-supervisor.js";
import type { PhysicalSubscriptionState } from "../kis/subscription-supervisor.js";

export type DataMode = "automatic" | "rest-only";
export type BackupPollIntervalMs = 15_000 | 30_000 | 60_000;

export interface PiPreferences {
  dataMode: DataMode;
  uiUpdateMode: UiUpdateMode;
  renderIntervalMs: ThrottledRenderIntervalMs;
  backupPollIntervalMs: BackupPollIntervalMs;
}

export type PiCommand =
  | { type: "settings/request"; requestId: string }
  | {
      type: "credentials/save";
      requestId: string;
      appKey: string;
      appSecret?: string;
      settingsRevision?: number;
    }
  | { type: "credentials/clear"; requestId: string; settingsRevision?: number }
  | {
      type: "preferences/save";
      requestId: string;
      preferences: PiPreferences;
      settingsRevision?: number;
    }
  | { type: "diagnostics/request"; requestId: string }
  | { type: "auth/retry"; requestId: string }
  | { type: "ws/reconnect"; requestId: string }
  | { type: "quote/refresh"; requestId: string };

export interface SanitizedPiSnapshot {
  schemaVersion: 2;
  snapshotEpoch: string;
  snapshotSequence: number;
  settingsRevision: number;
  credentialsConfigured: boolean;
  maskedAppKey?: string;
  preferences: PiPreferences;
  diagnostics: PiDiagnosticsSnapshot;
}

export interface PiDiagnosticsSnapshot {
  auth: {
    configured: boolean;
    credentialGeneration: number;
    tokenExpiresAt?: number;
  };
  websocket: {
    state: ConnectionState;
    demand: number;
    lastActivityAt?: number;
    heartbeatPending: boolean;
    reconnectAttempts: number;
  };
  subscriptions: {
    total: number;
    states: Partial<Record<PhysicalSubscriptionState, number>>;
    queuedControls: number;
    rotationActive: boolean;
    rotationQueued: number;
  };
  restBackup: {
    queuedRequests: number;
    sharedRequests: number;
    activeTransports: number;
    cacheEntries: number;
    startsInRateWindow: number;
    failures: number;
  };
  render: {
    uiUpdateMode: UiUpdateMode;
    configuredIntervalMs: ThrottledRenderIntervalMs;
    effectiveIntervalMs: EffectiveRenderIntervalMs;
    activeTargets: number;
    queuedTargets: number;
    submitted: number;
    coalesced: number;
    renders: number;
    commits: number;
    semanticSkips: number;
    imageSkips: number;
    supersededSkips: number;
    staleDrops: number;
    failures: number;
    cacheEntries: number;
  };
  recentErrors: DiagnosticsSnapshot;
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

export type PiPush =
  | { type: "settings/update"; snapshot: SanitizedPiSnapshot }
  | { type: "diagnostics/update"; snapshot: SanitizedPiSnapshot };

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

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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
    "uiUpdateMode",
    "renderIntervalMs",
    "backupPollIntervalMs",
  ])) {
    return null;
  }
  if (!(
    (data.dataMode === "automatic" || data.dataMode === "rest-only") &&
    isUiUpdateMode(data.uiUpdateMode) &&
    isThrottledRenderIntervalMs(data.renderIntervalMs) &&
    (data.backupPollIntervalMs === 15_000 ||
      data.backupPollIntervalMs === 30_000 ||
      data.backupPollIntervalMs === 60_000)
  )) {
    return null;
  }
  return copyNullPrototype<PiPreferences>([
    ["dataMode", data.dataMode],
    ["uiUpdateMode", data.uiUpdateMode],
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
    const mutable = data.type === "credentials/clear";
    const keys = mutable && data.settingsRevision !== undefined
      ? ["type", "requestId", "settingsRevision"]
      : ["type", "requestId"];
    if (!hasExactKeys(data, keys)) return null;
    if (data.settingsRevision !== undefined && !isRevision(data.settingsRevision)) return null;
    return copyNullPrototype<PiCommand>([
      ["type", data.type],
      ["requestId", data.requestId],
      ...(data.settingsRevision === undefined
        ? []
        : [["settingsRevision", data.settingsRevision] as const]),
    ]);
  }

  if (data.type === "credentials/save") {
    const allowedKeys = [
      "type",
      "requestId",
      "appKey",
      ...(data.appSecret === undefined ? [] : ["appSecret"]),
      ...(data.settingsRevision === undefined ? [] : ["settingsRevision"]),
    ];
    if (
      !hasExactKeys(data, allowedKeys) ||
      typeof data.appKey !== "string" ||
      data.appKey.trim().length === 0 ||
      (data.appSecret !== undefined && typeof data.appSecret !== "string") ||
      (data.settingsRevision !== undefined && !isRevision(data.settingsRevision))
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
      ...(data.settingsRevision === undefined
        ? []
        : [["settingsRevision", data.settingsRevision] as const]),
    ]);
  }

  if (data.type === "preferences/save") {
    const keys = data.settingsRevision === undefined
      ? ["type", "requestId", "preferences"]
      : ["type", "requestId", "preferences", "settingsRevision"];
    if (!hasExactKeys(data, keys)) return null;
    if (data.settingsRevision !== undefined && !isRevision(data.settingsRevision)) return null;
    const preferences = parsePreferences(data.preferences);
    if (!preferences) return null;
    return copyNullPrototype<PiCommand>([
      ["type", data.type],
      ["requestId", data.requestId],
      ["preferences", preferences],
      ...(data.settingsRevision === undefined
        ? []
        : [["settingsRevision", data.settingsRevision] as const]),
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
