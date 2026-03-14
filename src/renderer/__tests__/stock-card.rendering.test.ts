import { describe, expect, it, vi } from "vitest";
import type { StockData } from "../../types/index.js";

vi.mock("../../utils/timezone.js", () => ({
  getETDayOfWeek: vi.fn(() => 1),
  getETTotalMinutes: vi.fn(() => 600),
  getKSTDayOfWeek: vi.fn(() => 1),
  getKSTTotalMinutes: vi.fn(() => 600),
}));

import * as timezone from "../../utils/timezone.js";
import { renderConnectedCard, renderStockCard, renderWaitingCard } from "../stock-card.js";

const sampleData: StockData = {
  ticker: "AAPL",
  name: "Apple Inc.",
  price: 182.52,
  change: -1.25,
  changeRate: -0.68,
  sign: "fall",
};

describe("stock-card rendering", () => {
  it("renders ticker and broken connection label on stock cards", () => {
    const svg = renderStockCard(sampleData, "overseas", {
      connectionState: "BROKEN",
    });

    expect(svg).toContain("AAPL");
    expect(svg).toContain("연결 끊김");
    expect(svg).toContain("정규");
  });

  it("renders a refresh label when a manual refresh is in progress", () => {
    const svg = renderStockCard(sampleData, "overseas", {
      connectionState: "LIVE",
      isRefreshing: true,
    });

    expect(svg).toContain("새로고침 중");
    expect(svg).toContain('data-role="loading-indicator"');
  });

  it("renders clearer connected copy on waiting-for-trades cards", () => {
    const svg = renderConnectedCard("Apple", "overseas");

    expect(svg).toContain("실시간 연결됨");
    expect(svg).toContain("데이터 대기");
    expect(svg).toContain('data-role="loading-indicator"');
  });

  it("renders a loading indicator on waiting cards", () => {
    const svg = renderWaitingCard("Apple", "overseas");

    expect(svg).toContain("초기화 중");
    expect(svg).toContain('data-role="loading-indicator"');
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
