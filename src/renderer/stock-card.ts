import type {
  StockData,
  MarketSession,
  Market,
  StreamConnectionState,
  StockCardRenderOptions,
} from "../types/index.js";
import { ErrorType } from "../types/index.js";
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
const COLOR_TEXT_SUBTLE = "#a6b0cf";
const COLOR_TEXT_MUTED = "#7f8aa8";

const SESSION_PILL_X = 94;
const SESSION_PILL_Y = 14;
const SESSION_PILL_WIDTH = 38;
const SESSION_PILL_HEIGHT = 18;
const CONNECTION_LINE_X = 8;
const CONNECTION_LINE_Y = 136;
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
  const sessionBadge = getSessionBadgeLabel(session);
  const displayName = truncateName(name || "---", 8);
  const nameFontSize = getNameFontSize(displayName);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_SIZE}" height="${CARD_SIZE}" viewBox="0 0 ${CARD_SIZE} ${CARD_SIZE}">
  <rect width="${CARD_SIZE}" height="${CARD_SIZE}" rx="${BG_RADIUS}" fill="${BG_COLOR}"/>
  ${renderSessionPill(sessionBadge, sessionColor)}
  <text x="12" y="28" font-family="Arial, Helvetica, sans-serif" font-size="${nameFontSize}" font-weight="bold" fill="${COLOR_TEXT}">${escapeXml(displayName)}</text>
  <text x="12" y="44" font-family="Arial, Helvetica, sans-serif" font-size="11" fill="${COLOR_TEXT_SUBTLE}">${market === "domestic" ? "국내 시세" : "미국 시세"}</text>
  <text x="72" y="76" font-family="Arial, Helvetica, sans-serif" font-size="16" fill="${COLOR_TEXT}" text-anchor="middle">초기화 중</text>
  <text x="72" y="96" font-family="Arial, Helvetica, sans-serif" font-size="11" fill="${COLOR_TEXT_MUTED}" text-anchor="middle">REST/실시간 연결 준비</text>
 </svg>`;
}

// @MX:NOTE: [AUTO] SPEC-UI-001에서 ErrorType 기반으로 시그니처 변경 (기존: string message). 호출 사이트 0개였으므로 하위 호환성 없음
// @MX:SPEC: SPEC-UI-001 REQ-UI-001-3.1, REQ-UI-001-3.2
/**
 * 에러 상태 화면 (ErrorType 기반)
 *
 * 에러 카드에는 연결 바를 표시하지 않습니다 (REQ-UI-001-3.2).
 */
export function renderErrorCard(errorType: ErrorType): string {
  const errorMap: Record<ErrorType, { icon: string; label: string }> = {
    [ErrorType.NO_CREDENTIAL]: { icon: "⚙", label: "설정 필요" },
    [ErrorType.AUTH_FAIL]: { icon: "✕", label: "인증 실패" },
    [ErrorType.NETWORK_ERROR]: { icon: "!", label: "연결 오류" },
    [ErrorType.INVALID_STOCK]: { icon: "?", label: "종목 오류" },
  };
  const { icon, label } = errorMap[errorType];

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_SIZE}" height="${CARD_SIZE}" viewBox="0 0 ${CARD_SIZE} ${CARD_SIZE}">
  <rect width="${CARD_SIZE}" height="${CARD_SIZE}" rx="${BG_RADIUS}" fill="${BG_COLOR}"/>
  <text x="72" y="62" font-family="Arial, Helvetica, sans-serif" font-size="36" fill="${COLOR_FALL}" text-anchor="middle">${icon}</text>
  <text x="72" y="94" font-family="Arial, Helvetica, sans-serif" font-size="16" fill="${COLOR_TEXT}" text-anchor="middle">${escapeXml(label)}</text>
  <text x="72" y="114" font-family="Arial, Helvetica, sans-serif" font-size="11" fill="${COLOR_TEXT_MUTED}" text-anchor="middle">Property Inspector를 확인하세요</text>
 </svg>`;
}

/**
 * 연결 회복 알림 카드 (2초 임시 표시)
 *
 * BROKEN/BACKUP → LIVE 전환 시 표시됩니다 (REQ-UI-001-7.1).
 */
