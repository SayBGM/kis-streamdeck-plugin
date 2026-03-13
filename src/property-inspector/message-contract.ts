import {
  ErrorType,
  type GlobalSettings,
  type JsonValue,
  type OverseasExchange,
} from "../types/index.js";

export const CONNECTION_TEST_REQUEST_TYPE = "kis.connectionTest";
export const CONNECTION_TEST_RESULT_TYPE = "kis.connectionTestResult";

export type ConnectionTestRequestPayload = {
  type: typeof CONNECTION_TEST_REQUEST_TYPE;
  requestId?: string;
  appKey?: string;
  appSecret?: string;
  stockCode?: string;
  ticker?: string;
  exchange?: OverseasExchange;
};

export type ConnectionTestResultPayload = {
  type: typeof CONNECTION_TEST_RESULT_TYPE;
  requestId?: string;
  ok: boolean;
  errorType?: ErrorType;
  message: string;
};

export function isConnectionTestRequestPayload(
  payload: JsonValue
): payload is ConnectionTestRequestPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }

  return payload.type === CONNECTION_TEST_REQUEST_TYPE;
}

export function hasUsableCredentials(
  settings: Pick<GlobalSettings, "appKey" | "appSecret">
): settings is { appKey: string; appSecret: string } {
  return !!settings.appKey?.trim() && !!settings.appSecret?.trim();
}
