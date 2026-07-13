import type {
  StockData,
  MarketSession,
  Market,
  StreamConnectionState,
  StockCardRenderOptions,
} from "../types/index.js";
import { ErrorType } from "../types/index.js";
import type { StockActionView } from "../actions/stock-action-controller.js";
import type { KisErrorCode } from "../core/errors.js";
import type { QuoteSample } from "../markets/market-adapter.js";
import {
  getETDayOfWeek,
  getETTotalMinutes,
  getKSTDayOfWeek,
  getKSTTotalMinutes,
} from "../utils/timezone.js";

// ─── 디자인 상수 ───
const CARD_SIZE = 144;
const BG_COLOR = "#1a1a2e";
const BG_RADIUS = 12;

const COLOR_RISE = "#00c853"; // 상승 (초록)
const COLOR_FALL = "#ff1744"; // 하락 (빨강)
const COLOR_FLAT = "#9e9e9e"; // 보합 (회색)
const COLOR_TEXT = "#ffffff"; // 기본 텍스트
const COLOR_TEXT_STALE = "#ffd54f"; // 지연/새로고침 상태 문구 (노랑)
const COLOR_SESSION_REG = "#00c853"; // 정규장 (초록)
const COLOR_SESSION_OTHER = "#ff9800"; // 프리/에프터 (주황)
const COLOR_SESSION_CLOSED = "#616161"; // 장 마감 (어두운 회색)
const COLOR_CONN_LIVE = "#00c853";
const COLOR_CONN_BACKUP = "#7dd3fc";
const COLOR_CONN_BROKEN = "#ff1744";
const COLOR_TEXT_SUBTLE = "#a6b0cf";
const COLOR_TEXT_MUTED = "#7f8aa8";
const COLOR_LOADING = "#7dd3fc";

const SESSION_PILL_X = 94;
const SESSION_PILL_Y = 14;
const SESSION_PILL_WIDTH = 38;
const SESSION_PILL_HEIGHT = 18;
const CONNECTION_TITLE_DOT_X = 6;
const CONNECTION_TITLE_DOT_Y = 22;
const CONNECTION_TITLE_DOT_RADIUS = 3;
const CONNECTION_TITLE_TEXT_X = 12;
const CONNECTION_TITLE_TEXT_Y = 28;

const ARROW_UP = "\u25B2"; // ▲
const ARROW_DOWN = "\u25BC"; // ▼
const SVG_DATA_URI_CACHE_MAX_ENTRIES = 500;
const SVG_DATA_URI_CACHE_MAX_SVG_CHARS = 256 * 1024;
const MAX_ACTION_ID_LENGTH = 128;
const MAX_INSTRUMENT_NAME_LENGTH = 64;
const MAX_SYMBOL_LENGTH = 32;
const MAX_ERROR_MESSAGE_LENGTH = 512;
const MAX_PRICE = 1_000_000_000_000_000;
const MAX_ABSOLUTE_CHANGE_RATE = 100_000;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;

const VIEW_KEYS = new Set([
  "actionId",
  "instrument",
  "session",
  "quote",
  "connection",
  "stale",
  "refreshing",
  "recovery",
  "error",
]);
const INSTRUMENT_KEYS = new Set(["symbol", "name", "market"]);
const QUOTE_KEYS = new Set([
  "symbol",
  "price",
  "changeRate",
  "sign",
  "source",
  "receivedAt",
  "sessionEpoch",
]);
const ERROR_KEYS = new Set(["code", "message"]);
const ERROR_CODES = new Set<KisErrorCode>([
  "NO_CREDENTIALS",
  "AUTH_REJECTED",
  "AUTH_RATE_LIMITED",
  "NETWORK",
  "TIMEOUT",
  "INVALID_INSTRUMENT",
  "PROTOCOL",
  "SUBSCRIPTION_REJECTED",
  "SETTINGS",
]);

// Intl 객체 생성 비용을 줄이기 위해 재사용합니다.
const KR_INT_FORMAT = new Intl.NumberFormat("ko-KR", {
  maximumFractionDigits: 0,
});

