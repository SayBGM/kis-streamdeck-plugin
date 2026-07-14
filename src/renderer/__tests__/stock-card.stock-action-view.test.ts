import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import type { StockActionView } from "../../actions/stock-action-controller.js";
import type { KisErrorCode } from "../../core/errors.js";
import { renderStockActionView, renderStockActionViewDataUri } from "../stock-card.js";

function view(overrides: Partial<StockActionView> = {}): StockActionView {
  return {
    actionId: "action-1",
    instrument: {
      symbol: "005930",
      name: "삼성전자",
      market: "domestic",
    },
    session: "REG",
    quote: {
      symbol: "005930",
      price: 72_100,
      change: 1_200,
      changeRate: 1.25,
      sign: "rise",
      source: "websocket",
      receivedAt: 1_750_000_000_000,
      sessionEpoch: 1_749_945_600_000,
    },
    connection: "LIVE",
    stale: false,
    refreshing: false,
    recovery: false,
    ...overrides,
  };
}

function expectValidSvg(svg: string): void {
  const window = new Window();
  const document = new window.DOMParser().parseFromString(svg, "image/svg+xml");
  const root = document.documentElement;

  expect(root.tagName.toLowerCase()).toBe("svg");
  expect(root.getAttribute("width")).toBe("144");
  expect(root.getAttribute("height")).toBe("144");
  expect(root.getAttribute("viewBox")).toBe("0 0 144 144");
  expect(document.querySelector("parsererror")).toBeNull();
  window.close();
}

function expectConnectionTitle(svg: string, color: string): void {
  const window = new Window();
  const document = new window.DOMParser().parseFromString(svg, "image/svg+xml");

  expect(document.querySelector('[data-role="connection-dot"]')?.getAttribute("fill")).toBe(color);
  expect(document.querySelector('[data-role="stock-name"]')?.getAttribute("fill")).toBe(color);
  expect(document.querySelector('[data-role="stock-name"]')?.getAttribute("x")).toBe("12");
  expect(document.querySelector('[data-role="state-bar"]')).toBeNull();
  window.close();
}

function expectNoConnectionTitle(svg: string): void {
  const window = new Window();
  const document = new window.DOMParser().parseFromString(svg, "image/svg+xml");

  expect(document.querySelector('[data-role="connection-dot"]')).toBeNull();
  expect(document.querySelector('[data-role="stock-name"]')).toBeNull();
  expect(document.querySelector('[data-role="state-bar"]')).toBeNull();
  window.close();
}

const QUOTE_STATUS_TEXTS = [
  "실시간",
  "백업",
  "백업 · 지연",
  "지연",
  "시세 지연",
  "새로고침 중",
  "연결 확인 필요",
] as const;

function expectNoQuoteStatus(svg: string): void {
  const window = new Window();
  const document = new window.DOMParser().parseFromString(svg, "image/svg+xml");
  const labels = Array.from(document.querySelectorAll("text"))
    .map((node) => node.textContent);

  for (const status of QUOTE_STATUS_TEXTS) expect(labels).not.toContain(status);
  expect(document.querySelector('[data-role="loading-indicator"]')).toBeNull();
  window.close();
}

function metricSnapshot(
  svg: string,
  role: "quote-change" | "quote-rate",
): {
  readonly text: string | null;
  readonly x: string | null;
  readonly y: string | null;
  readonly anchor: string | null;
  readonly fontSize: string | null;
  readonly textLength: string | null;
  readonly lengthAdjust: string | null;
} {
  const window = new Window();
  const document = new window.DOMParser().parseFromString(svg, "image/svg+xml");
  const node = document.querySelector(`[data-role="${role}"]`);
  const snapshot = {
    text: node?.textContent ?? null,
    x: node?.getAttribute("x") ?? null,
    y: node?.getAttribute("y") ?? null,
    anchor: node?.getAttribute("text-anchor") ?? null,
    fontSize: node?.getAttribute("font-size") ?? null,
    textLength: node?.getAttribute("textLength") ?? null,
    lengthAdjust: node?.getAttribute("lengthAdjust") ?? null,
  };

  window.close();
  return snapshot;
}

