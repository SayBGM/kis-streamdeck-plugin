import { KisError, type KisErrorScope } from "../core/errors.js";
import { isOverseasDayTradingAt } from "../core/market-clock.js";
import {
  OVERSEAS_DAY_PREFIX,
  OVERSEAS_NIGHT_PREFIX,
  REST_TR_DOMESTIC_ETF_PRICE,
  REST_TR_DOMESTIC_PRICE,
  REST_TR_OVERSEAS_PRICE,
  TR_ID_DOMESTIC,
  TR_ID_OVERSEAS,
  type DomesticInstrumentType,
  type Market,
  type OverseasExchange,
  type PriceSign,
} from "../types/index.js";

export type CanonicalInstrumentType = DomesticInstrumentType | "overseas";
export type QuoteSource = "websocket" | "rest";

export interface CanonicalInstrument {
  readonly key: string;
  readonly market: Market;
  readonly instrumentType: CanonicalInstrumentType;
  readonly symbol: string;
  readonly displayName: string;
  readonly exchange?: OverseasExchange;
}

export interface Quote {
  readonly symbol: string;
  readonly price: number;
  readonly change: number;
  readonly changeRate: number;
  readonly sign: PriceSign;
  readonly source: QuoteSource;
  readonly receivedAt: number;
  readonly sessionEpoch: number;
}

export type QuoteSample = Quote;

export interface QuoteContext {
  readonly receivedAt: number;
  readonly sessionEpoch: number;
}

export interface KisRestDescriptor {
  readonly method: "GET";
  readonly path: string;
  readonly trId: string;
  readonly query: Readonly<Record<string, string>>;
}

export interface KisWebSocketDescriptor {
  readonly trId: string;
  readonly trKey: string;
}

export interface MarketAdapter<Settings> {
  readonly id: string;
  readonly market: Market;
  toInstrument(settings: Settings): CanonicalInstrument;
  restDescriptor(instrument: CanonicalInstrument): KisRestDescriptor;
  webSocketDescriptor(instrument: CanonicalInstrument, nowMs: number): KisWebSocketDescriptor;
  parseWebSocket(
    fields: readonly string[],
    instrument: CanonicalInstrument,
    context: QuoteContext,
  ): QuoteSample;
  parseRest(
    payload: unknown,
    instrument: CanonicalInstrument,
    context: QuoteContext,
  ): QuoteSample;
}

export interface DomesticAdapterSettings {
  readonly stockCode?: string;
  readonly stockName?: string;
  readonly instrumentType?: string;
}

export interface OverseasAdapterSettings {
  readonly ticker?: string;
  readonly stockName?: string;
  readonly exchange?: string;
}

const DOMESTIC_SYMBOL_PATTERN = /^[A-Z0-9]{6}$/;
const OVERSEAS_SYMBOL_PATTERN = /^[A-Z0-9]+(?:[.-][A-Z0-9]+)*$/;
const KIS_DECIMAL_PATTERN = /^[+-]?\d+(?:\.\d+)?$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;
const MAX_OVERSEAS_SYMBOL_LENGTH = 15;

function invalidInstrument(): KisError {
  return new KisError({
    code: "INVALID_INSTRUMENT",
    scope: "action",
    retryable: false,
    safeMessage: "종목 설정이 올바르지 않습니다.",
  });
}

function protocolError(scope: KisErrorScope): KisError {
  return new KisError({
    code: "PROTOCOL",
    scope,
    retryable: true,
    safeMessage: "시세 응답 형식이 올바르지 않습니다.",
  });
}

function ownDataValue(
  value: unknown,
  key: string,
  errorFactory: () => KisError,
): unknown {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw errorFactory();
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return undefined;
    if (!("value" in descriptor)) throw errorFactory();
    return descriptor.value;
  } catch (error) {
    if (error instanceof KisError) throw error;
    throw errorFactory();
  }
}

function optionalSettingString(settings: unknown, key: string): string | undefined {
  const value = ownDataValue(settings, key, invalidInstrument);
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalidInstrument();
  return value;
}

function normalizeDomesticSymbol(value: string | undefined): string {
  if (!value || CONTROL_CHARACTER_PATTERN.test(value)) throw invalidInstrument();
  const symbol = value.trim().toUpperCase();
  if (!DOMESTIC_SYMBOL_PATTERN.test(symbol)) throw invalidInstrument();
  return symbol;
}

