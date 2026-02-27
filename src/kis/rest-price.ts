import { getAccessToken } from "./auth.js";
import {
  KIS_REST_BASE,
  REST_TR_DOMESTIC_PRICE,
  REST_TR_OVERSEAS_PRICE,
  ErrorType,
  type GlobalSettings,
  type StockData,
  type PriceSign,
} from "../types/index.js";
import { logger } from "../utils/logger.js";
import { kisGlobalSettings } from "./settings-store.js";

const SETTINGS_WAIT_TIMEOUT_MS = 15_000;

async function getSettingsWithWait(): Promise<GlobalSettings | null> {
  const current = kisGlobalSettings.get();
  if (current?.appKey && current.appSecret) {
    return current;
  }

  const waited = await kisGlobalSettings.waitUntilReady(
    SETTINGS_WAIT_TIMEOUT_MS,
  );
  if (waited?.appKey && waited.appSecret) {
    logger.info("[REST] 전역 설정 준비 완료, 현재가 조회 재개");
    return waited;
  }

  logger.warn("[REST] 전역 설정 대기 타임아웃, 현재가 조회 건너뜀");
  return null;
}

// @MX:WARN: [AUTO] 기존 null 반환에서 throw로 변경됨. 모든 호출 사이트는 catch로 에러 처리 필요
// @MX:REASON: [AUTO] SPEC-UI-001 에러 UI 표시를 위해 에러 타입을 액션 레이어까지 전달해야 함
// @MX:SPEC: SPEC-UI-001
/**
 * fetch 에러를 ErrorType으로 분류하는 헬퍼
 *
 * - TypeError (fetch 실패): NETWORK_ERROR
 * - HTTP 401: AUTH_FAIL
 * - 인증 에러 메시지 (발급 실패/401 포함): AUTH_FAIL
 * - 기타 HTTP 오류: NETWORK_ERROR
 * - 빈 응답 / rt_cd !== "0": INVALID_STOCK (호출 측에서 처리)
 */
export function classifyFetchError(err: unknown, status?: number): ErrorType {
  if (err instanceof TypeError) {
    return ErrorType.NETWORK_ERROR;
  }
  if (status === 401) {
    return ErrorType.AUTH_FAIL;
  }
  if (err instanceof Error) {
    const msg = err.message;
    if (msg.includes("발급 실패") || msg.includes("401")) {
      return ErrorType.AUTH_FAIL;
    }
  }
  if (status !== undefined && status !== 200) {
    return ErrorType.NETWORK_ERROR;
  }
  return ErrorType.NETWORK_ERROR;
}

/**
 * 전일 대비 부호 변환 (REST API도 1~5 코드 사용)
 */
function parseSign(signCode: string): PriceSign {
  switch (signCode) {
    case "1":
    case "2":
      return "rise";
    case "4":
    case "5":
      return "fall";
    default:
      return "flat";
  }
}

/**
 * 국내주식 현재가 시세 REST API 조회
 *
 * 장 마감 시에도 마지막 종가를 반환합니다.
 * API: GET /uapi/domestic-stock/v1/quotations/inquire-price
 *
 * @throws {ErrorType} 에러 발생 시 ErrorType enum 값을 throw합니다.
 */
