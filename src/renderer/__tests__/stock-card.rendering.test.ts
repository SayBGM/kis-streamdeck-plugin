import { Window, type Document } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorType, type StockData, type StreamConnectionState } from "../../types/index.js";

vi.mock("../../utils/timezone.js", () => ({
  getETDayOfWeek: vi.fn(() => 1),
  getETTotalMinutes: vi.fn(() => 600),
  getKSTDayOfWeek: vi.fn(() => 1),
  getKSTTotalMinutes: vi.fn(() => 600),
}));

import * as timezone from "../../utils/timezone.js";
import {
  renderConnectedCard,
  renderErrorCard,
  renderRecoveryCard,
  renderSetupCard,
  renderStockCard,
  renderWaitingCard,
} from "../stock-card.js";

const sampleData: StockData = {
  ticker: "AAPL",
  name: "Apple Inc.",
  price: 182.52,
  change: -1.25,
  changeRate: -0.68,
  sign: "fall",
};

function expectNoLegacyStatusBar(document: Document): void {
  expect(
    document.querySelector('rect[x="8"][y="136"][width="128"][height="4"]'),
  ).toBeNull();
}

function expectConnectionTitle(svg: string, color: string): void {
  const window = new Window();
  const document = new window.DOMParser().parseFromString(svg, "image/svg+xml");

  expect(document.querySelector('[data-role="connection-dot"]')?.getAttribute("fill")).toBe(color);
  expect(document.querySelector('[data-role="stock-name"]')?.getAttribute("fill")).toBe(color);
  expect(document.querySelector('[data-role="stock-name"]')?.getAttribute("x")).toBe("12");
  expectNoLegacyStatusBar(document);
  window.close();
}

function expectNoConnectionTitle(svg: string): void {
  const window = new Window();
  const document = new window.DOMParser().parseFromString(svg, "image/svg+xml");

  expect(document.querySelector('[data-role="connection-dot"]')).toBeNull();
  expect(document.querySelector('[data-role="stock-name"]')).toBeNull();
  expectNoLegacyStatusBar(document);
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

function expectLegacyChangeBaseline(svg: string): void {
  const window = new Window();
  const document = new window.DOMParser().parseFromString(svg, "image/svg+xml");

  expect(document.querySelector('text[x="12"][font-size="14"]')?.getAttribute("y")).toBe("116");
  expect(document.querySelector('text[x="132"][font-size="14"]')?.getAttribute("y")).toBe("116");
  window.close();
}

describe("stock-card rendering", () => {
  beforeEach(() => {
    vi.mocked(timezone.getETDayOfWeek).mockReturnValue(1);
    vi.mocked(timezone.getETTotalMinutes).mockReturnValue(600);
    vi.mocked(timezone.getKSTDayOfWeek).mockReturnValue(1);
    vi.mocked(timezone.getKSTTotalMinutes).mockReturnValue(600);
  });

  it("renders ticker and price data without a broken connection label on stock cards", () => {
    const svg = renderStockCard(sampleData, "overseas", {
      connectionState: "BROKEN",
    });

    expect(svg).toContain("AAPL");
    expect(svg).toContain("$182.52");
    expect(svg).toContain("0.68%");
    expectNoQuoteStatus(svg);
    expectLegacyChangeBaseline(svg);
    expect(svg).toContain("정규");
  });

  it.each<{
    connectionState: StreamConnectionState | null | undefined;
    isStale?: boolean;
    isRefreshing?: boolean;
    color: string;
  }>([
    { connectionState: "LIVE", color: "#00c853" },
    { connectionState: "BACKUP", isStale: true, color: "#7dd3fc" },
    { connectionState: "BROKEN", isRefreshing: true, color: "#ff1744" },
    { connectionState: null, color: "#7f8aa8" },
    { connectionState: undefined, isStale: true, color: "#7f8aa8" },
  ])("uses $color for a $connectionState legacy stock title without quote status", ({
    connectionState,
    isStale,
    isRefreshing,
    color,
  }) => {
    const svg = renderStockCard(sampleData, "overseas", {
      connectionState,
      isStale,
      isRefreshing,
    });

    expectConnectionTitle(svg, color);
    expectNoQuoteStatus(svg);
    expectLegacyChangeBaseline(svg);
    expect(svg).toContain("AAPL");
    expect(svg).toContain("$182.52");
    expect(svg).toContain("0.68%");
  });

  it("renders clearer connected copy on waiting-for-trades cards", () => {
    const svg = renderConnectedCard("Apple", "overseas");

    expect(svg).toContain("실시간 연결됨");
    expect(svg).toContain("데이터 대기");
    expect(svg).toContain('data-role="loading-indicator"');
    expectConnectionTitle(svg, "#00c853");
  });

  it("renders a loading indicator on waiting cards", () => {
    const svg = renderWaitingCard("Apple", "overseas");

    expect(svg).toContain("초기화 중");
    expect(svg).toContain('data-role="loading-indicator"');
    expectConnectionTitle(svg, "#7f8aa8");
  });

  it("uses the backup title and normal-waiting copy on closed connected cards", () => {
    vi.mocked(timezone.getETTotalMinutes).mockReturnValue(1_300);

    const svg = renderConnectedCard("Apple", "overseas");

    expect(svg).toContain("정상 대기");
    expect(svg).not.toContain("실시간 연결됨");
    expectConnectionTitle(svg, "#7dd3fc");
  });

  it("uses a live title on recovery cards without a bottom bar", () => {
    const svg = renderRecoveryCard("Apple");

    expect(svg).toContain("연결 회복");
    expectConnectionTitle(svg, "#00c853");
  });

  it.each([
    { svg: renderErrorCard(ErrorType.NETWORK_ERROR), copy: "연결 오류" },
    { svg: renderSetupCard("API 키 입력"), copy: "설정 필요" },
  ])("keeps the dedicated $copy card without a connection title or bottom bar", ({ svg, copy }) => {
    expect(svg).toContain(copy);
    expectNoConnectionTitle(svg);
  });

  it("treats weekend sessions as closed instead of regular", () => {
    vi.mocked(timezone.getETDayOfWeek).mockReturnValue(0);

    const svg = renderStockCard(sampleData, "overseas", {
      connectionState: "LIVE",
    });

    expect(svg).toContain("마감");
    expect(svg).not.toContain("정규");
  });
});