function normalizeOverseasSymbol(
  value: string | undefined,
  allowOuterSpaces: boolean,
): string {
  if (!value || CONTROL_CHARACTER_PATTERN.test(value)) throw invalidInstrument();
  const symbol = (allowOuterSpaces ? value.trim() : value).toUpperCase();
  if (
    symbol.length > MAX_OVERSEAS_SYMBOL_LENGTH ||
    !OVERSEAS_SYMBOL_PATTERN.test(symbol)
  ) {
    throw invalidInstrument();
  }
  return symbol;
}

function recordValue(value: unknown, key: string, scope: KisErrorScope): unknown {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw protocolError(scope);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) throw protocolError(scope);
    return descriptor.value;
  } catch (error) {
    if (error instanceof KisError) throw error;
    throw protocolError(scope);
  }
}

function arrayValue(value: unknown, index: number, scope: KisErrorScope): unknown {
  try {
    if (!Array.isArray(value)) throw protocolError(scope);
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) throw protocolError(scope);
    return descriptor.value;
  } catch (error) {
    if (error instanceof KisError) throw error;
    throw protocolError(scope);
  }
}

function parseKisDecimal(
  value: unknown,
  scope: KisErrorScope,
  requirePositive = false,
): number {
  if (typeof value !== "string" || !KIS_DECIMAL_PATTERN.test(value)) {
    throw protocolError(scope);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (requirePositive && parsed <= 0)) {
    throw protocolError(scope);
  }
  return parsed;
}

function signFromCode(value: unknown, scope: KisErrorScope): PriceSign {
  if (typeof value !== "string" || !/^[1-5]$/.test(value)) {
    throw protocolError(scope);
  }
  const signCode = value;
  if (signCode === "1" || signCode === "2") return "rise";
  if (signCode === "4" || signCode === "5") return "fall";
  return "flat";
}

function signedValue(value: number, sign: PriceSign): number {
  if (sign === "fall") return -Math.abs(value);
  if (sign === "rise") return Math.abs(value);
  return 0;
}

function quote(
  instrument: CanonicalInstrument,
  price: number,
  change: number,
  rate: number,
  sign: PriceSign,
  source: QuoteSource,
  context: QuoteContext,
): QuoteSample {
  const scope = source === "rest" ? "rest" : "websocket";
  const receivedAt = ownDataValue(context, "receivedAt", () => protocolError(scope));
  const sessionEpoch = ownDataValue(context, "sessionEpoch", () => protocolError(scope));
  if (
    typeof receivedAt !== "number" ||
    !Number.isFinite(receivedAt) ||
    typeof sessionEpoch !== "number" ||
    !Number.isFinite(sessionEpoch)
  ) throw protocolError(scope);
  return Object.freeze({
    symbol: instrument.symbol,
    price,
    change: signedValue(change, sign),
    changeRate: signedValue(rate, sign),
    sign,
    source,
    receivedAt,
    sessionEpoch,
  });
}

function validateDomesticInstrument(
  value: unknown,
  expectedType: DomesticInstrumentType,
): CanonicalInstrument {
  const market = ownDataValue(value, "market", invalidInstrument);
  const instrumentType = ownDataValue(value, "instrumentType", invalidInstrument);
  const symbolValue = ownDataValue(value, "symbol", invalidInstrument);
  const displayName = ownDataValue(value, "displayName", invalidInstrument);
  const key = ownDataValue(value, "key", invalidInstrument);
  if (
    market !== "domestic" ||
    instrumentType !== expectedType ||
    typeof symbolValue !== "string" ||
    !DOMESTIC_SYMBOL_PATTERN.test(symbolValue) ||
    typeof displayName !== "string" ||
    displayName.length === 0 ||
    key !== `domestic:${expectedType}:${symbolValue}`
  ) throw invalidInstrument();

  return Object.freeze({
    key,
    market,
    instrumentType,
    symbol: symbolValue,
    displayName,
  }) as CanonicalInstrument;
}

