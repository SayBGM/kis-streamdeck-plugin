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

function expectKisError(code: "INVALID_INSTRUMENT" | "PROTOCOL") {
  return expect.objectContaining({ code });
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
      change: -1_200,
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
          prdy_vrss: "1200",
          prdy_ctrt: "-1.66",
        },
      },
      instrument,
      context,
    );

    expect(quote.source).toBe("rest");
    expect(quote.price).toBe(71_200);
    expect(quote.change).toBe(1_200);
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

  it("accepts a class-share ticker", () => {
    expect(overseasStockAdapter.toInstrument({
      ticker: " brk.b ",
      exchange: "NYS",
    }).symbol).toBe("BRK.B");
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
      change: 1.5,
      changeRate: 0.72,
      sign: "rise",
      source: "websocket",
    });
    expect(overseasStockAdapter.parseRest(
      { output: { last: "209.50", sign: "5", diff: "+1.50", rate: "+0.72" } },
      instrument,
      context,
    )).toMatchObject({
      symbol: "AAPL",
      price: 209.5,
      change: -1.5,
      changeRate: -0.72,
      sign: "fall",
      source: "rest",
    });
  });

  it("normalizes non-zero change and rate to zero for a flat sign", () => {
    const domesticInstrument = domesticStockAdapter.toInstrument({ stockCode: "005930" });
    const overseasInstrument = overseasStockAdapter.toInstrument({ ticker: "AAPL", exchange: "NAS" });
    const domestic = domesticFields();
    domestic[3] = "3";
    const overseas = overseasFields();
    overseas[12] = "3";

    expect(domesticStockAdapter.parseWebSocket(domestic, domesticInstrument, context))
      .toMatchObject({ change: 0, changeRate: 0, sign: "flat" });
    expect(domesticStockAdapter.parseRest({
      output: {
        stck_prpr: "71200",
        prdy_vrss_sign: "3",
        prdy_vrss: "1200",
        prdy_ctrt: "1.66",
      },
    }, domesticInstrument, context)).toMatchObject({ change: 0, changeRate: 0, sign: "flat" });
    expect(overseasStockAdapter.parseWebSocket(overseas, overseasInstrument, context))
      .toMatchObject({ change: 0, changeRate: 0, sign: "flat" });
    expect(overseasStockAdapter.parseRest({
      output: { last: "209.50", sign: "3", diff: "1.50", rate: "0.72" },
    }, overseasInstrument, context)).toMatchObject({ change: 0, changeRate: 0, sign: "flat" });
  });
});