const svgDataUriCache = new Map<string, string>();

export function getStockCardCacheDiagnostics(): { readonly entries: number } {
  return Object.freeze({ entries: svgDataUriCache.size });
}

// ─── 장 상태 판단 ───

/**
 * 국내주식 장 상태 판단 (KST 기준)
 */
function getDomesticSession(): MarketSession {
  if (isWeekend(getKSTDayOfWeek())) {
    return "CLOSED";
  }

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
  if (isWeekend(getETDayOfWeek())) {
    return "CLOSED";
  }

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

interface SafeStockActionView {
  readonly instrument: {
    readonly symbol: string;
    readonly name: string;
    readonly market: Market;
  };
  readonly session: MarketSession;
  readonly quote?: QuoteSample;
  readonly connection: "LIVE" | "BACKUP" | "BROKEN" | "waiting";
  readonly stale: boolean;
  readonly refreshing: boolean;
  readonly recovery: boolean;
  readonly error?: {
    readonly code: KisErrorCode;
  };
}

interface SafeRecord {
  readonly [key: string]: unknown;
}

/**
 * StockActionController와 SVG 경계 사이에서 accessor/proxy를 실행하지 않고
 * 불변 화면 스냅샷을 만듭니다. 화면 모델 밖의 필드는 의도적으로 거부합니다.
 */
function snapshotDataRecord(
  input: unknown,
  allowedKeys: ReadonlySet<string>,
): SafeRecord | undefined {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return undefined;
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return undefined;

    const keys = Reflect.ownKeys(input);
    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== "string" || !allowedKeys.has(key)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return undefined;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return undefined;
  }
}

function isBoundedText(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
): value is string {
  return typeof value === "string" &&
    value.length >= minimumLength &&
    value.length <= maximumLength &&
    !CONTROL_CHARACTER_PATTERN.test(value);
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0;
}

function snapshotStockActionView(input: unknown): SafeStockActionView | undefined {
  const source = snapshotDataRecord(input, VIEW_KEYS);
  if (!source) return undefined;
  if (
    !isBoundedText(source.actionId, 1, MAX_ACTION_ID_LENGTH) ||
    !["PRE", "REG", "AFT", "CLOSED"].includes(source.session as string) ||
    !["LIVE", "BACKUP", "BROKEN", "waiting"].includes(source.connection as string) ||
    typeof source.stale !== "boolean" ||
    typeof source.refreshing !== "boolean" ||
    typeof source.recovery !== "boolean"
  ) return undefined;

  const instrumentSource = snapshotDataRecord(source.instrument, INSTRUMENT_KEYS);
  if (!instrumentSource ||
    !isBoundedText(instrumentSource.symbol, 0, MAX_SYMBOL_LENGTH) ||
    !isBoundedText(instrumentSource.name, 1, MAX_INSTRUMENT_NAME_LENGTH) ||
    (instrumentSource.market !== "domestic" && instrumentSource.market !== "overseas")
  ) return undefined;

  let error: SafeStockActionView["error"];
  if (source.error !== undefined) {
    const errorSource = snapshotDataRecord(source.error, ERROR_KEYS);
    if (!errorSource ||
      typeof errorSource.code !== "string" ||
      !ERROR_CODES.has(errorSource.code as KisErrorCode) ||
      !isBoundedText(errorSource.message, 0, MAX_ERROR_MESSAGE_LENGTH)
    ) return undefined;
    error = Object.freeze({ code: errorSource.code as KisErrorCode });
  }

  let quote: QuoteSample | undefined;
  if (source.quote !== undefined) {
    const quoteSource = snapshotDataRecord(source.quote, QUOTE_KEYS);
    if (!quoteSource ||
      !isBoundedText(quoteSource.symbol, 1, MAX_SYMBOL_LENGTH) ||
      quoteSource.symbol !== instrumentSource.symbol ||
      typeof quoteSource.price !== "number" ||
      !Number.isFinite(quoteSource.price) ||
      quoteSource.price < 0 ||
      quoteSource.price > MAX_PRICE ||
      typeof quoteSource.changeRate !== "number" ||
      !Number.isFinite(quoteSource.changeRate) ||
      Math.abs(quoteSource.changeRate) > MAX_ABSOLUTE_CHANGE_RATE ||
      (quoteSource.sign !== "rise" && quoteSource.sign !== "fall" && quoteSource.sign !== "flat") ||
      (quoteSource.source !== "websocket" && quoteSource.source !== "rest") ||
      !isSafeTimestamp(quoteSource.receivedAt) ||
      !isSafeTimestamp(quoteSource.sessionEpoch)
    ) return undefined;

    quote = Object.freeze({
      symbol: quoteSource.symbol,
      price: quoteSource.price,
      changeRate: quoteSource.changeRate,
      sign: quoteSource.sign,
      source: quoteSource.source,
      receivedAt: quoteSource.receivedAt,
      sessionEpoch: quoteSource.sessionEpoch,
    });
  }

  if (!error && instrumentSource.symbol.length === 0) return undefined;

  return Object.freeze({
    instrument: Object.freeze({
      symbol: instrumentSource.symbol,
      name: instrumentSource.name,
      market: instrumentSource.market,
    }),
    session: source.session as MarketSession,
    ...(quote ? { quote } : {}),
    connection: source.connection as SafeStockActionView["connection"],
    stale: source.stale,
    refreshing: source.refreshing,
    recovery: source.recovery,
    ...(error ? { error } : {}),
  });
}

