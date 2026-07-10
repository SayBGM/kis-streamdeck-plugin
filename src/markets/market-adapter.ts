import { KisError, type KisErrorScope } from "../core/errors.js";
import { isOverseasDayTradingAt } from "../core/market-clock.js";
import { normalizeDomesticStockCode } from "../kis/domestic-instrument.js";
import { parseDomesticData } from "../kis/domestic-parser.js";
import { parseOverseasData } from "../kis/overseas-parser.js";
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

function finiteNumber(value: unknown, scope: KisErrorScope): number {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "string" && value.trim().length === 0)
  ) {
    throw protocolError(scope);
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw protocolError(scope);
  return parsed;
}

function requiredString(value: unknown, scope: KisErrorScope): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw protocolError(scope);
  }
  return value.trim();
}

function recordValue(value: unknown, key: string, scope: KisErrorScope): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw protocolError(scope);
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw protocolError(scope);
  }
  if (!descriptor || !("value" in descriptor)) throw protocolError(scope);
  return descriptor.value;
}

function signFromCode(signCode: string): PriceSign {
  if (signCode === "1" || signCode === "2") return "rise";
  if (signCode === "4" || signCode === "5") return "fall";
  return "flat";
}

function signedRate(rate: number, sign: PriceSign): number {
  if (sign === "fall") return -Math.abs(rate);
  if (sign === "rise") return Math.abs(rate);
  return 0;
}

function quote(
  instrument: CanonicalInstrument,
  price: number,
  rate: number,
  sign: PriceSign,
  source: QuoteSource,
  context: QuoteContext,
): QuoteSample {
  if (!Number.isFinite(context.receivedAt) || !Number.isFinite(context.sessionEpoch)) {
    throw protocolError(source === "rest" ? "rest" : "websocket");
  }
  return Object.freeze({
    symbol: instrument.symbol,
    price,
    changeRate: signedRate(rate, sign),
    sign,
    source,
    receivedAt: context.receivedAt,
    sessionEpoch: context.sessionEpoch,
  });
}

class DomesticMarketAdapter implements MarketAdapter<DomesticAdapterSettings> {
  readonly market = "domestic" as const;
  readonly id: string;

  constructor(private readonly instrumentType: DomesticInstrumentType) {
    this.id = `domestic-${instrumentType}`;
  }

  toInstrument(settings: DomesticAdapterSettings): CanonicalInstrument {
    const symbol = normalizeDomesticStockCode(settings.stockCode);
    if (!symbol) throw invalidInstrument();
    const displayName = settings.stockName?.trim() || symbol;
    return Object.freeze({
      key: `domestic:${this.instrumentType}:${symbol}`,
      market: "domestic",
      instrumentType: this.instrumentType,
      symbol,
      displayName,
    });
  }

  restDescriptor(instrument: CanonicalInstrument): KisRestDescriptor {
    const isEtf = this.instrumentType === "etf";
    return Object.freeze({
      method: "GET",
      path: isEtf
        ? "/uapi/etfetn/v1/quotations/inquire-price"
        : "/uapi/domestic-stock/v1/quotations/inquire-price",
      trId: isEtf ? REST_TR_DOMESTIC_ETF_PRICE : REST_TR_DOMESTIC_PRICE,
      query: Object.freeze({
        FID_COND_MRKT_DIV_CODE: "UN",
        FID_INPUT_ISCD: instrument.symbol,
      }),
    });
  }

  webSocketDescriptor(instrument: CanonicalInstrument, _nowMs: number): KisWebSocketDescriptor {
    return Object.freeze({ trId: TR_ID_DOMESTIC, trKey: instrument.symbol });
  }

  parseWebSocket(
    fields: readonly string[],
    instrument: CanonicalInstrument,
    context: QuoteContext,
  ): QuoteSample {
    const symbol = requiredString(fields[0], "websocket").toUpperCase();
    if (symbol !== instrument.symbol) throw protocolError("websocket");
    finiteNumber(fields[2], "websocket");
    requiredString(fields[3], "websocket");
    finiteNumber(fields[5], "websocket");

    const parsed = parseDomesticData([...fields], instrument.displayName);
    return quote(
      instrument,
      parsed.price,
      parsed.changeRate,
      parsed.sign,
      "websocket",
      context,
    );
  }

  parseRest(
    payload: unknown,
    instrument: CanonicalInstrument,
    context: QuoteContext,
  ): QuoteSample {
    const output = recordValue(payload, "output", "rest");
    const price = finiteNumber(recordValue(output, "stck_prpr", "rest"), "rest");
    const signCode = requiredString(
      recordValue(output, "prdy_vrss_sign", "rest"),
      "rest",
    );
    const rate = finiteNumber(recordValue(output, "prdy_ctrt", "rest"), "rest");
    const sign = signFromCode(signCode);
    return quote(instrument, price, rate, sign, "rest", context);
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

function normalizeExchange(value?: string): OverseasExchange {
  const exchange = value?.trim().toUpperCase();
  if (exchange === "NYS" || exchange === "AMS") return exchange;
  return "NAS";
}

export const overseasStockAdapter: MarketAdapter<OverseasAdapterSettings> = {
  id: "overseas-stock",
  market: "overseas",

  toInstrument(settings): CanonicalInstrument {
    const symbol = settings.ticker?.trim().toUpperCase() ?? "";
    if (!symbol) throw invalidInstrument();
    const exchange = normalizeExchange(settings.exchange);
    return Object.freeze({
      key: `overseas:${exchange}:${symbol}`,
      market: "overseas",
      instrumentType: "overseas",
      symbol,
      displayName: settings.stockName?.trim() || symbol,
      exchange,
    });
  },

  restDescriptor(instrument): KisRestDescriptor {
    const exchange = instrument.exchange ?? "NAS";
    return Object.freeze({
      method: "GET",
      path: "/uapi/overseas-price/v1/quotations/price",
      trId: REST_TR_OVERSEAS_PRICE,
      query: Object.freeze({ AUTH: "", EXCD: exchange, SYMB: instrument.symbol }),
    });
  },

  webSocketDescriptor(instrument, nowMs): KisWebSocketDescriptor {
    const isDayTrading = isOverseasDayTradingAt(nowMs);
    const exchange = instrument.exchange ?? "NAS";
    const prefixMap = isDayTrading ? OVERSEAS_DAY_PREFIX : OVERSEAS_NIGHT_PREFIX;
    const prefix = prefixMap[exchange] ?? (isDayTrading ? "RBAQ" : "DNAS");
    return Object.freeze({
      trId: TR_ID_OVERSEAS,
      trKey: `${prefix}${instrument.symbol}`,
    });
  },

  parseWebSocket(fields, instrument, context): QuoteSample {
    const symbol = requiredString(fields[1], "websocket").toUpperCase();
    if (symbol !== instrument.symbol) throw protocolError("websocket");
    finiteNumber(fields[11], "websocket");
    requiredString(fields[12], "websocket");
    finiteNumber(fields[14], "websocket");

    const parsed = parseOverseasData([...fields], instrument.displayName);
    return quote(
      instrument,
      parsed.price,
      parsed.changeRate,
      parsed.sign,
      "websocket",
      context,
    );
  },

  parseRest(payload, instrument, context): QuoteSample {
    const output = recordValue(payload, "output", "rest");
    const price = finiteNumber(recordValue(output, "last", "rest"), "rest");
    const signCode = requiredString(recordValue(output, "sign", "rest"), "rest");
    const rate = finiteNumber(recordValue(output, "rate", "rest"), "rest");
    const sign = signFromCode(signCode);
    return quote(instrument, price, rate, sign, "rest", context);
  },
};
