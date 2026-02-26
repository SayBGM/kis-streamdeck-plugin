import type {
  StockData,
  MarketSession,
  Market,
  StreamConnectionState,
  StockCardRenderOptions,
} from "../types/index.js";
import { getETTotalMinutes, getKSTTotalMinutes } from "../utils/timezone.js";

// ─── 디자인 상수 ───
const CARD_SIZE = 144;
const BG_COLOR = "#1a1a2e";
const BG_RADIUS = 12;

const COLOR_RISE = "#00c853"; // 상승 (초록)
const COLOR_FALL = "#ff1744"; // 하락 (빨강)
const COLOR_FLAT = "#9e9e9e"; // 보합 (회색)
const COLOR_TEXT = "#ffffff"; // 기본 텍스트
const COLOR_TEXT_STALE = "#ffd54f"; // stale 상태 종목명 (노랑)
const COLOR_SESSION_REG = "#00c853"; // 정규장 (초록)
const COLOR_SESSION_OTHER = "#ff9800"; // 프리/에프터 (주황)
const COLOR_SESSION_CLOSED = "#616161"; // 장 마감 (어두운 회색)
const COLOR_CONN_LIVE = "#00c853";
const COLOR_CONN_BACKUP = "#ffd54f";
const COLOR_CONN_BROKEN = "#ff1744";

const SESSION_ICON_X_DEFAULT = 130;
const SESSION_ICON_Y = 30;
const SESSION_ICON_FONT_SIZE = 18;
const CONNECTION_LINE_X = 8;
const CONNECTION_LINE_Y = 138;
const CONNECTION_LINE_WIDTH = 128;
const CONNECTION_LINE_HEIGHT = 4;

const ARROW_UP = "\u25B2"; // ▲
const ARROW_DOWN = "\u25BC"; // ▼
const SVG_DATA_URI_CACHE_MAX_ENTRIES = 500;

// Intl 객체 생성 비용을 줄이기 위해 재사용합니다.
const KR_INT_FORMAT = new Intl.NumberFormat("ko-KR", {
  maximumFractionDigits: 0,
});

const svgDataUriCache = new Map<string, string>();

// ─── 장 상태 판단 ───

/**
 * 국내주식 장 상태 판단 (KST 기준)
 */
function getDomesticSession(): MarketSession {
  const totalMin = getKSTTotalMinutes();

  if (totalMin >= 510 && totalMin < 540) return "PRE"; // 08:30 ~ 09:00
  if (totalMin >= 540 && totalMin < 930) return "REG"; // 09:00 ~ 15:30
  if (totalMin >= 940 && totalMin < 1080) return "AFT"; // 15:40 ~ 18:00
  return "CLOSED";
}

/**
 * 미국주식 장 상태 판단 (ET 기준, 써머타임 자동 반영)
 */
function getOverseasSession(): MarketSession {
  const totalMin = getETTotalMinutes();

  if (totalMin >= 240 && totalMin < 570) return "PRE"; // 04:00 ~ 09:30
  if (totalMin >= 570 && totalMin < 960) return "REG"; // 09:30 ~ 16:00
  if (totalMin >= 960 && totalMin < 1200) return "AFT"; // 16:00 ~ 20:00
  return "CLOSED";
}

export function getMarketSession(market: Market): MarketSession {
  return market === "domestic" ? getDomesticSession() : getOverseasSession();
}

// ─── 가격 포맷 ───

/**
 * 가격을 표시 문자열로 변환
 * - 국내주식: 정수 콤마 (예: 65,800)
 * - 해외주식: $소수점2자리 (예: $182.52)
 */
function formatPrice(price: number, market: Market): string {
  if (market === "domestic") {
    return KR_INT_FORMAT.format(price);
  }
  return `$${price.toFixed(2)}`;
}

/**
 * 변동량을 표시 문자열로 변환 (화살표 포함)
 * - 국내: ▲ 1,200 / ▼ 800
 * - 해외: ▲ $1.25 / ▼ $0.50
 */
function formatChangeWithArrow(change: number, sign: string, market: Market): string {
  const arrow = sign === "rise" ? ARROW_UP : sign === "fall" ? ARROW_DOWN : "";
  const absChange =
    market === "domestic"
      ? KR_INT_FORMAT.format(Math.abs(change))
      : `${Math.abs(change).toFixed(2)}`;

  return arrow ? `${arrow} ${absChange}` : absChange;
}

/**
 * 변동률을 표시 문자열로 변환
 */
function formatChangeRate(rate: number): string {
  return `${Math.abs(rate).toFixed(2)}%`;
}

// ─── 가격 텍스트 크기 자동 조절 ───

function getPriceFontSize(priceStr: string): number {
  const len = priceStr.length;
  if (len <= 5) return 36;
  if (len <= 7) return 30;
  if (len <= 9) return 26;
  if (len <= 11) return 22;
  return 18;
}

// ─── SVG 이미지 생성 ───

/**
 * 데이터 없을 때 보여줄 대기 화면
 */
