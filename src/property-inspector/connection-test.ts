import { getApprovalKey } from "../kis/auth.js";
import { ErrorType, type GlobalSettings } from "../types/index.js";
import {
  type ConnectionTestRequestPayload,
  type ConnectionTestResultPayload,
  CONNECTION_TEST_RESULT_TYPE,
  hasUsableCredentials,
} from "./message-contract.js";

function createResult(
  request: ConnectionTestRequestPayload,
  ok: boolean,
  message: string,
  errorType?: ErrorType
): ConnectionTestResultPayload {
  return {
    type: CONNECTION_TEST_RESULT_TYPE,
    requestId: request.requestId,
    ok,
    errorType,
    message,
  };
}

function classifyCredentialValidationError(error: unknown): ErrorType {
  if (error instanceof TypeError) {
    return ErrorType.NETWORK_ERROR;
  }

  if (error instanceof Error) {
    const statusMatch = error.message.match(/\((\d{3})\)/);
    const status = statusMatch ? Number(statusMatch[1]) : undefined;

    if (status === 400 || status === 401 || status === 403) {
      return ErrorType.AUTH_FAIL;
    }
  }

  return ErrorType.NETWORK_ERROR;
}

function credentialsFromRequest(
  request: ConnectionTestRequestPayload
): Pick<GlobalSettings, "appKey" | "appSecret"> | null {
  if (!request.appKey && !request.appSecret) {
    return null;
  }

  return {
    appKey: request.appKey,
    appSecret: request.appSecret,
  };
}

export async function runConnectionTest(
  request: ConnectionTestRequestPayload,
  fallbackSettings: GlobalSettings
): Promise<ConnectionTestResultPayload> {
  const credentials = credentialsFromRequest(request) ?? fallbackSettings;

  if (!hasUsableCredentials(credentials)) {
    return createResult(
      request,
      false,
      "App Key와 App Secret을 입력한 뒤 다시 시도하세요.",
      ErrorType.NO_CREDENTIAL
    );
  }

  try {
    await getApprovalKey({
      appKey: credentials.appKey.trim(),
      appSecret: credentials.appSecret.trim(),
    });

    return createResult(request, true, "KIS API 자격증명을 확인했습니다.");
  } catch (error) {
    const errorType = classifyCredentialValidationError(error);
    const message =
      errorType === ErrorType.AUTH_FAIL
        ? "App Key 또는 App Secret을 확인하세요."
        : "KIS API 연결을 확인하지 못했습니다. 잠시 후 다시 시도하세요.";

    return createResult(request, false, message, errorType);
  }
}
