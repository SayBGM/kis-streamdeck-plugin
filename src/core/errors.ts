export type KisErrorCode =
  | "NO_CREDENTIALS"
  | "AUTH_REJECTED"
  | "AUTH_RATE_LIMITED"
  | "NETWORK"
  | "TIMEOUT"
  | "INVALID_INSTRUMENT"
  | "PROTOCOL"
  | "SUBSCRIPTION_REJECTED"
  | "SETTINGS";

export type KisErrorScope =
  | "auth"
  | "rest"
  | "websocket"
  | "action"
  | "settings";

export const SAFE_DIAGNOSTIC_STATES = [
  "idle",
  "initializing",
  "ready",
  "degraded",
  "connecting",
  "connected",
  "disconnecting",
  "disconnected",
  "reconnecting",
  "retrying",
  "subscribed",
  "unsubscribed",
  "live",
  "backup",
  "broken",
  "open",
  "closed",
  "success",
  "failure",
] as const;

export type SafeDiagnosticState = (typeof SAFE_DIAGNOSTIC_STATES)[number];
export type SafeMetadataValue = number | boolean | SafeDiagnosticState;
export type SafeMetadata = Readonly<Record<string, SafeMetadataValue>>;

const SAFE_NUMERIC_METADATA_KEYS = new Set([
  "attempt",
  "count",
  "delayMs",
  "durationMs",
  "generation",
  "httpStatus",
  "revision",
  "sessionEpoch",
  "subscriptionCount",
]);

const SAFE_BOOLEAN_METADATA_KEYS = new Set([
  "baseKnown",
  "connected",
  "credentialsConfigured",
  "persistenceDegraded",
  "retryScheduled",
]);

const SAFE_STATE_SET = new Set<string>(SAFE_DIAGNOSTIC_STATES);

/**
 * 진단 데이터에 넣을 수 있는 값만 복사합니다. 문자열은 정해진 state 외에는
 * 저장하지 않으므로 원문 응답이나 인증정보가 우발적으로 남지 않습니다.
 */
export function sanitizeMetadata(
  metadata?: Readonly<Record<string, unknown>>,
): SafeMetadata {
  if (!metadata) return {};

  const safe: Record<string, SafeMetadataValue> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (
      SAFE_NUMERIC_METADATA_KEYS.has(key) &&
      typeof value === "number" &&
      Number.isFinite(value)
    ) {
      safe[key] = value;
    } else if (
      SAFE_BOOLEAN_METADATA_KEYS.has(key) &&
      typeof value === "boolean"
    ) {
      safe[key] = value;
    } else if (key === "state" && typeof value === "string" && SAFE_STATE_SET.has(value)) {
      safe.state = value as SafeDiagnosticState;
    }
  }

  return safe;
}

export interface KisErrorInit {
  code: KisErrorCode;
  scope: KisErrorScope;
  retryable: boolean;
  safeMessage: string;
  at?: number;
  metadata?: Readonly<Record<string, unknown>>;
}

/**
 * 외부 경계로 전달 가능한 KIS 오류입니다.
 * Error.cause, 원문 body/header/payload 및 토큰은 의도적으로 보관하지 않습니다.
 */
export class KisError {
  readonly code: KisErrorCode;
  readonly scope: KisErrorScope;
  readonly retryable: boolean;
  readonly safeMessage: string;
  readonly at: number;
  readonly metadata?: SafeMetadata;

  constructor(init: KisErrorInit) {
    this.code = init.code;
    this.scope = init.scope;
    this.retryable = init.retryable;
    this.safeMessage = init.safeMessage;
    this.at = init.at ?? Date.now();

    const metadata = sanitizeMetadata(init.metadata);
    if (Object.keys(metadata).length > 0) {
      this.metadata = Object.freeze(metadata);
    }
  }
}