function formatSignedChangeRate(rate: number, sign: QuoteSample["sign"]): string {
  const amount = Math.abs(rate).toFixed(2);
  if (sign === "rise") return `${ARROW_UP} +${amount}%`;
  if (sign === "fall") return `${ARROW_DOWN} -${amount}%`;
  return `${amount}%`;
}

function getConnectionTitleColor(
  connection: SafeStockActionView["connection"] | null | undefined,
): string {
  switch (connection) {
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

function renderConnectionTitle(displayName: string, fontSize: number, color: string): string {
  return `<circle data-role="connection-dot" cx="${CONNECTION_TITLE_DOT_X}" cy="${CONNECTION_TITLE_DOT_Y}" r="${CONNECTION_TITLE_DOT_RADIUS}" fill="${color}" />
  <text data-role="stock-name" x="${CONNECTION_TITLE_TEXT_X}" y="${CONNECTION_TITLE_TEXT_Y}" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="bold" fill="${color}">${escapeXml(displayName)}</text>`;
}

function renderInvalidStockActionView(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_SIZE}" height="${CARD_SIZE}" viewBox="0 0 ${CARD_SIZE} ${CARD_SIZE}">
  <rect width="${CARD_SIZE}" height="${CARD_SIZE}" rx="${BG_RADIUS}" fill="${BG_COLOR}"/>
  <text x="72" y="64" font-family="Arial, Helvetica, sans-serif" font-size="30" fill="${COLOR_FALL}" text-anchor="middle">!</text>
  <text x="72" y="94" font-family="Arial, Helvetica, sans-serif" font-size="16" fill="${COLOR_TEXT}" text-anchor="middle">표시 오류</text>
  <text x="72" y="114" font-family="Arial, Helvetica, sans-serif" font-size="11" fill="${COLOR_TEXT_MUTED}" text-anchor="middle">화면 데이터를 확인하세요</text>
</svg>`;
}

function renderStockActionError(view: SafeStockActionView): string {
  const copy: Record<KisErrorCode, { icon: string; label: string; hint: string }> = {
    NO_CREDENTIALS: { icon: "⚙", label: "설정 필요", hint: "API 키를 입력하세요" },
    SETTINGS: { icon: "⚙", label: "설정 오류", hint: "설정을 확인하세요" },
    AUTH_REJECTED: { icon: "✕", label: "인증 실패", hint: "API 키를 확인하세요" },
    AUTH_RATE_LIMITED: { icon: "…", label: "인증 지연", hint: "잠시 후 재시도" },
    NETWORK: { icon: "!", label: "연결 오류", hint: "네트워크를 확인하세요" },
    TIMEOUT: { icon: "!", label: "시간 초과", hint: "잠시 후 재시도" },
    INVALID_INSTRUMENT: { icon: "?", label: "종목 오류", hint: "종목을 확인하세요" },
    PROTOCOL: { icon: "!", label: "응답 오류", hint: "잠시 후 재시도" },
    SUBSCRIPTION_REJECTED: { icon: "!", label: "구독 오류", hint: "REST 백업 확인" },
  };
  const errorCopy = copy[view.error!.code];
  const sessionColor = getSessionColor(view.session);
  const displayName = truncateName(view.instrument.name, 8);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_SIZE}" height="${CARD_SIZE}" viewBox="0 0 ${CARD_SIZE} ${CARD_SIZE}">
  <rect width="${CARD_SIZE}" height="${CARD_SIZE}" rx="${BG_RADIUS}" fill="${BG_COLOR}"/>
  ${renderSessionPill(getSessionBadgeLabel(view.session), sessionColor)}
  ${renderConnectionTitle(displayName, getNameFontSize(displayName), getConnectionTitleColor("BROKEN"))}
  <text x="72" y="68" font-family="Arial, Helvetica, sans-serif" font-size="28" fill="${COLOR_FALL}" text-anchor="middle">${errorCopy.icon}</text>
  <text x="72" y="96" font-family="Arial, Helvetica, sans-serif" font-size="16" fill="${COLOR_TEXT}" text-anchor="middle">${errorCopy.label}</text>
  <text x="72" y="116" font-family="Arial, Helvetica, sans-serif" font-size="11" fill="${COLOR_TEXT_MUTED}" text-anchor="middle">${errorCopy.hint}</text>
</svg>`;
}

function renderStockActionWaiting(view: SafeStockActionView): string {
  const displayName = truncateName(view.instrument.name, 8);
  const status = view.connection === "BROKEN" ? "연결 대기" : "데이터 대기";
  const stateColor = view.connection === "BROKEN" ? COLOR_CONN_BROKEN : COLOR_TEXT_MUTED;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_SIZE}" height="${CARD_SIZE}" viewBox="0 0 ${CARD_SIZE} ${CARD_SIZE}">
  <rect width="${CARD_SIZE}" height="${CARD_SIZE}" rx="${BG_RADIUS}" fill="${BG_COLOR}"/>
  ${renderSessionPill(getSessionBadgeLabel(view.session), getSessionColor(view.session))}
  ${renderConnectionTitle(displayName, getNameFontSize(displayName), getConnectionTitleColor(view.connection))}
  <text x="12" y="44" font-family="Arial, Helvetica, sans-serif" font-size="11" fill="${COLOR_TEXT_SUBTLE}">${escapeXml(truncateName(view.instrument.symbol.toUpperCase(), 10))}</text>
  ${view.connection === "BROKEN" ? "" : renderLoadingIndicator(72, 72, 22)}
  <text x="72" y="104" font-family="Arial, Helvetica, sans-serif" font-size="16" fill="${stateColor}" text-anchor="middle">${status}</text>
  <text x="72" y="122" font-family="Arial, Helvetica, sans-serif" font-size="11" fill="${COLOR_TEXT_MUTED}" text-anchor="middle">${view.session === "CLOSED" ? "장 마감 시세 준비" : "시세 연결 준비"}</text>
</svg>`;
}

function renderStockActionRecovery(view: SafeStockActionView): string {
  const displayName = truncateName(view.instrument.name, 8);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_SIZE}" height="${CARD_SIZE}" viewBox="0 0 ${CARD_SIZE} ${CARD_SIZE}">
  <rect width="${CARD_SIZE}" height="${CARD_SIZE}" rx="${BG_RADIUS}" fill="#1b4332"/>
  ${renderSessionPill(getSessionBadgeLabel(view.session), getSessionColor(view.session))}
  ${renderConnectionTitle(displayName, getNameFontSize(displayName), getConnectionTitleColor("LIVE"))}
  <text x="12" y="44" font-family="Arial, Helvetica, sans-serif" font-size="11" fill="#9ad1a7">연결 상태</text>
  <text x="72" y="80" font-family="Arial, Helvetica, sans-serif" font-size="32" fill="${COLOR_RISE}" text-anchor="middle">✓</text>
  <text x="72" y="108" font-family="Arial, Helvetica, sans-serif" font-size="15" fill="${COLOR_RISE}" text-anchor="middle">연결 회복</text>
</svg>`;
}