describe("market adapter validation", () => {
  it.each(["1e3", "0x10", "12px", "", " 12"])(
    "rejects non-KIS decimal syntax in both WebSocket markets: %j",
    (invalidPrice) => {
      const domestic = domesticFields();
      domestic[2] = invalidPrice;
      const overseas = overseasFields();
      overseas[11] = invalidPrice;

      expect(() => domesticStockAdapter.parseWebSocket(
        domestic,
        domesticStockAdapter.toInstrument({ stockCode: "005930" }),
        context,
      )).toThrowError(expectKisError("PROTOCOL"));
      expect(() => overseasStockAdapter.parseWebSocket(
        overseas,
        overseasStockAdapter.toInstrument({ ticker: "AAPL", exchange: "NAS" }),
        context,
      )).toThrowError(expectKisError("PROTOCOL"));
    },
  );

  it.each(["0", "-1"])("requires a positive price in WS and REST: %s", (price) => {
    const domestic = domesticFields();
    domestic[2] = price;
    const overseas = overseasFields();
    overseas[11] = price;
    const domesticInstrument = domesticStockAdapter.toInstrument({ stockCode: "005930" });
    const overseasInstrument = overseasStockAdapter.toInstrument({ ticker: "AAPL", exchange: "NAS" });

    expect(() => domesticStockAdapter.parseWebSocket(
      domestic, domesticInstrument, context,
    )).toThrowError(expectKisError("PROTOCOL"));
    expect(() => overseasStockAdapter.parseWebSocket(
      overseas, overseasInstrument, context,
    )).toThrowError(expectKisError("PROTOCOL"));
    expect(() => domesticStockAdapter.parseRest({
      output: { stck_prpr: price, prdy_vrss_sign: "3", prdy_vrss: "0", prdy_ctrt: "0" },
    }, domesticInstrument, context)).toThrowError(expectKisError("PROTOCOL"));
    expect(() => overseasStockAdapter.parseRest({
      output: { last: price, sign: "3", diff: "0", rate: "0" },
    }, overseasInstrument, context)).toThrowError(expectKisError("PROTOCOL"));
  });

  it.each(["0", "6", "rise"])("rejects unknown sign code %j in WS and REST", (signCode) => {
    const domestic = domesticFields();
    domestic[3] = signCode;
    const overseas = overseasFields();
    overseas[12] = signCode;
    const domesticInstrument = domesticStockAdapter.toInstrument({ stockCode: "005930" });
    const overseasInstrument = overseasStockAdapter.toInstrument({ ticker: "AAPL", exchange: "NAS" });

    expect(() => domesticStockAdapter.parseWebSocket(
      domestic, domesticInstrument, context,
    )).toThrowError(expectKisError("PROTOCOL"));
    expect(() => overseasStockAdapter.parseWebSocket(
      overseas, overseasInstrument, context,
    )).toThrowError(expectKisError("PROTOCOL"));
    expect(() => domesticStockAdapter.parseRest({
      output: { stck_prpr: "1", prdy_vrss_sign: signCode, prdy_vrss: "0", prdy_ctrt: "0" },
    }, domesticInstrument, context)).toThrowError(expectKisError("PROTOCOL"));
    expect(() => overseasStockAdapter.parseRest({
      output: { last: "1", sign: signCode, diff: "0", rate: "0" },
    }, overseasInstrument, context)).toThrowError(expectKisError("PROTOCOL"));
  });

  it.each([undefined, null, "NaN", "Infinity", "1e3", "0x10", "12px"])(
    "rejects malformed native change values across domestic and overseas WS/REST: %j",
    (invalidChange) => {
      const domesticInstrument = domesticStockAdapter.toInstrument({ stockCode: "005930" });
      const overseasInstrument = overseasStockAdapter.toInstrument({ ticker: "AAPL", exchange: "NAS" });
      const domestic = domesticFields() as unknown[];
      domestic[4] = invalidChange;
      const overseas = overseasFields() as unknown[];
      overseas[13] = invalidChange;

      expect(() => domesticStockAdapter.parseWebSocket(
        domestic as string[], domesticInstrument, context,
      )).toThrowError(expectKisError("PROTOCOL"));
      expect(() => domesticStockAdapter.parseRest({
        output: {
          stck_prpr: "71200",
          prdy_vrss_sign: "2",
          prdy_vrss: invalidChange,
          prdy_ctrt: "1.66",
        },
      }, domesticInstrument, context)).toThrowError(expectKisError("PROTOCOL"));
      expect(() => overseasStockAdapter.parseWebSocket(
        overseas as string[], overseasInstrument, context,
      )).toThrowError(expectKisError("PROTOCOL"));
      expect(() => overseasStockAdapter.parseRest({
        output: { last: "209.50", sign: "2", diff: invalidChange, rate: "0.72" },
      }, overseasInstrument, context)).toThrowError(expectKisError("PROTOCOL"));
    },
  );

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

  it.each([
    { stockCode: "00593" },
    { stockCode: "00593!" },
    { stockCode: "삼성전자" },
  ])("requires a six-character alphanumeric domestic code", (settings) => {
    expect(() => domesticStockAdapter.toInstrument(settings)).toThrowError(
      expectKisError("INVALID_INSTRUMENT"),
    );
  });

  it.each([
    "BRK B",
    "BRK/B",
    "AAPL\n",
    ".AAPL",
    "AAPL-",
    "ABCDEFGHIJKLMNOP",
  ])("rejects unsafe or excessive overseas ticker %j", (ticker) => {
    expect(() => overseasStockAdapter.toInstrument({ ticker, exchange: "NAS" })).toThrowError(
      expectKisError("INVALID_INSTRUMENT"),
    );
  });

  it("normalizes hostile settings values to INVALID_INSTRUMENT", () => {
    const getterSettings = Object.defineProperty({}, "stockCode", {
      enumerable: true,
      get: () => {
        throw new Error("getter should not escape");
      },
    });
    const trapSettings = new Proxy({}, {
      getOwnPropertyDescriptor: () => {
        throw new Error("proxy should not escape");
      },
    });
    const revocable = Proxy.revocable({ stockCode: "005930" }, {});
    revocable.revoke();

    for (const settings of [
      123,
      Symbol("settings"),
      { stockCode: 5930 },
      { ticker: Symbol("AAPL") },
      getterSettings,
      trapSettings,
      revocable.proxy,
    ]) {
      expect(() => domesticStockAdapter.toInstrument(settings as never)).toThrowError(
        expectKisError("INVALID_INSTRUMENT"),
      );
    }
  });

  it("normalizes a revoked REST payload proxy to PROTOCOL", () => {
    const revocable = Proxy.revocable({ output: {} }, {});
    revocable.revoke();

    expect(() => overseasStockAdapter.parseRest(
      revocable.proxy,
      overseasStockAdapter.toInstrument({ ticker: "AAPL", exchange: "NAS" }),
      context,
    )).toThrowError(expectKisError("PROTOCOL"));
  });

  it("rejects adapter and instrument mismatches", () => {
    const etf = domesticEtfAdapter.toInstrument({ stockCode: "0210A0" });
    const domestic = domesticStockAdapter.toInstrument({ stockCode: "005930" });

    expect(() => domesticStockAdapter.restDescriptor(etf)).toThrowError(
      expectKisError("INVALID_INSTRUMENT"),
    );
    expect(() => overseasStockAdapter.webSocketDescriptor(domestic, context.receivedAt)).toThrowError(
      expectKisError("INVALID_INSTRUMENT"),
    );
  });
});