describe("renderStockActionView", () => {
  it("renders domestic rise change and rate in separate bounded columns", () => {
    const svg = renderStockActionView(view({ session: "PRE" }));
    const change = metricSnapshot(svg, "quote-change");
    const rate = metricSnapshot(svg, "quote-rate");

    expectValidSvg(svg);
    expect(svg).toContain("삼성전자");
    expect(svg).toContain("프리");
    expect(svg).not.toContain("정규");
    expect(svg).toContain("72,100");
    expect(change).toEqual({
      text: "▲ +1,200",
      x: "12",
      y: "116",
      anchor: "start",
      fontSize: "14",
      textLength: "58",
      lengthAdjust: "spacingAndGlyphs",
    });
    expect(rate).toEqual({
      text: "+1.25%",
      x: "132",
      y: "116",
      anchor: "end",
      fontSize: "14",
      textLength: null,
      lengthAdjust: null,
    });
    expect(rate.text).not.toMatch(/[▲▼]/);
    expectNoQuoteStatus(svg);
    expectConnectionTitle(svg, "#00c853");
  });

  it("formats overseas fall change and rate without repeating the arrow", () => {
    const svg = renderStockActionView(view({
      instrument: { symbol: "AAPL", name: "Apple", market: "overseas" },
      session: "AFT",
      quote: {
        symbol: "AAPL",
        price: 182.5,
        change: -1.25,
        changeRate: -0.68,
        sign: "fall",
        source: "rest",
        receivedAt: 100,
        sessionEpoch: 10,
      },
      connection: "BACKUP",
    }));
    const change = metricSnapshot(svg, "quote-change");
    const rate = metricSnapshot(svg, "quote-rate");

    expectValidSvg(svg);
    expect(svg).toContain("$182.50");
    expect(change.text).toBe("▼ -$1.25");
    expect(change.x).toBe("12");
    expect(change.y).toBe("116");
    expect(change.anchor).toBe("start");
    expect(rate.text).toBe("-0.68%");
    expect(rate.x).toBe("132");
    expect(rate.y).toBe("116");
    expect(rate.anchor).toBe("end");
    expect(rate.text).not.toMatch(/[▲▼]/);
    expect(svg).toContain("애프터");
    expectNoQuoteStatus(svg);
    expectConnectionTitle(svg, "#7dd3fc");
    expect(svg).not.toContain("#ffd54f");
  });

  it.each([
    { market: "domestic" as const, symbol: "005930", change: "0" },
    { market: "overseas" as const, symbol: "AAPL", change: "$0.00" },
  ])("renders $market flat metrics without an arrow", ({ market, symbol, change }) => {
    const svg = renderStockActionView(view({
      instrument: { symbol, name: "Flat", market },
      quote: {
        symbol,
        price: market === "domestic" ? 72_100 : 182.5,
        change: 0,
        changeRate: 0,
        sign: "flat",
        source: "websocket",
        receivedAt: 100,
        sessionEpoch: 10,
      },
    }));

    expect(metricSnapshot(svg, "quote-change").text).toBe(change);
    expect(metricSnapshot(svg, "quote-rate").text).toBe("0.00%");
    expect(metricSnapshot(svg, "quote-change").text).not.toMatch(/[▲▼+-]/);
    expect(metricSnapshot(svg, "quote-rate").text).not.toMatch(/[▲▼+-]/);
  });

  it.each([
    { amount: 1, text: "▲ +1", fontSize: "14", constrained: false },
    { amount: 1_200, text: "▲ +1,200", fontSize: "14", constrained: true },
    { amount: 123_456, text: "▲ +123,456", fontSize: "12", constrained: true },
    { amount: 123_456_789, text: "▲ +123,456,789", fontSize: "10", constrained: true },
    {
      amount: 1_000_000_000_000_000,
      text: "▲ +1,000,000,000,000,000",
      fontSize: "8",
      constrained: true,
    },
  ])(
    "uses the exact metric width contract for $text",
    ({ amount, text, fontSize, constrained }) => {
      const svg = renderStockActionView(view({
        quote: { ...view().quote!, change: amount },
      }));
      const change = metricSnapshot(svg, "quote-change");

      expect(change.text).toBe(text);
      expect(change.fontSize).toBe(fontSize);
      expect(change.textLength).toBe(constrained ? "58" : null);
      expect(change.lengthAdjust).toBe(constrained ? "spacingAndGlyphs" : null);
    },
  );

  it("is deterministic when only non-visible quote metadata changes", () => {
    const first = view();
    const second = view({
      quote: {
        ...first.quote!,
        source: "rest",
        receivedAt: 1,
        sessionEpoch: 2,
      },
    });

    expect(renderStockActionView(first)).toBe(renderStockActionView(second));
    expect(renderStockActionView(first)).toBe(renderStockActionView(first));
  });

  it.each([
    { connection: "waiting" as const, stale: true, refreshing: false, color: "#7f8aa8" },
    { connection: "LIVE" as const, stale: false, refreshing: false, color: "#00c853" },
    { connection: "BACKUP" as const, stale: true, refreshing: false, color: "#7dd3fc" },
    { connection: "BROKEN" as const, stale: true, refreshing: true, color: "#ff1744" },
    { connection: "LIVE" as const, stale: true, refreshing: true, color: "#00c853" },
    { connection: "BACKUP" as const, stale: false, refreshing: true, color: "#7dd3fc" },
  ])("omits quote status text for $connection", ({ connection, stale, refreshing, color }) => {
    const svg = renderStockActionView(view({ connection, stale, refreshing }));

    expectValidSvg(svg);
    expectNoQuoteStatus(svg);
    expectConnectionTitle(svg, color);
    expect(metricSnapshot(svg, "quote-change").y).toBe("116");
    expect(metricSnapshot(svg, "quote-rate").y).toBe("116");
    expect(svg).toContain("72,100");
  });

  it("renders waiting and recovery states with the injected session", () => {
    const waiting = renderStockActionView(view({
      session: "CLOSED",
      quote: undefined,
      connection: "waiting",
    }));
    const recovery = renderStockActionView(view({ session: "PRE", recovery: true }));

    expect(waiting).toContain("데이터 대기");
    expect(waiting).toContain("마감");
    expect(waiting).toContain('data-role="loading-indicator"');
    expectConnectionTitle(waiting, "#7f8aa8");
    expect(recovery).toContain("연결 회복");
    expect(recovery).toContain("프리");
    expectConnectionTitle(recovery, "#00c853");
  });

  it.each<[KisErrorCode, string]>([
    ["NO_CREDENTIALS", "설정 필요"],
    ["SETTINGS", "설정 오류"],
    ["AUTH_REJECTED", "인증 실패"],
    ["AUTH_RATE_LIMITED", "인증 지연"],
    ["NETWORK", "연결 오류"],
    ["TIMEOUT", "시간 초과"],
    ["INVALID_INSTRUMENT", "종목 오류"],
    ["PROTOCOL", "응답 오류"],
    ["SUBSCRIPTION_REJECTED", "구독 오류"],
  ])("maps %s to safe error copy", (code, label) => {
    const secret = "APPSECRET-token-approval-key";
    const svg = renderStockActionView(view({
      quote: undefined,
      connection: "BROKEN",
      error: { code, message: secret },
    }));

    expectValidSvg(svg);
    expect(svg).toContain(label);
    expect(svg).not.toContain(secret);
    expect(svg).not.toContain("APPSECRET");
    expectConnectionTitle(svg, "#ff1744");
  });

  it("prioritizes the error-only screen over a quote when the connection is broken", () => {
    const svg = renderStockActionView(view({
      connection: "BROKEN",
      error: { code: "NETWORK", message: "socket disconnected" },
    }));

    expectValidSvg(svg);
    expect(svg).toContain("연결 오류");
    expect(svg).not.toContain("72,100");
    expect(svg).not.toContain("▲ +1,200");
    expectConnectionTitle(svg, "#ff1744");
  });

  it("escapes instrument text while preserving valid names and symbols", () => {
    const svg = renderStockActionView(view({
      instrument: {
        symbol: "A&<1",
        name: "A<&\"'",
        market: "overseas",
      },
      quote: {
        symbol: "A&<1",
        price: 1.25,
        change: 0,
        changeRate: 0,
        sign: "flat",
        source: "websocket",
        receivedAt: 1,
        sessionEpoch: 1,
      },
    }));

    expectValidSvg(svg);
    expect(svg).toContain("A&lt;&amp;&quot;&apos;");
    expect(svg).toContain("A&amp;&lt;1");
    expect(svg).not.toContain("A<&");
  });

  it.each([
    { price: Number.NaN, changeRate: 0 },
    { price: Number.POSITIVE_INFINITY, changeRate: 0 },
    { price: -1, changeRate: 0 },
    { price: 1_000_000_000_000_001, changeRate: 0 },
    { price: 1, changeRate: Number.POSITIVE_INFINITY },
    { price: 1, changeRate: 100_001 },
    { price: 1, change: Number.NaN, changeRate: 0 },
    { price: 1, change: Number.POSITIVE_INFINITY, changeRate: 0 },
    { price: 1, change: 1_000_000_000_000_001, changeRate: 0 },
    { price: 1, change: -1, changeRate: 1.25, sign: "rise" as const },
    { price: 1, change: 1, changeRate: -1.25, sign: "fall" as const },
    { price: 1, change: 1, changeRate: -1.25, sign: "rise" as const },
    { price: 1, change: -1, changeRate: 1.25, sign: "fall" as const },
    { price: 1, change: 1, changeRate: 0, sign: "flat" as const },
    { price: 1, change: 0, changeRate: 1, sign: "flat" as const },
  ])("renders a safe display error for invalid bounded or contradictory quote values: %j", ({
    price,
    change,
    changeRate,
    sign,
  }) => {
    const svg = renderStockActionView(view({
      quote: {
        ...view().quote!,
        price,
        ...(change === undefined ? {} : { change }),
        changeRate,
        ...(sign === undefined ? {} : { sign }),
      },
    }));

    expectValidSvg(svg);
    expect(svg).toContain("표시 오류");
    expect(svg).not.toContain("NaN");
    expect(svg).not.toContain("Infinity");
    expectNoConnectionTitle(svg);
  });

  it("requires native change as an enumerable data property without invoking accessors", () => {
    const { change: _change, ...quoteWithoutChange } = view().quote!;
    let getterCalls = 0;
    const accessorQuote = Object.defineProperty({ ...quoteWithoutChange }, "change", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 1_250;
      },
    });

    const missingSvg = renderStockActionView(view({
      quote: quoteWithoutChange as StockActionView["quote"],
    }));
    const accessorSvg = renderStockActionView(view({
      quote: accessorQuote as StockActionView["quote"],
    }));

    expect(missingSvg).toContain("표시 오류");
    expect(accessorSvg).toContain("표시 오류");
    expect(getterCalls).toBe(0);
  });

  it("never executes accessors and safely rejects hostile proxies", () => {
    let getterCalls = 0;
    const accessorInstrument = Object.defineProperty({}, "name", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "secret-name";
      },
    });
    Object.defineProperties(accessorInstrument, {
      symbol: { enumerable: true, value: "005930" },
      market: { enumerable: true, value: "domestic" },
    });
    const accessorSvg = renderStockActionView(view({
      instrument: accessorInstrument as StockActionView["instrument"],
    }));
    const proxySvg = renderStockActionView(new Proxy(view(), {
      ownKeys() {
        throw new Error("proxy-secret");
      },
    }));

    expect(getterCalls).toBe(0);
    expect(accessorSvg).toContain("표시 오류");
    expect(accessorSvg).not.toContain("secret-name");
    expect(proxySvg).toContain("표시 오류");
    expect(proxySvg).not.toContain("proxy-secret");
  });

  it("offers a cached data URI convenience without changing the SVG identity", () => {
    const target = view();
    const svg = renderStockActionView(target);
    const first = renderStockActionViewDataUri(target);
    const second = renderStockActionViewDataUri(target);

    expect(first).toBe(second);
    expect(decodeURIComponent(first.split(",", 2)[1] ?? "")).toBe(svg);
  });
});
