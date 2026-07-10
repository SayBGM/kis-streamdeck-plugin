import { describe, expect, it } from "vitest";
import {
  domesticEtfAdapter,
  domesticStockAdapter,
  getDomesticMarketAdapter,
  overseasStockAdapter,
} from "../market-adapter.js";

const context = {
  receivedAt: Date.parse("2026-07-06T01:00:00.000Z"),
  sessionEpoch: Date.parse("2026-07-06T00:00:00.000Z"),
} as const;

function domesticFields(): string[] {
  return ["005930", "100000", "71200", "5", "1200", "-1.66"];
}

function overseasFields(): string[] {
  return [
    "DNASAAPL", "AAPL", "2", "20260706", "20260706", "100000",
    "20260706", "230000", "210.00", "212.00", "208.00", "209.50",
    "2", "1.50", "0.72",
  ];
}

describe("domestic market adapters", () => {
  it("normalizes a stock and builds its KIS REST/WS descriptors", () => {
    const instrument = domesticStockAdapter.toInstrument({
      stockCode: " 005930 ",
      stockName: " 삼성전자 ",
    });

    expect(instrument).toEqual({
      key: "domestic:stock:005930",
      market: "domestic",
      instrumentType: "stock",
      symbol: "005930",
      displayName: "삼성전자",
    });
    expect(domesticStockAdapter.restDescriptor(instrument)).toEqual({
      method: "GET",
      path: "/uapi/domestic-stock/v1/quotations/inquire-price",
      trId: "FHKST01010100",
      query: {
        FID_COND_MRKT_DIV_CODE: "UN",
        FID_INPUT_ISCD: "005930",
      },
    });
    expect(domesticStockAdapter.webSocketDescriptor(instrument, context.receivedAt)).toEqual({
      trId: "H0UNCNT0",
      trKey: "005930",
    });
  });

  it("routes ETF settings to the ETF REST endpoint while sharing live trades", () => {
    const adapter = getDomesticMarketAdapter("etf");
    const instrument = adapter.toInstrument({
      stockCode: " 0210a0 ",
      stockName: "ETF",
      instrumentType: "etf",
    });

    expect(adapter).toBe(domesticEtfAdapter);
    expect(instrument.instrumentType).toBe("etf");
    expect(instrument.symbol).toBe("0210A0");
    expect(adapter.restDescriptor(instrument).path).toBe(
      "/uapi/etfetn/v1/quotations/inquire-price",
    );
    expect(adapter.restDescriptor(instrument).trId).toBe("FHPST02400000");
    expect(adapter.webSocketDescriptor(instrument, context.receivedAt)).toEqual({
      trId: "H0UNCNT0",
      trKey: "0210A0",
    });
  });

  it("normalizes the existing signed WebSocket parsing rules", () => {
    const instrument = domesticStockAdapter.toInstrument({
      stockCode: "005930",
      stockName: "삼성전자",
    });
    const quote = domesticStockAdapter.parseWebSocket(
      domesticFields(),
      instrument,
      context,
    );

    expect(quote).toEqual({
      symbol: "005930",
      price: 71_200,
      changeRate: -1.66,
      sign: "fall",
      source: "websocket",
      receivedAt: context.receivedAt,
      sessionEpoch: context.sessionEpoch,
    });
  });

  it("parses a domestic REST output into the canonical quote", () => {
    const instrument = domesticStockAdapter.toInstrument({ stockCode: "005930" });
    const quote = domesticStockAdapter.parseRest(
      {
        output: {
          stck_prpr: "71200",
          prdy_vrss_sign: "2",
          prdy_ctrt: "1.66",
        },
      },
      instrument,
      context,
    );

    expect(quote.source).toBe("rest");
    expect(quote.price).toBe(71_200);
    expect(quote.changeRate).toBe(1.66);
    expect(quote.sign).toBe("rise");
  });
});

describe("overseas market adapter", () => {
  it("normalizes settings and switches the day/night WebSocket key", () => {
    const instrument = overseasStockAdapter.toInstrument({
      ticker: " aapl ",
      stockName: " Apple ",
      exchange: "NAS",
    });

    expect(instrument).toEqual({
      key: "overseas:NAS:AAPL",
      market: "overseas",
      instrumentType: "overseas",
      symbol: "AAPL",
      displayName: "Apple",
      exchange: "NAS",
    });
    expect(overseasStockAdapter.webSocketDescriptor(
      instrument,
      Date.parse("2026-07-06T01:00:00.000Z"),
    ).trKey).toBe("RBAQAAPL");
    expect(overseasStockAdapter.webSocketDescriptor(
      instrument,
      Date.parse("2026-07-06T13:30:00.000Z"),
    ).trKey).toBe("DNASAAPL");
    expect(overseasStockAdapter.restDescriptor(instrument)).toEqual({
      method: "GET",
      path: "/uapi/overseas-price/v1/quotations/price",
      trId: "HHDFS00000300",
      query: { AUTH: "", EXCD: "NAS", SYMB: "AAPL" },
    });
  });

  it("normalizes overseas WebSocket and REST payloads", () => {
    const instrument = overseasStockAdapter.toInstrument({
      ticker: "AAPL",
      exchange: "NAS",
    });

    expect(overseasStockAdapter.parseWebSocket(
      overseasFields(), instrument, context,
    )).toMatchObject({
      symbol: "AAPL",
      price: 209.5,
      changeRate: 0.72,
      sign: "rise",
      source: "websocket",
    });
    expect(overseasStockAdapter.parseRest(
      { output: { last: "209.50", sign: "5", rate: "-0.72" } },
      instrument,
      context,
    )).toMatchObject({
      symbol: "AAPL",
      price: 209.5,
      changeRate: -0.72,
      sign: "fall",
      source: "rest",
    });
  });
});

describe("market adapter validation", () => {
  it.each([
    () => domesticStockAdapter.parseWebSocket([], domesticStockAdapter.toInstrument({ stockCode: "005930" }), context),
    () => overseasStockAdapter.parseWebSocket(["DNASAAPL"], overseasStockAdapter.toInstrument({ ticker: "AAPL", exchange: "NAS" }), context),
    () => domesticStockAdapter.parseRest({ output: { stck_prpr: "NaN" } }, domesticStockAdapter.toInstrument({ stockCode: "005930" }), context),
    () => domesticStockAdapter.parseRest({ output: { stck_prpr: null, prdy_vrss_sign: "3", prdy_ctrt: "0" } }, domesticStockAdapter.toInstrument({ stockCode: "005930" }), context),
    () => overseasStockAdapter.parseRest({ output: null }, overseasStockAdapter.toInstrument({ ticker: "AAPL", exchange: "NAS" }), context),
    () => overseasStockAdapter.parseRest(new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error("trap"); } }), overseasStockAdapter.toInstrument({ ticker: "AAPL", exchange: "NAS" }), context),
  ])("rejects a malformed KIS payload with a safe protocol error", (parse) => {
    expect(parse).toThrowError(expect.objectContaining({
      code: "PROTOCOL",
      retryable: true,
    }));
  });

  it("rejects an empty symbol as an invalid instrument", () => {
    expect(() => domesticStockAdapter.toInstrument({ stockCode: "  " })).toThrowError(
      expect.objectContaining({ code: "INVALID_INSTRUMENT" }),
    );
  });
});
