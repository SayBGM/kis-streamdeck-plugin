import type { StockData, PriceSign } from "../types/index.js";

/**
 * 국내주식 실시간체결가 (H0UNCNT0) 데이터 필드 인덱스
 *
 * WebSocket으로 수신한 ^-구분 데이터의 각 필드 위치
 */
const FIELD = {
  MKSC_SHRN_ISCD: 0, // 유가증권 단축 종목코드
  STCK_CNTG_HOUR: 1, // 주식 체결 시간 (HHMMSS)
  STCK_PRPR: 2, // 주식 현재가
  PRDY_VRSS_SIGN: 3, // 전일 대비 부호 (1~5)
  PRDY_VRSS: 4, // 전일 대비
  PRDY_CTRT: 5, // 전일 대비율
  WGHN_AVRG_STCK_PRC: 6, // 가중 평균 주식 가격
  STCK_OPRC: 7, // 시가
  STCK_HGPR: 8, // 고가
  STCK_LWPR: 9, // 저가
  ASKP1: 10, // 매도호가1
  BIDP1: 11, // 매수호가1
  CNTG_VOL: 12, // 체결 거래량
  ACML_VOL: 13, // 누적 거래량
  ACML_TR_PBMN: 14, // 누적 거래대금
} as const;

/**
 * 전일 대비 부호를 PriceSign으로 변환
 *
 * KIS API 부호 규칙:
 * 1: 상한, 2: 상승, 3: 보합, 4: 하한, 5: 하락
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
 * 국내주식 실시간체결가 데이터를 StockData로 파싱
 *
 * @param fields - ^-구분된 데이터 필드 배열
 * @param displayName - 표시용 종목명 (사용자가 설정에서 입력)
 */
export function parseDomesticData(
  fields: string[],
  displayName: string,
): StockData {
  const ticker = fields[FIELD.MKSC_SHRN_ISCD] ?? "";
  const price = parseInt(fields[FIELD.STCK_PRPR] ?? "0", 10);
  const change = parseInt(fields[FIELD.PRDY_VRSS] ?? "0", 10);
  const changeRate = parseFloat(fields[FIELD.PRDY_CTRT] ?? "0");
  const sign = parseSign(fields[FIELD.PRDY_VRSS_SIGN] ?? "3");

  return {
    ticker,
    name: displayName || ticker,
    price,
    change: sign === "fall" ? -Math.abs(change) : change,
    changeRate: sign === "fall" ? -Math.abs(changeRate) : changeRate,
    sign,
  };
}