function validateOverseasInstrument(value: unknown): CanonicalInstrument {
  const market = ownDataValue(value, "market", invalidInstrument);
  const instrumentType = ownDataValue(value, "instrumentType", invalidInstrument);
  const symbolValue = ownDataValue(value, "symbol", invalidInstrument);
  const displayName = ownDataValue(value, "displayName", invalidInstrument);
  const exchange = ownDataValue(value, "exchange", invalidInstrument);
  const key = ownDataValue(value, "key", invalidInstrument);
  if (
    market !== "overseas" ||
    instrumentType !== "overseas" ||
    typeof symbolValue !== "string" ||
    symbolValue.length > MAX_OVERSEAS_SYMBOL_LENGTH ||
    !OVERSEAS_SYMBOL_PATTERN.test(symbolValue) ||
    typeof displayName !== "string" ||
    displayName.length === 0 ||
    (exchange !== "NYS" && exchange !== "NAS" && exchange !== "AMS") ||
    key !== `overseas:${exchange}:${symbolValue}`
  ) throw invalidInstrument();

  return Object.freeze({
    key,
    market,
    instrumentType,
    symbol: symbolValue,
    displayName,
    exchange,
  }) as CanonicalInstrument;
}

class DomesticMarketAdapter implements MarketAdapter<DomesticAdapterSettings> {
  readonly market = "domestic" as const;
  readonly id: string;

  constructor(private readonly instrumentType: DomesticInstrumentType) {
    this.id = `domestic-${instrumentType}`;
  }

  toInstrument(settings: DomesticAdapterSettings): CanonicalInstrument {
    const symbol = normalizeDomesticSymbol(
      optionalSettingString(settings, "stockCode"),
    );
    const stockName = optionalSettingString(settings, "stockName");
    const displayName = stockName?.trim() || symbol;
    return Object.freeze({
      key: `domestic:${this.instrumentType}:${symbol}`,
      market: "domestic",
      instrumentType: this.instrumentType,
      symbol,
      displayName,
    });
  }

  restDescriptor(instrument: CanonicalInstrument): KisRestDescriptor {
    const validated = validateDomesticInstrument(instrument, this.instrumentType);
    const isEtf = this.instrumentType === "etf";
    return Object.freeze({
      method: "GET",
      path: isEtf
        ? "/uapi/etfetn/v1/quotations/inquire-price"
        : "/uapi/domestic-stock/v1/quotations/inquire-price",
      trId: isEtf ? REST_TR_DOMESTIC_ETF_PRICE : REST_TR_DOMESTIC_PRICE,
      query: Object.freeze({
        FID_COND_MRKT_DIV_CODE: "UN",
        FID_INPUT_ISCD: validated.symbol,
      }),
    });
  }

  webSocketDescriptor(instrument: CanonicalInstrument, _nowMs: number): KisWebSocketDescriptor {
    const validated = validateDomesticInstrument(instrument, this.instrumentType);
    return Object.freeze({ trId: TR_ID_DOMESTIC, trKey: validated.symbol });
  }

  parseWebSocket(
    fields: readonly string[],
    instrument: CanonicalInstrument,
    context: QuoteContext,
  ): QuoteSample {
    const validated = validateDomesticInstrument(instrument, this.instrumentType);
    const symbolValue = arrayValue(fields, 0, "websocket");
    if (typeof symbolValue !== "string") throw protocolError("websocket");
    const symbol = symbolValue.toUpperCase();
    if (!DOMESTIC_SYMBOL_PATTERN.test(symbol) || symbol !== validated.symbol) {
      throw protocolError("websocket");
    }
    const price = parseKisDecimal(arrayValue(fields, 2, "websocket"), "websocket", true);
    const sign = signFromCode(arrayValue(fields, 3, "websocket"), "websocket");
    const change = parseKisDecimal(arrayValue(fields, 4, "websocket"), "websocket");
    const rate = parseKisDecimal(arrayValue(fields, 5, "websocket"), "websocket");
    return quote(
      validated,
      price,
      change,
      rate,
      sign,
      "websocket",
      context,
    );
  }

  parseRest(
    payload: unknown,
    instrument: CanonicalInstrument,
    context: QuoteContext,
  ): QuoteSample {
    const validated = validateDomesticInstrument(instrument, this.instrumentType);
    const output = recordValue(payload, "output", "rest");
    const price = parseKisDecimal(
      recordValue(output, "stck_prpr", "rest"),
      "rest",
      true,
    );
    const sign = signFromCode(
      recordValue(output, "prdy_vrss_sign", "rest"),
      "rest",
    );
    const change = parseKisDecimal(recordValue(output, "prdy_vrss", "rest"), "rest");
    const rate = parseKisDecimal(recordValue(output, "prdy_ctrt", "rest"), "rest");
    return quote(validated, price, change, rate, sign, "rest", context);
  }
}