function renderStockActionQuote(view: SafeStockActionView): string {
  const quote = view.quote!;
  const displayName = truncateName(view.instrument.name, 8);
  const priceText = formatPrice(quote.price, view.instrument.market);
  const rateText = formatSignedChangeRate(quote.changeRate, quote.sign);
  const changeColor = getSignColor(quote.sign);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_SIZE}" height="${CARD_SIZE}" viewBox="0 0 ${CARD_SIZE} ${CARD_SIZE}">
  <rect width="${CARD_SIZE}" height="${CARD_SIZE}" rx="${BG_RADIUS}" fill="${BG_COLOR}"/>
  ${renderSessionPill(getSessionBadgeLabel(view.session), getSessionColor(view.session))}
  ${renderConnectionTitle(displayName, getNameFontSize(displayName), getConnectionTitleColor(view.connection))}
  <text x="12" y="44" font-family="Arial, Helvetica, sans-serif" font-size="11" fill="${COLOR_TEXT_SUBTLE}">${escapeXml(truncateName(view.instrument.symbol.toUpperCase(), 10))}</text>
  <text x="72" y="82" font-family="Arial, Helvetica, sans-serif" font-size="${getPriceFontSize(priceText)}" font-weight="bold" fill="${COLOR_TEXT}" text-anchor="middle">${escapeXml(priceText)}</text>
  <text x="72" y="116" font-family="Arial, Helvetica, sans-serif" font-size="15" font-weight="bold" fill="${changeColor}" text-anchor="middle">${escapeXml(rateText)}</text>