export function renderWaitingCard(
  name: string,
  market: Market
): string {
  const session = getMarketSession(market);
  const sessionColor = getSessionColor(session);
  const sessionBadge = getSessionBadgeSymbol(session);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_SIZE}" height="${CARD_SIZE}" viewBox="0 0 ${CARD_SIZE} ${CARD_SIZE}">
  <rect width="${CARD_SIZE}" height="${CARD_SIZE}" rx="${BG_RADIUS}" fill="${BG_COLOR}"/>
  <text x="12" y="30" font-family="Arial, Helvetica, sans-serif" font-size="22" font-weight="bold" fill="${COLOR_TEXT}">${escapeXml(truncateName(name || "---", 6))}</text>
  <text x="${SESSION_ICON_X_DEFAULT}" y="${SESSION_ICON_Y}" font-family="Arial, Helvetica, sans-serif" font-size="${SESSION_ICON_FONT_SIZE}" font-weight="bold" fill="${sessionColor}" text-anchor="middle">${sessionBadge}</text>
  <text x="72" y="80" font-family="Arial, Helvetica, sans-serif" font-size="16" fill="${COLOR_FLAT}" text-anchor="middle">연결중...</text>
</svg>`;
}

/**
 * 에러 상태 화면
 */
export function renderErrorCard(message: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_SIZE}" height="${CARD_SIZE}" viewBox="0 0 ${CARD_SIZE} ${CARD_SIZE}">
  <rect width="${CARD_SIZE}" height="${CARD_SIZE}" rx="${BG_RADIUS}" fill="${BG_COLOR}"/>
  <text x="72" y="60" font-family="Arial, Helvetica, sans-serif" font-size="20" fill="${COLOR_FALL}" text-anchor="middle">오류</text>
  <text x="72" y="90" font-family="Arial, Helvetica, sans-serif" font-size="14" fill="${COLOR_FLAT}" text-anchor="middle">${escapeXml(message)}</text>
</svg>`;
}

/**
 * 구독 성공 + 데이터 대기 화면
 */
export function renderConnectedCard(
  name: string,
  market: Market
): string {
  const session = getMarketSession(market);
  const sessionColor = getSessionColor(session);
  const sessionBadge = getSessionBadgeSymbol(session);
  const statusText = session === "CLOSED" ? "장 마감" : "데이터 대기";
  const statusColor = session === "CLOSED" ? COLOR_SESSION_CLOSED : COLOR_FLAT;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_SIZE}" height="${CARD_SIZE}" viewBox="0 0 ${CARD_SIZE} ${CARD_SIZE}">
  <rect width="${CARD_SIZE}" height="${CARD_SIZE}" rx="${BG_RADIUS}" fill="${BG_COLOR}"/>
  <text x="12" y="30" font-family="Arial, Helvetica, sans-serif" font-size="22" font-weight="bold" fill="${COLOR_TEXT}">${escapeXml(truncateName(name || "---", 6))}</text>
  <text x="${SESSION_ICON_X_DEFAULT}" y="${SESSION_ICON_Y}" font-family="Arial, Helvetica, sans-serif" font-size="${SESSION_ICON_FONT_SIZE}" font-weight="bold" fill="${sessionColor}" text-anchor="middle">${sessionBadge}</text>
  <text x="72" y="74" font-family="Arial, Helvetica, sans-serif" font-size="16" fill="${statusColor}" text-anchor="middle">${statusText}</text>
  <text x="72" y="100" font-family="Arial, Helvetica, sans-serif" font-size="12" fill="${COLOR_SESSION_REG}" text-anchor="middle">● 연결됨</text>
</svg>`;
}

/**
 * 설정 필요 화면
 */
export function renderSetupCard(message: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_SIZE}" height="${CARD_SIZE}" viewBox="0 0 ${CARD_SIZE} ${CARD_SIZE}">
  <rect width="${CARD_SIZE}" height="${CARD_SIZE}" rx="${BG_RADIUS}" fill="${BG_COLOR}"/>
  <text x="72" y="60" font-family="Arial, Helvetica, sans-serif" font-size="16" fill="${COLOR_SESSION_OTHER}" text-anchor="middle">설정 필요</text>
  <text x="72" y="88" font-family="Arial, Helvetica, sans-serif" font-size="13" fill="${COLOR_FLAT}" text-anchor="middle">${escapeXml(message)}</text>
</svg>`;
}

/**
 * 주식 시세 카드 SVG 생성
 *
 * 레이아웃:
 * ┌──────────────────────┐
 * │ 종목명          장상태│
 * │                      │
 * │      현재가          │
 * │ ▲ 1,200      0.69%  │
 * └──────────────────────┘
 */