export const domesticStockAdapter: MarketAdapter<DomesticAdapterSettings> =
  new DomesticMarketAdapter("stock");
export const domesticEtfAdapter: MarketAdapter<DomesticAdapterSettings> =
  new DomesticMarketAdapter("etf");

export function getDomesticMarketAdapter(
  instrumentType?: string,
): MarketAdapter<DomesticAdapterSettings> {
  return instrumentType === "etf" ? domesticEtfAdapter : domesticStockAdapter;
}

function normalizeExchange(value: string | undefined): OverseasExchange {
  if (value && CONTROL_CHARACTER_PATTERN.test(value)) throw invalidInstrument();
  const exchange = value?.trim().toUpperCase();
  if (exchange === "NYS" || exchange === "AMS") return exchange;
  return "NAS";
}

export const overseasStockAdapter: MarketAdapter<OverseasAdapterSettings> = {
  id: "overseas-stock",
  market: "overseas",

  toInstrument(settings): CanonicalInstrument {
    const symbol = normalizeOverseasSymbol(
      optionalSettingString(settings, "ticker"),
      true,
    );
    const stockName = optionalSettingString(settings, "stockName");
    const exchange = normalizeExchange(optionalSettingString(settings, "exchange"));
    return Object.freeze({
      key: `overseas:${exchange}:${symbol}`,
      market: "overseas",
      instrumentType: "overseas",
      symbol,
      displayName: stockName?.trim() || symbol,
      exchange,
    });
  },

  restDescriptor(instrument): KisRestDescriptor {
    const validated = validateOverseasInstrument(instrument);
    const exchange = validated.exchange as OverseasExchange;
    return Object.freeze({
      method: "GET",
      path: "/uapi/overseas-price/v1/quotations/price",
      trId: REST_TR_OVERSEAS_PRICE,
      query: Object.freeze({ AUTH: "", EXCD: exchange, SYMB: validated.symbol }),
    });
  },

  webSocketDescriptor(instrument, nowMs): KisWebSocketDescriptor {
    const validated = validateOverseasInstrument(instrument);
    if (!Number.isFinite(nowMs)) throw invalidInstrument();
    const isDayTrading = isOverseasDayTradingAt(nowMs);
    const exchange = validated.exchange as OverseasExchange;
    const prefixMap = isDayTrading ? OVERSEAS_DAY_PREFIX : OVERSEAS_NIGHT_PREFIX;
    const prefix = prefixMap[exchange] ?? (isDayTrading ? "RBAQ" : "DNAS");
    return Object.freeze({
      trId: TR_ID_OVERSEAS,
      trKey: `${prefix}${validated.symbol}`,
    });
  },

  parseWebSocket(fields, instrument, context): QuoteSample {
    const validated = validateOverseasInstrument(instrument);
    const symbolValue = arrayValue(fields, 1, "websocket");
    if (typeof symbolValue !== "string") throw protocolError("websocket");
    let symbol: string;
    try {
      symbol = normalizeOverseasSymbol(symbolValue, false);
    } catch {
      throw protocolError("websocket");
    }
    if (symbol !== validated.symbol) throw protocolError("websocket");
    const price = parseKisDecimal(
      arrayValue(fields, 11, "websocket"),
      "websocket",
      true,
    );
    const sign = signFromCode(arrayValue(fields, 12, "websocket"), "websocket");
    const change = parseKisDecimal(arrayValue(fields, 13, "websocket"), "websocket");
    const rate = parseKisDecimal(arrayValue(fields, 14, "websocket"), "websocket");
    return quote(
      validated,
      price,
      change,
      rate,
      sign,
      "websocket",
      context,
    );
  },

  parseRest(payload, instrument, context): QuoteSample {
    const validated = validateOverseasInstrument(instrument);
    const output = recordValue(payload, "output", "rest");
    const price = parseKisDecimal(
      recordValue(output, "last", "rest"),
      "rest",
      true,
    );
    const sign = signFromCode(recordValue(output, "sign", "rest"), "rest");
    const change = parseKisDecimal(recordValue(output, "diff", "rest"), "rest");
    const rate = parseKisDecimal(recordValue(output, "rate", "rest"), "rest");
    return quote(validated, price, change, rate, sign, "rest", context);
  },
};
