import type { StockData, PriceSign } from "../types/index.js";

/**
 * 해외주식 실시간지연체결가 (HDFSCNT0) 데이터 필드 인덱스
 *
 * WebSocket으로 수신한 ^-구분 데이터의 각 필드 위치
 */
const FIELD = {
  RSYM: 0, // 실시간종목코드 (거래소코드+종목코드)
  SYMB: 1, // 종목코드
  ZDIV: 2, // 소수점자리수
  TYMD: 3, // 현지영업일자
  XYMD: 4, // 현지일자
  XHMS: 5, // 현지시간
  KYMD: 6, // 한국일자
  KHMS: 7, // 한국시간
  OPEN: 8, // 시가
  HIGH: 9, // 고가
  LOW: 10, // 저가
  LAST: 11, // 현재가
  SIGN: 12, // 대비구분 (1~5)
  DIFF: 13, // 전일대비
  RATE: 14, // 등락율
  PVOL: 15, // 거래량
  TVOL: 16, // 누적거래량
  TAMT: 17, // 누적거래대금
  ORDY: 18, // 매수가능여부
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
 * 해외주식 실시간지연체결가 데이터를 StockData로 파싱
 *
 * @param fields - ^-구분된 데이터 필드 배열
 * @param displayName - 표시용 종목명 (사용자가 설정에서 입력)
 */
export function parseOverseasData(
  fields: string[],
  displayName: string
): StockData {
  const ticker = fields[FIELD.SYMB] ?? "";
  const price = parseFloat(fields[FIELD.LAST] ?? "0");
  const change = parseFloat(fields[FIELD.DIFF] ?? "0");
  const changeRate = parseFloat(fields[FIELD.RATE] ?? "0");
  const sign = parseSign(fields[FIELD.SIGN] ?? "3");

  return {
    ticker,
    name: displayName || ticker,
    price,
    change: sign === "fall" ? -Math.abs(change) : change,
    changeRate: sign === "fall" ? -Math.abs(changeRate) : changeRate,
    sign,
  };
}
