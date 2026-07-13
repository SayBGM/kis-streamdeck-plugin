import type {
  DomesticInstrumentType,
  JsonObject,
  JsonValue,
  OverseasExchange,
} from "../types/index.js";
import { KisError } from "../core/errors.js";
import {
  isThrottledRenderIntervalMs,
  isUiUpdateMode,
  type ThrottledRenderIntervalMs,
  type UiUpdateMode,
} from "../core/ui-update-policy.js";

export type DataMode = "automatic" | "rest-only";
export type BackupPollIntervalMs = 15_000 | 30_000 | 60_000;

export type GlobalPreferencesV2 = JsonObject & {
  dataMode: DataMode;
  uiUpdateMode: UiUpdateMode;
  renderIntervalMs: ThrottledRenderIntervalMs;
  backupPollIntervalMs: BackupPollIntervalMs;
};

export type GlobalSettingsV2 = JsonObject & {
  appKey?: string;
  appSecret?: string;
  schemaVersion: 2;
  settingsRevision: number;
  credentialFingerprint?: string;
  credentialGeneration: number;
  accessToken?: string;
  accessTokenExpiry?: number;
  accessTokenFingerprint?: string;
  accessTokenVersion: number;
  preferences: GlobalPreferencesV2;
};

export type DomesticStockSettingsV2 = JsonObject & {
  schemaVersion: 2;
  stockCode: string;
  instrumentType: DomesticInstrumentType;
  stockName: string;
};

export type OverseasStockSettingsV2 = JsonObject & {
  schemaVersion: 2;
  ticker: string;
  exchange: OverseasExchange;
  stockName: string;
};

const LEGACY_GLOBAL_KEYS = new Set([
  "updateMode",
  "pollIntervalSec",
  "throttleMs",
]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function settingsInputError(): KisError {
  return new KisError({
    code: "SETTINGS",
    scope: "settings",
    retryable: false,
    safeMessage: "설정 데이터 형식이 올바르지 않습니다.",
  });
}

function plainDataEntries(value: Readonly<Record<string, unknown>>): Array<readonly [string, unknown]> {
  let prototype: object | null;
  let symbols: symbol[];
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    symbols = Object.getOwnPropertySymbols(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw settingsInputError();
  }

  if (
    (prototype !== Object.prototype && prototype !== null) ||
    symbols.length > 0
  ) {
    throw settingsInputError();
  }

  const entries: Array<readonly [string, unknown]> = [];
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw settingsInputError();
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function cloneArray(value: readonly unknown[], ancestors: WeakSet<object>): JsonValue[] {
  let prototype: object | null;
  let symbols: symbol[];
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    symbols = Object.getOwnPropertySymbols(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw settingsInputError();
  }

  if (prototype !== Array.prototype || symbols.length > 0) {
    throw settingsInputError();
  }

  const lengthDescriptor = descriptors.length;
  if (
    !lengthDescriptor ||
    !("value" in lengthDescriptor) ||
    typeof lengthDescriptor.value !== "number" ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    throw settingsInputError();
  }
  const clone = new Array<JsonValue>(lengthDescriptor.value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key === "length") continue;
    if (
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      !/^(?:0|[1-9]\d*)$/.test(key) ||
      Number(key) >= lengthDescriptor.value
    ) {
      throw settingsInputError();
    }
    clone[Number(key)] = cloneJsonValue(descriptor.value, ancestors);
  }
  return clone;
}

function cloneJsonValue(value: unknown, ancestors = new WeakSet<object>()): JsonValue {
  if (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }

  if (typeof value !== "object" || value === null) {
    throw settingsInputError();
  }
  if (ancestors.has(value)) {
    throw settingsInputError();
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return cloneArray(value, ancestors);
    }
    if (!isRecord(value)) {
      throw settingsInputError();
    }

    const clone = Object.create(null) as JsonObject;
    for (const [key, nested] of plainDataEntries(value)) {
      clone[key] = cloneJsonValue(nested, ancestors);
    }
    return clone;
  } finally {
    ancestors.delete(value);
  }
}

function cloneRecord(input: unknown): JsonObject {
  if (!isRecord(input)) return Object.create(null) as JsonObject;
  return cloneJsonValue(input) as JsonObject;
}