</svg>`;
}

/**
 * 상태 머신이 확정한 StockActionView만으로 144×144 SVG를 생성합니다.
 * 현재 시각이나 외부 전역 상태를 읽지 않으므로 동일한 화면 모델은 항상
 * 동일한 SVG를 생성합니다.
 */
export function renderStockActionView(view: StockActionView): string {
  const snapshot = snapshotStockActionView(view);
  if (!snapshot) return renderInvalidStockActionView();
  if (snapshot.error) return renderStockActionError(snapshot);
  if (snapshot.recovery) return renderStockActionRecovery(snapshot);
  if (!snapshot.quote) return renderStockActionWaiting(snapshot);
  return renderStockActionQuote(snapshot);
}

/** StockActionView를 바로 Stream Deck setImage용 Data URI로 변환합니다. */
export function renderStockActionViewDataUri(view: StockActionView): string {
  return svgToDataUri(renderStockActionView(view));
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
  ${renderConnectionTitle(displayName, nameFontSize, getConnectionTitleColor(undefined))}
  <text x="12" y="44" font-family="Arial, Helvetica, sans-serif" font-size="11" fill="${COLOR_TEXT_SUBTLE}">${market === "domestic" ? "국내 시세" : "미국 시세"}</text>
  ${renderLoadingIndicator(72, 70, 22)}
  <text x="72" y="102" font-family="Arial, Helvetica, sans-serif" font-size="16" fill="${COLOR_TEXT}" text-anchor="middle">초기화 중</text>
  <text x="72" y="120" font-family="Arial, Helvetica, sans-serif" font-size="11" fill="${COLOR_TEXT_MUTED}" text-anchor="middle">REST/실시간 연결 준비</text>
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
  ${renderConnectionTitle(displayName, nameFontSize, getConnectionTitleColor("LIVE"))}
  <text x="12" y="44" font-family="Arial, Helvetica, sans-serif" font-size="11" fill="#9ad1a7">실시간 복구</text>
  <text x="72" y="72" font-family="Arial, Helvetica, sans-serif" font-size="32" fill="${COLOR_RISE}" text-anchor="middle">✓</text>
  <text x="72" y="102" font-family="Arial, Helvetica, sans-serif" font-size="14" fill="${COLOR_RISE}" text-anchor="middle">연결 회복</text>
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
  const connectionState = session === "CLOSED" ? "BACKUP" : "LIVE";
  const connectionColor = getConnectionTitleColor(connectionState);
  const connectionText = session === "CLOSED" ? "정상 대기" : "실시간 연결됨";
  const loadingMarkup =
    session === "CLOSED" ? "" : renderLoadingIndicator(72, 68, 18, COLOR_CONN_LIVE);
  const displayName = truncateName(name || "---", 8);
  const nameFontSize = getNameFontSize(displayName);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_SIZE}" height="${CARD_SIZE}" viewBox="0 0 ${CARD_SIZE} ${CARD_SIZE}">
  <rect width="${CARD_SIZE}" height="${CARD_SIZE}" rx="${BG_RADIUS}" fill="${BG_COLOR}"/>
  ${renderSessionPill(sessionBadge, sessionColor)}
  ${renderConnectionTitle(displayName, nameFontSize, connectionColor)}
  <text x="12" y="44" font-family="Arial, Helvetica, sans-serif" font-size="11" fill="${COLOR_TEXT_SUBTLE}">${market === "domestic" ? "국내 시세" : "미국 시세"}</text>
  ${loadingMarkup}
  <text x="72" y="${session === "CLOSED" ? "78" : "100"}" font-family="Arial, Helvetica, sans-serif" font-size="16" fill="${statusColor}" text-anchor="middle">${statusText}</text>
  <text x="72" y="${session === "CLOSED" ? "102" : "120"}" font-family="Arial, Helvetica, sans-serif" font-size="12" fill="${connectionColor}" text-anchor="middle">${connectionText}</text>
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
  const connectionState = renderOptions.connectionState;
  const titleColor = getConnectionTitleColor(connectionState);
  const effectiveRefreshing =
    connectionState !== "BROKEN" && (renderOptions.isRefreshing ?? false);
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
    effectiveRefreshing,
  );
  const statusColor = getConnectionTextColor(
    connectionState,
    renderOptions.isStale ?? false,
    effectiveRefreshing,
  );
  const statusMarkup = renderStatusLabel(
    statusText,
    statusColor,
    effectiveRefreshing,
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_SIZE}" height="${CARD_SIZE}" viewBox="0 0 ${CARD_SIZE} ${CARD_SIZE}">
  <rect width="${CARD_SIZE}" height="${CARD_SIZE}" rx="${BG_RADIUS}" fill="${BG_COLOR}"/>

  ${renderSessionPill(sessionBadge, sessionColor)}
  ${renderConnectionTitle(displayName, nameFontSize, titleColor)}
  <text x="12" y="44" font-family="Arial, Helvetica, sans-serif" font-size="11" fill="${COLOR_TEXT_SUBTLE}">${escapeXml(tickerLabel)}</text>

  <!-- 현재가 (중앙) -->
  <text x="72" y="78" font-family="Arial, Helvetica, sans-serif" font-size="${priceFontSize}" font-weight="bold" fill="${COLOR_TEXT}" text-anchor="middle">${escapeXml(priceStr)}</text>

  <!-- 변동량 + 화살표 (좌측 하단) -->
  <text x="12" y="108" font-family="Arial, Helvetica, sans-serif" font-size="14" fill="${changeColor}">${escapeXml(changeStr)}</text>

  <!-- 변동률 (우측 하단) -->
  <text x="132" y="108" font-family="Arial, Helvetica, sans-serif" font-size="14" fill="${changeColor}" text-anchor="end">${escapeXml(rateStr)}</text>
  ${statusMarkup}
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
  isStale: boolean,
  isRefreshing: boolean
): string {
  if (connectionState === "BROKEN") return COLOR_CONN_BROKEN;
  if (isRefreshing || isStale) return COLOR_TEXT_STALE;

  switch (connectionState) {
    case "LIVE":
      return COLOR_CONN_LIVE;
    case "BACKUP":
      return COLOR_CONN_BACKUP;
    default:
      return COLOR_TEXT_MUTED;
  }
}

function isWeekend(weekday: number): boolean {
  return weekday === 0 || weekday === 6;
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
  if (connectionState === "BROKEN") return "연결 확인 필요";
  if (isRefreshing) return "새로고침 중";
  if (isStale) {
    if (connectionState === "BACKUP") return "백업 · 지연";
    if (connectionState === "LIVE") return "시세 지연";
    return "지연";
  }

  switch (connectionState) {
    case "LIVE":
      return "실시간";
    case "BACKUP":
      return "백업";
    default:
      return null;
  }
}

function renderStatusLabel(
  statusText: string | null,
  statusColor: string,
  isRefreshing: boolean,
): string {
  if (!statusText) {
    return "";
  }

  if (!isRefreshing) {
    return `<text x="72" y="124" font-family="Arial, Helvetica, sans-serif" font-size="11" fill="${statusColor}" text-anchor="middle">${escapeXml(statusText)}</text>`;
  }

  return `<g>
  ${renderLoadingIndicator(44, 120, 10, statusColor)}
  <text x="54" y="124" font-family="Arial, Helvetica, sans-serif" font-size="11" fill="${statusColor}" text-anchor="start">${escapeXml(statusText)}</text>
