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

describe("renderStockActionView", () => {
  it("uses the injected session and renders the compact domestic quote layout", () => {
    const svg = renderStockActionView(view({ session: "PRE" }));

    expectValidSvg(svg);
    expect(svg).toContain("삼성전자");
    expect(svg).toContain("프리");
    expect(svg).not.toContain("정규");
    expect(svg).toContain("72,100");
    expect(svg).toContain("▲ +1.25%");
    expect(svg).toContain("실시간");
    expectConnectionTitle(svg, "#00c853");
    expect(svg).not.toContain("1,250");
  });

  it("formats overseas prices to two decimals and renders a signed fall rate", () => {
    const svg = renderStockActionView(view({
      instrument: { symbol: "AAPL", name: "Apple", market: "overseas" },
      session: "AFT",
      quote: {
        symbol: "AAPL",
        price: 182.5,
        changeRate: -0.68,
        sign: "fall",
        source: "rest",
        receivedAt: 100,
        sessionEpoch: 10,
      },
      connection: "BACKUP",
    }));

    expectValidSvg(svg);
    expect(svg).toContain("$182.50");
    expect(svg).toContain("▼ -0.68%");
    expect(svg).toContain("애프터");
    expect(svg).toContain("백업");
    expectConnectionTitle(svg, "#7dd3fc");
  });

  it("renders a red connection title for a broken quote", () => {
    const svg = renderStockActionView(view({ connection: "BROKEN" }));

    expectValidSvg(svg);
    expectConnectionTitle(svg, "#ff1744");
  });

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

  it("renders stale and refreshing control states without replacing quote data", () => {
    const stale = renderStockActionView(view({ connection: "BACKUP", stale: true }));
    const refreshing = renderStockActionView(view({ refreshing: true }));

    expect(stale).toContain("백업 · 지연");
    expectConnectionTitle(stale, "#7dd3fc");
    expect(refreshing).toContain("새로고침 중");
    expect(refreshing).toContain('data-role="loading-indicator"');
    expect(refreshing).toContain("72,100");
    expectConnectionTitle(refreshing, "#00c853");
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
  ])("renders a safe display error for invalid bounded quote values: %j", ({ price, changeRate }) => {
    const svg = renderStockActionView(view({
      quote: {
        ...view().quote!,
        price,
        changeRate,
      },
    }));

    expectValidSvg(svg);
    expect(svg).toContain("표시 오류");
    expect(svg).not.toContain("NaN");
    expect(svg).not.toContain("Infinity");
    expectNoConnectionTitle(svg);
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
