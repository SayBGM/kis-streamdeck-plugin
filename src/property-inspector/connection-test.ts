import { getApprovalKey } from "../kis/auth.js";
import {
  fetchDomesticPriceForSettings,
  fetchOverseasPriceForSettings,
} from "../kis/rest-price.js";
import {
  ErrorType,
  type DomesticStockSettings,
  type GlobalSettings,
  type JsonObject,
  type OverseasExchange,
  type OverseasStockSettings,
} from "../types/index.js";
import {
  type ConnectionTestRequestPayload,
  type ConnectionTestResultPayload,
  CONNECTION_TEST_RESULT_TYPE,
  hasUsableCredentials,
} from "./message-contract.js";

const DOMESTIC_ACTION_MANIFEST_ID = "com.kis.streamdeck.domestic-stock";
const OVERSEAS_ACTION_MANIFEST_ID = "com.kis.streamdeck.overseas-stock";

type ConnectionTestActionContext = {
  actionManifestId?: string;
  actionSettings?: JsonObject;
};

type ResolvedStockValidation =
  | { kind: "none" }
  | { kind: "domestic"; stockCode: string }
  | { kind: "overseas"; ticker: string; exchange: OverseasExchange };

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

function normalizeText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function hasOwnStockField(
  request: ConnectionTestRequestPayload,
  key: "stockCode" | "ticker" | "exchange"
): boolean {
  return Object.prototype.hasOwnProperty.call(request, key);
}

function getRequestTargetMarket(
  request: ConnectionTestRequestPayload,
  actionContext?: ConnectionTestActionContext
): "domestic" | "overseas" | undefined {
  if (hasOwnStockField(request, "stockCode") || normalizeText(request.stockCode)) {
    return "domestic";
  }

  if (
    hasOwnStockField(request, "ticker") ||
    hasOwnStockField(request, "exchange") ||
    normalizeText(request.ticker) ||
    request.exchange
  ) {
    return "overseas";
  }

  if (actionContext?.actionManifestId === DOMESTIC_ACTION_MANIFEST_ID) {
    return "domestic";
  }

  if (actionContext?.actionManifestId === OVERSEAS_ACTION_MANIFEST_ID) {
    return "overseas";
  }

  return undefined;
}

function resolveStockValidation(
  request: ConnectionTestRequestPayload,
  actionContext?: ConnectionTestActionContext
): ResolvedStockValidation {
  const targetMarket = getRequestTargetMarket(request, actionContext);

  if (targetMarket === "domestic") {
    const actionSettings =
      actionContext?.actionSettings as Partial<DomesticStockSettings> | undefined;
    const stockCode = hasOwnStockField(request, "stockCode")
      ? normalizeText(request.stockCode)
      : normalizeText(actionSettings?.stockCode);

    return stockCode ? { kind: "domestic", stockCode } : { kind: "none" };
  }

  if (targetMarket === "overseas") {
    const actionSettings =
      actionContext?.actionSettings as Partial<OverseasStockSettings> | undefined;
    const ticker = hasOwnStockField(request, "ticker")
      ? normalizeText(request.ticker)?.toUpperCase()
      : normalizeText(actionSettings?.ticker)?.toUpperCase();
    const exchange = hasOwnStockField(request, "exchange")
      ? request.exchange
      : actionSettings?.exchange;

    return ticker && exchange
      ? { kind: "overseas", ticker, exchange }
      : { kind: "none" };
  }

  return { kind: "none" };
}

function createSuccessMessage(validation: ResolvedStockValidation): string {
  switch (validation.kind) {
    case "domestic":
      return "KIS API 자격증명과 현재 버튼 종목 설정을 확인했습니다.";
    case "overseas":
      return "KIS API 자격증명과 현재 버튼 종목 설정을 확인했습니다.";
    default:
      return "KIS API 자격증명을 확인했습니다.";
  }
}

function classifyStockValidationError(error: unknown): ErrorType {
  if (Object.values(ErrorType).includes(error as ErrorType)) {
    return error as ErrorType;
  }

  return ErrorType.NETWORK_ERROR;
}

function createStockValidationFailureMessage(
  validation: Exclude<ResolvedStockValidation, { kind: "none" }>,
  errorType: ErrorType
): string {
  if (errorType === ErrorType.AUTH_FAIL) {
    return "App Key 또는 App Secret을 확인하세요.";
  }

  if (errorType === ErrorType.INVALID_STOCK) {
    return validation.kind === "domestic"
      ? "종목코드를 확인하세요."
      : "티커와 거래소를 확인하세요.";
  }

  return "KIS API 연결을 확인하지 못했습니다. 잠시 후 다시 시도하세요.";
}

async function validateStockSelection(
  credentials: { appKey: string; appSecret: string },
  validation: Exclude<ResolvedStockValidation, { kind: "none" }>
): Promise<void> {
  if (validation.kind === "domestic") {
    await fetchDomesticPriceForSettings(
      credentials,
      validation.stockCode,
      validation.stockCode
    );
    return;
  }

  await fetchOverseasPriceForSettings(
    credentials,
    validation.exchange,
    validation.ticker,
    validation.ticker
  );
}

export async function runConnectionTest(
  request: ConnectionTestRequestPayload,
  fallbackSettings: GlobalSettings,
  actionContext?: ConnectionTestActionContext
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

  const normalizedCredentials = {
    appKey: credentials.appKey.trim(),
    appSecret: credentials.appSecret.trim(),
  };

  try {
    await getApprovalKey(normalizedCredentials);
  } catch (error) {
    const errorType = classifyCredentialValidationError(error);
    const message =
      errorType === ErrorType.AUTH_FAIL
        ? "App Key 또는 App Secret을 확인하세요."
        : "KIS API 연결을 확인하지 못했습니다. 잠시 후 다시 시도하세요.";

    return createResult(request, false, message, errorType);
  }

  const stockValidation = resolveStockValidation(request, actionContext);
  if (stockValidation.kind === "none") {
    return createResult(request, true, createSuccessMessage(stockValidation));
  }

  try {
    await validateStockSelection(normalizedCredentials, stockValidation);
    return createResult(request, true, createSuccessMessage(stockValidation));
  } catch (error) {
    const errorType = classifyStockValidationError(error);
    return createResult(
      request,
      false,
      createStockValidationFailureMessage(stockValidation, errorType),
      errorType
    );
  }
}