</g>`;
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

function renderLoadingIndicator(
  cx: number,
  cy: number,
  size: number,
  color = COLOR_LOADING,
): string {
  const radius = size / 2;
  const strokeWidth = Math.max(2, Math.round(size * 0.18));
  const arcRadius = radius - strokeWidth / 2;
  const trailColor = "rgba(255,255,255,0.12)";
  const arcPath = describeArc(cx, cy, arcRadius, 220, 20);
  const dot = polarToCartesian(cx, cy, arcRadius, 20);

  return `<g data-role="loading-indicator">
  <circle cx="${cx}" cy="${cy}" r="${arcRadius}" fill="none" stroke="${trailColor}" stroke-width="${strokeWidth}" />
  <path d="${arcPath}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" />
  <circle cx="${dot.x}" cy="${dot.y}" r="${Math.max(1.5, strokeWidth / 2)}" fill="${color}" />
</g>`;
}

function describeArc(
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  endAngle: number,
): string {
  const start = polarToCartesian(cx, cy, radius, endAngle);
  const end = polarToCartesian(cx, cy, radius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";

  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} 0 ${end.x} ${end.y}`;
}

function polarToCartesian(
  cx: number,
  cy: number,
  radius: number,
  angleInDegrees: number,
): { x: number; y: number } {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180.0;

  return {
    x: cx + radius * Math.cos(angleInRadians),
    y: cy + radius * Math.sin(angleInRadians),
  };
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

// @MX:NOTE: [AUTO] The actual SVG is the cache identity. The optional legacy
// semantic key is intentionally ignored because callers cannot guarantee a 1:1
// mapping between their state key and the generated markup.
// @MX:SPEC: SPEC-PERF-001 REQ-PERF-001-2.1.1, REQ-PERF-001-2.1.3
export function svgToDataUri(svg: string, _legacySemanticKey?: string): string {
  if (svg.length > SVG_DATA_URI_CACHE_MAX_SVG_CHARS) {
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }
  const cached = svgDataUriCache.get(svg);
  if (cached) {
    // LRU 갱신: 조회된 키를 최근 사용으로 이동
    svgDataUriCache.delete(svg);
    svgDataUriCache.set(svg, cached);
    return cached;
  }

  const dataUri = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  svgDataUriCache.set(svg, dataUri);

  if (svgDataUriCache.size > SVG_DATA_URI_CACHE_MAX_ENTRIES) {
    const oldestKey = svgDataUriCache.keys().next().value;
    if (oldestKey !== undefined) {
      svgDataUriCache.delete(oldestKey);
    }
  }

  return dataUri;
}