export async function fetchDomesticPrice(
  stockCode: string,
  displayName: string,
): Promise<StockData | null> {
  const settings = await getSettingsWithWait();
  if (!settings) return null;

  let response: Response | undefined;
  try {
    const token = await getAccessToken(settings);

    const url = new URL(
      `${KIS_REST_BASE}/uapi/domestic-stock/v1/quotations/inquire-price`,
    );
    url.searchParams.set("FID_COND_MRKT_DIV_CODE", "UN");
    url.searchParams.set("FID_INPUT_ISCD", stockCode);

    response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        authorization: `Bearer ${token}`,
        appkey: settings.appKey,
        appsecret: settings.appSecret,
        tr_id: REST_TR_DOMESTIC_PRICE,
      },
    });

    if (!response.ok) {
      logger.error(`[REST] 국내주식 현재가 조회 실패: ${response.status}`);
      throw classifyFetchError(new Error(`HTTP ${response.status}`), response.status);
    }

    const json = (await response.json()) as {
      output: {
        stck_prpr: string; // 현재가
        prdy_vrss: string; // 전일대비
        prdy_vrss_sign: string; // 전일대비부호
        prdy_ctrt: string; // 전일대비율
      };
    };

    const o = json.output;
    if (!o?.stck_prpr) {
      throw ErrorType.INVALID_STOCK;
    }

    const sign = parseSign(o.prdy_vrss_sign);
    const change = parseInt(o.prdy_vrss, 10) || 0;
    const changeRate = parseFloat(o.prdy_ctrt) || 0;

    return {
      ticker: stockCode,
      name: displayName,
      price: parseInt(o.stck_prpr, 10) || 0,
      change: sign === "fall" ? -Math.abs(change) : change,
      changeRate: sign === "fall" ? -Math.abs(changeRate) : changeRate,
      sign,
    };
  } catch (err) {
    // ErrorType enum 값은 그대로 re-throw
    if (Object.values(ErrorType).includes(err as ErrorType)) {
      throw err;
    }
    logger.error("[REST] 국내주식 현재가 조회 에러:", err);
    throw classifyFetchError(err, response?.status);
  }
}

/**
 * 해외주식 현재체결가 REST API 조회
 *
 * 장 마감 시에도 마지막 종가를 반환합니다.
 * API: GET /uapi/overseas-price/v1/quotations/price
 *
 * @throws {ErrorType} 에러 발생 시 ErrorType enum 값을 throw합니다.
 */
export async function fetchOverseasPrice(
  exchange: string,
  ticker: string,
  displayName: string,
): Promise<StockData | null> {
  const settings = await getSettingsWithWait();
  if (!settings) return null;

  let response: Response | undefined;
  try {
    const token = await getAccessToken(settings);

    // 거래소 코드 매핑 (KIS REST API용)
    const excdMap: Record<string, string> = {
      NYS: "NYS",
      NAS: "NAS",
      AMS: "AMS",
    };
    const excd = excdMap[exchange] || "NAS";

    const url = new URL(
      `${KIS_REST_BASE}/uapi/overseas-price/v1/quotations/price`,
    );
    url.searchParams.set("AUTH", "");
    url.searchParams.set("EXCD", excd);
    url.searchParams.set("SYMB", ticker.toUpperCase());

    response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        authorization: `Bearer ${token}`,
        appkey: settings.appKey,
        appsecret: settings.appSecret,
        tr_id: REST_TR_OVERSEAS_PRICE,
      },
    });

    if (!response.ok) {
      logger.error(`[REST] 해외주식 현재가 조회 실패: ${response.status}`);
      throw classifyFetchError(new Error(`HTTP ${response.status}`), response.status);
    }

    const json = (await response.json()) as {
      output: {
        last: string; // 현재가
        diff: string; // 전일대비
        sign: string; // 부호
        rate: string; // 등락률
      };
    };

    const o = json.output;
    if (!o?.last) {
      throw ErrorType.INVALID_STOCK;
    }

    const sign = parseSign(o.sign);
    const change = parseFloat(o.diff) || 0;
    const changeRate = parseFloat(o.rate) || 0;

    return {
      ticker: ticker.toUpperCase(),
      name: displayName,
      price: parseFloat(o.last) || 0,
      change: sign === "fall" ? -Math.abs(change) : change,
      changeRate: sign === "fall" ? -Math.abs(changeRate) : changeRate,
      sign,
    };
  } catch (err) {
    // ErrorType enum 값은 그대로 re-throw
    if (Object.values(ErrorType).includes(err as ErrorType)) {
      throw err;
    }
    logger.error("[REST] 해외주식 현재가 조회 에러:", err);
    throw classifyFetchError(err, response?.status);
  }
}