export function renderStockCard(
  data: StockData,
  market: Market,
  renderOptions: StockCardRenderOptions = {}
): string {
  const session = getMarketSession(market);
  const sessionColor = getSessionColor(session);
  const changeColor = getSignColor(data.sign);
  const titleColor = renderOptions.isStale ? COLOR_TEXT_STALE : COLOR_TEXT;
  const connectionState = renderOptions.connectionState;
  const connectionColor = getConnectionColor(connectionState);
  const sessionBadge = getSessionBadgeSymbol(session);
  const sessionIconX = SESSION_ICON_X_DEFAULT;

  // 포맷된 문자열
  const priceStr = formatPrice(data.price, market);
  const changeStr = formatChangeWithArrow(data.change, data.sign, market);
  const rateStr = formatChangeRate(data.changeRate);
  const priceFontSize = getPriceFontSize(priceStr);

  // 종목명 (길이 제한)
  const displayName = truncateName(data.name, 6);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_SIZE}" height="${CARD_SIZE}" viewBox="0 0 ${CARD_SIZE} ${CARD_SIZE}">
  <rect width="${CARD_SIZE}" height="${CARD_SIZE}" rx="${BG_RADIUS}" fill="${BG_COLOR}"/>
  
  <!-- 종목명 (좌측 상단) -->
  <text x="12" y="30" font-family="Arial, Helvetica, sans-serif" font-size="22" font-weight="bold" fill="${titleColor}">${escapeXml(displayName)}</text>
  
  <!-- 장 상태 아이콘 (우측 상단) -->
  <text x="${sessionIconX}" y="${SESSION_ICON_Y}" font-family="Arial, Helvetica, sans-serif" font-size="${SESSION_ICON_FONT_SIZE}" font-weight="bold" fill="${sessionColor}" text-anchor="middle">${sessionBadge}</text>
  
  <!-- 현재가 (중앙) -->
  <text x="72" y="80" font-family="Arial, Helvetica, sans-serif" font-size="${priceFontSize}" font-weight="bold" fill="${COLOR_TEXT}" text-anchor="middle">${escapeXml(priceStr)}</text>
  
  <!-- 변동량 + 화살표 (좌측 하단) -->
  <text x="12" y="122" font-family="Arial, Helvetica, sans-serif" font-size="14" fill="${changeColor}">${escapeXml(changeStr)}</text>
  
  <!-- 변동률 (우측 하단) -->
  <text x="132" y="122" font-family="Arial, Helvetica, sans-serif" font-size="14" fill="${changeColor}" text-anchor="end">${escapeXml(rateStr)}</text>
  ${connectionColor ? `<rect x="${CONNECTION_LINE_X}" y="${CONNECTION_LINE_Y}" width="${CONNECTION_LINE_WIDTH}" height="${CONNECTION_LINE_HEIGHT}" rx="2" fill="${connectionColor}" />` : ""}
</svg>`;
}

// ─── 유틸리티 ───

function getSignColor(sign: string): string {
  switch (sign) {
    case "rise":
      return COLOR_RISE;
    case "fall":
      return COLOR_FALL;
    default:
      return COLOR_FLAT;
  }
}

function getSessionColor(session: MarketSession): string {
  switch (session) {
    case "REG":
      return COLOR_SESSION_REG;
    case "CLOSED":
      return COLOR_SESSION_CLOSED;
    default:
      return COLOR_SESSION_OTHER;
  }
}

function getConnectionColor(
  connectionState: StreamConnectionState | null | undefined
): string | null {
  switch (connectionState) {
    case "LIVE":
      return COLOR_CONN_LIVE;
    case "BACKUP":
      return COLOR_CONN_BACKUP;
    case "BROKEN":
      return COLOR_CONN_BROKEN;
    default:
      return null;
  }
}

function getSessionBadgeSymbol(session: MarketSession): string {
  switch (session) {
    case "REG":
      return "●";
    case "PRE":
      return "◐";
    case "AFT":
      return "◑";
    case "CLOSED":
      return "○";
    default:
      return "○";
  }
}

function truncateName(name: string, maxLen: number): string {
  if (name.length <= maxLen) return name;
  return name.substring(0, maxLen - 1) + "…";
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// @MX:NOTE: [AUTO] semanticKey must be 1:1 with SVG content. Format for stock cards: "${ticker}|${price}|${change}|${changeRate}|${sign}|${connectionState}|${isStale}"
// @MX:SPEC: SPEC-PERF-001 REQ-PERF-001-2.1.1, REQ-PERF-001-2.1.3
export function svgToDataUri(svg: string, semanticKey: string): string {
  const cached = svgDataUriCache.get(semanticKey);
  if (cached) {
    // LRU 갱신: 조회된 키를 최근 사용으로 이동
    svgDataUriCache.delete(semanticKey);
    svgDataUriCache.set(semanticKey, cached);
    return cached;
  }

  const dataUri = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  svgDataUriCache.set(semanticKey, dataUri);

  if (svgDataUriCache.size > SVG_DATA_URI_CACHE_MAX_ENTRIES) {
    const oldestKey = svgDataUriCache.keys().next().value;
    if (oldestKey !== undefined) {
      svgDataUriCache.delete(oldestKey);
    }
  }

  return dataUri;
}