export function renderRecoveryCard(name: string): string {
  const displayName = truncateName(name || "---", 8);
  const nameFontSize = getNameFontSize(displayName);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_SIZE}" height="${CARD_SIZE}" viewBox="0 0 ${CARD_SIZE} ${CARD_SIZE}">
  <rect width="${CARD_SIZE}" height="${CARD_SIZE}" rx="${BG_RADIUS}" fill="#1b4332"/>
  <text x="12" y="28" font-family="Arial, Helvetica, sans-serif" font-size="${nameFontSize}" font-weight="bold" fill="${COLOR_TEXT}">${escapeXml(displayName)}</text>
  <text x="12" y="44" font-family="Arial, Helvetica, sans-serif" font-size="11" fill="#9ad1a7">실시간 복구</text>
  <text x="72" y="72" font-family="Arial, Helvetica, sans-serif" font-size="32" fill="${COLOR_RISE}" text-anchor="middle">✓</text>
  <text x="72" y="102" font-family="Arial, Helvetica, sans-serif" font-size="14" fill="${COLOR_RISE}" text-anchor="middle">연결 회복</text>
  <rect x="${CONNECTION_LINE_X}" y="${CONNECTION_LINE_Y}" width="${CONNECTION_LINE_WIDTH}" height="${CONNECTION_LINE_HEIGHT}" rx="2" fill="${COLOR_CONN_LIVE}" />
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
  const sessionBadge = getSessionBadgeLabel(session);
  const statusText = session === "CLOSED" ? "장 마감" : "데이터 대기";
  const statusColor = session === "CLOSED" ? COLOR_TEXT_SUBTLE : COLOR_TEXT;
  const displayName = truncateName(name || "---", 8);
  const nameFontSize = getNameFontSize(displayName);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_SIZE}" height="${CARD_SIZE}" viewBox="0 0 ${CARD_SIZE} ${CARD_SIZE}">
  <rect width="${CARD_SIZE}" height="${CARD_SIZE}" rx="${BG_RADIUS}" fill="${BG_COLOR}"/>
  ${renderSessionPill(sessionBadge, sessionColor)}
  <text x="12" y="28" font-family="Arial, Helvetica, sans-serif" font-size="${nameFontSize}" font-weight="bold" fill="${COLOR_TEXT}">${escapeXml(displayName)}</text>
  <text x="12" y="44" font-family="Arial, Helvetica, sans-serif" font-size="11" fill="${COLOR_TEXT_SUBTLE}">${market === "domestic" ? "국내 시세" : "미국 시세"}</text>
  <text x="72" y="74" font-family="Arial, Helvetica, sans-serif" font-size="16" fill="${statusColor}" text-anchor="middle">${statusText}</text>
  <text x="72" y="98" font-family="Arial, Helvetica, sans-serif" font-size="12" fill="${COLOR_CONN_LIVE}" text-anchor="middle">실시간 연결됨</text>
  <rect x="${CONNECTION_LINE_X}" y="${CONNECTION_LINE_Y}" width="${CONNECTION_LINE_WIDTH}" height="${CONNECTION_LINE_HEIGHT}" rx="2" fill="${COLOR_CONN_LIVE}" />
