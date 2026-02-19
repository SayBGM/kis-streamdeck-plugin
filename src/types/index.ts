// ─── JSON 타입 (Stream Deck Global Settings 호환) ───
export type JsonPrimitive = boolean | number | string | null | undefined;
export type JsonValue = JsonObject | JsonPrimitive | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

// ─── 전역 설정 (Global Settings) ───
export type GlobalSettings = {
  appKey?: string;
  appSecret?: string;
  /**
   * KIS OpenAPI access_token (REST)
   * Stream Deck Global Settings에 함께 저장해 재시작 후에도 재사용합니다.
   */
  accessToken?: string;
  /** epoch ms */
  accessTokenExpiry?: number;
  [key: string]: JsonValue;
};

// ─── 액션별 설정 (Action Settings) ───
export type DomesticStockSettings = {
  stockCode: string; // 종목코드 (예: "005930")
  stockName: string; // 종목명 (예: "삼성전자")
  [key: string]: string;
};

export type OverseasStockSettings = {
  ticker: string; // 티커 심볼 (예: "AAPL")
  exchange: OverseasExchange; // 거래소 코드
  stockName: string; // 종목명 (예: "Apple")
  [key: string]: string;
};

export type OverseasExchange = "NYS" | "NAS" | "AMS";

// ─── 주식 데이터 ───
export interface StockData {
  ticker: string; // 종목코드 또는 티커
  name: string; // 종목명 (표시용)
  price: number; // 현재가
  change: number; // 전일 대비 변동량
  changeRate: number; // 전일 대비 변동률 (%)
  sign: PriceSign; // 상승/하락/보합
}

export type PriceSign = "rise" | "fall" | "flat";

export type MarketSession = "PRE" | "REG" | "AFT" | "CLOSED";

export type Market = "domestic" | "overseas";

/**
 * 화면에 표시할 연결 상태
 * - LIVE: WebSocket 실시간 데이터 수신 중
 * - BACKUP: REST 스냅샷 등 대체 경로로 표시 중
 * - BROKEN: 실시간/대체 경로 모두 정상 동작하지 않음
 */
export type StreamConnectionState = "LIVE" | "BACKUP" | "BROKEN";

export interface StockCardRenderOptions {
  isStale?: boolean;
  connectionState?: StreamConnectionState | null;
}

// ─── WebSocket 관련 상수 ───
export const KIS_WS_URL = "ws://ops.koreainvestment.com:21000";
export const KIS_REST_BASE = "https://openapi.koreainvestment.com:9443";

export const TR_ID_DOMESTIC = "H0UNCNT0"; // 국내주식 실시간체결가
export const TR_ID_OVERSEAS = "HDFSCNT0"; // 해외주식 실시간지연체결가

// ─── 해외주식 거래소 매핑 ───

/** 야간거래 (미국 정규장) tr_key 접두사: D + 거래소 */
export const OVERSEAS_NIGHT_PREFIX: Record<string, string> = {
  NYS: "DNYS",
  NAS: "DNAS",
  AMS: "DAMS",
};

/** 주간거래 (한국 낮 시간) tr_key 접두사: R + 거래소 */
export const OVERSEAS_DAY_PREFIX: Record<string, string> = {
  NYS: "RBAY",
  NAS: "RBAQ",
  AMS: "RBAA",
};

/**
 * 현재 미국주식 주간/야간 거래 구분
 *
 * 한국시간(KST) 기준:
 * - 주간거래: 09:00 ~ 15:30 KST (한국 장 중)
 * - 야간거래: 미국 정규장 시간 (써머타임 반영)
 * - 그 외: 장외
 *
 * 주간거래는 한국 시간 기반이므로 DST 영향 없음.
 * 타임존 유틸은 순환 참조 방지를 위해 여기서 직접 계산.
 */
export function isOverseasDayTrading(): boolean {
  // KST는 DST가 없으므로 UTC+9로 고정 계산해도 무방
  const now = new Date();
  const kstHour = (now.getUTCHours() + 9) % 24;
  const kstMin = now.getUTCMinutes();
  const totalMin = kstHour * 60 + kstMin;

  // 주간거래 시간: 09:00 ~ 15:30 KST
  return totalMin >= 540 && totalMin < 930;
}

// ─── REST API TR_ID 상수 ───
export const REST_TR_DOMESTIC_PRICE = "FHKST01010100"; // 국내주식 현재가 시세
export const REST_TR_OVERSEAS_PRICE = "HHDFS00000300"; // 해외주식 현재체결가