function readString(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

function safeCounter(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function parsedNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;

  const normalized = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function migrateBackupPollInterval(pollIntervalSec: unknown): BackupPollIntervalMs {
  const parsed = parsedNumber(pollIntervalSec);
  if (parsed === null) return 30_000;
  if (parsed <= 15) return 15_000;
  if (parsed <= 30) return 30_000;
  return 60_000;
}

function normalizePreferences(record: Readonly<Record<string, unknown>>): GlobalPreferencesV2 {
  const candidate = isRecord(record.preferences) ? record.preferences : {};
  const migrated = cloneRecord(candidate);
  const legacyMode = record.updateMode;
  const dataMode: DataMode = candidate.dataMode === "automatic" || candidate.dataMode === "rest-only"
    ? candidate.dataMode
    : legacyMode === "poll"
      ? "rest-only"
      : "automatic";
  let uiUpdateMode: UiUpdateMode = "throttled";
  let renderIntervalMs: ThrottledRenderIntervalMs = 1_000;
  if (
    isUiUpdateMode(candidate.uiUpdateMode) &&
    isThrottledRenderIntervalMs(candidate.renderIntervalMs)
  ) {
    uiUpdateMode = candidate.uiUpdateMode;
    renderIntervalMs = candidate.renderIntervalMs;
  }
  const backupPollIntervalMs: BackupPollIntervalMs =
    candidate.backupPollIntervalMs === 15_000 ||
    candidate.backupPollIntervalMs === 30_000 ||
    candidate.backupPollIntervalMs === 60_000
      ? candidate.backupPollIntervalMs
      : migrateBackupPollInterval(record.pollIntervalSec);

  migrated.dataMode = dataMode;
  migrated.uiUpdateMode = uiUpdateMode;
  migrated.renderIntervalMs = renderIntervalMs;
  migrated.backupPollIntervalMs = backupPollIntervalMs;
  return migrated as GlobalPreferencesV2;
}

export function migrateGlobalSettings(input: unknown): GlobalSettingsV2 {
  const source = isRecord(input) ? input : {};
  const migrated = cloneRecord(source);

  for (const key of LEGACY_GLOBAL_KEYS) {
    delete migrated[key];
  }

  migrated.schemaVersion = 2;
  migrated.settingsRevision = safeCounter(source.settingsRevision);
  migrated.credentialGeneration = safeCounter(source.credentialGeneration);
  migrated.accessTokenVersion = safeCounter(source.accessTokenVersion);
  migrated.preferences = normalizePreferences(source);

  if (typeof source.appKey !== "string") delete migrated.appKey;
  if (typeof source.appSecret !== "string") delete migrated.appSecret;
  if (
    typeof source.credentialFingerprint !== "string" ||
    source.credentialFingerprint.trim().length === 0
  ) {
    delete migrated.credentialFingerprint;
  }
  const hasMatchingTokenFingerprint =
    typeof source.credentialFingerprint === "string" &&
    source.credentialFingerprint.trim().length > 0 &&
    typeof source.accessTokenFingerprint === "string" &&
    source.accessTokenFingerprint.trim().length > 0 &&
    source.accessTokenFingerprint === source.credentialFingerprint;
  if (!hasMatchingTokenFingerprint) {
    delete migrated.accessTokenFingerprint;
    delete migrated.accessToken;
    delete migrated.accessTokenExpiry;
  } else {
    if (typeof source.accessToken !== "string") delete migrated.accessToken;
    if (typeof source.accessTokenExpiry !== "number" || !Number.isFinite(source.accessTokenExpiry)) {
      delete migrated.accessTokenExpiry;
    }
  }

  return migrated as GlobalSettingsV2;
}

function actionBase(input: unknown): {
  source: Readonly<Record<string, unknown>>;
  migrated: JsonObject;
} {
  const source = isRecord(input) ? input : {};
  return { source, migrated: cloneRecord(source) };
}

export function migrateDomesticStockSettings(input: unknown): DomesticStockSettingsV2 {
  const { source, migrated } = actionBase(input);
  const stockCode = (readString(source, "stockCode") ?? "").trim().toUpperCase();
  const stockName = (readString(source, "stockName") ?? "").trim() || stockCode;

  migrated.schemaVersion = 2;
  migrated.stockCode = stockCode;
  migrated.instrumentType = source.instrumentType === "etf" ? "etf" : "stock";
  migrated.stockName = stockName;
  return migrated as DomesticStockSettingsV2;
}

export function migrateOverseasStockSettings(input: unknown): OverseasStockSettingsV2 {
  const { source, migrated } = actionBase(input);
  const ticker = (readString(source, "ticker") ?? "").trim().toUpperCase();
  const exchangeValue = (readString(source, "exchange") ?? "").trim().toUpperCase();
  const exchange: OverseasExchange =
    exchangeValue === "NYS" || exchangeValue === "AMS" ? exchangeValue : "NAS";

  migrated.schemaVersion = 2;
  migrated.ticker = ticker;
  migrated.exchange = exchange;
  migrated.stockName = (readString(source, "stockName") ?? "").trim() || ticker;
  return migrated as OverseasStockSettingsV2;
}

function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonEqual(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;

  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) =>
      key === rightKeys[index] && jsonEqual(left[key], right[key]),
    );
}

export function actionSettingsEqual(left: unknown, right: unknown): boolean {
  try {
    return jsonEqual(cloneJsonValue(left), cloneJsonValue(right));
  } catch {
    return false;
  }
}

export const globalSettingsEqual = actionSettingsEqual;
export const areActionSettingsEqual = actionSettingsEqual;