</svg>`;
}

/**
 * 설정 필요 화면
 */
export function renderSetupCard(message: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_SIZE}" height="${CARD_SIZE}" viewBox="0 0 ${CARD_SIZE} ${CARD_SIZE}">
  <rect width="${CARD_SIZE}" height="${CARD_SIZE}" rx="${BG_RADIUS}" fill="${BG_COLOR}"/>
  <text x="72" y="58" font-family="Arial, Helvetica, sans-serif" font-size="16" fill="${COLOR_SESSION_OTHER}" text-anchor="middle">설정 필요</text>
  <text x="72" y="84" font-family="Arial, Helvetica, sans-serif" font-size="13" fill="${COLOR_TEXT}" text-anchor="middle">${escapeXml(message)}</text>
  <text x="72" y="104" font-family="Arial, Helvetica, sans-serif" font-size="11" fill="${COLOR_TEXT_MUTED}" text-anchor="middle">Property Inspector에서 입력</text>
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
  const sessionBadge = getSessionBadgeLabel(session);

  // 포맷된 문자열
  const priceStr = formatPrice(data.price, market);
  const changeStr = formatChangeWithArrow(data.change, data.sign, market);
  const rateStr = formatChangeRate(data.changeRate);
  const priceFontSize = getPriceFontSize(priceStr);

  // 종목명 (길이 제한)
  const displayName = truncateName(data.name, 8);
  const nameFontSize = getNameFontSize(displayName);
  const tickerLabel = truncateName(data.ticker.toUpperCase(), 10);
  const statusText = getConnectionStatusText(
    connectionState,
    renderOptions.isStale ?? false,
    renderOptions.isRefreshing ?? false
  );
  const statusColor = getConnectionTextColor(
    connectionState,
    renderOptions.isRefreshing ?? false
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_SIZE}" height="${CARD_SIZE}" viewBox="0 0 ${CARD_SIZE} ${CARD_SIZE}">
  <rect width="${CARD_SIZE}" height="${CARD_SIZE}" rx="${BG_RADIUS}" fill="${BG_COLOR}"/>

  ${renderSessionPill(sessionBadge, sessionColor)}
  <text x="12" y="28" font-family="Arial, Helvetica, sans-serif" font-size="${nameFontSize}" font-weight="bold" fill="${titleColor}">${escapeXml(displayName)}</text>
  <text x="12" y="44" font-family="Arial, Helvetica, sans-serif" font-size="11" fill="${COLOR_TEXT_SUBTLE}">${escapeXml(tickerLabel)}</text>

  <!-- 현재가 (중앙) -->
  <text x="72" y="78" font-family="Arial, Helvetica, sans-serif" font-size="${priceFontSize}" font-weight="bold" fill="${COLOR_TEXT}" text-anchor="middle">${escapeXml(priceStr)}</text>

  <!-- 변동량 + 화살표 (좌측 하단) -->
  <text x="12" y="108" font-family="Arial, Helvetica, sans-serif" font-size="14" fill="${changeColor}">${escapeXml(changeStr)}</text>

  <!-- 변동률 (우측 하단) -->
  <text x="132" y="108" font-family="Arial, Helvetica, sans-serif" font-size="14" fill="${changeColor}" text-anchor="end">${escapeXml(rateStr)}</text>
  ${statusText ? `<text x="72" y="124" font-family="Arial, Helvetica, sans-serif" font-size="11" fill="${statusColor}" text-anchor="middle">${escapeXml(statusText)}</text>` : ""}
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

function getConnectionTextColor(
  connectionState: StreamConnectionState | null | undefined,
  isRefreshing: boolean
): string {
  if (isRefreshing) return COLOR_TEXT_STALE;

  switch (connectionState) {
    case "LIVE":
      return COLOR_CONN_LIVE;
    case "BACKUP":
      return COLOR_CONN_BACKUP;
    case "BROKEN":
      return COLOR_CONN_BROKEN;
    default:
      return COLOR_TEXT_MUTED;
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

function getSessionBadgeLabel(session: MarketSession): string {
  switch (session) {
    case "REG":
      return "정규";
    case "PRE":
      return "프리";
    case "AFT":
      return "애프터";
    case "CLOSED":
      return "마감";
    default:
      return "마감";
  }
}

function getConnectionStatusText(
  connectionState: StreamConnectionState | null | undefined,
  isStale: boolean,
  isRefreshing: boolean
): string | null {
  if (isRefreshing) return "새로고침 중";

  switch (connectionState) {
    case "LIVE":
      return "실시간";
    case "BROKEN":
      return "연결 끊김";
    case "BACKUP":
      return isStale ? "백업 · 지연" : "백업";
    default:
      return isStale ? "지연" : null;
  }
}

function getNameFontSize(name: string): number {
  const len = name.length;
  if (len <= 6) return 20;
  if (len <= 8) return 18;
  return 16;
}

function renderSessionPill(label: string, color: string): string {
  return `<rect x="${SESSION_PILL_X}" y="${SESSION_PILL_Y}" width="${SESSION_PILL_WIDTH}" height="${SESSION_PILL_HEIGHT}" rx="9" fill="rgba(255,255,255,0.08)" stroke="${color}" stroke-width="1" />
  <text x="${SESSION_PILL_X + SESSION_PILL_WIDTH / 2}" y="${SESSION_PILL_Y + 12}" font-family="Arial, Helvetica, sans-serif" font-size="9" font-weight="bold" fill="${color}" text-anchor="middle">${escapeXml(label)}</text>`;
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
