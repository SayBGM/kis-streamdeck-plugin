import { describe, expect, it, vi } from "vitest";
import type { StockData } from "../../types/index.js";

vi.mock("../../utils/timezone.js", () => ({
  getETTotalMinutes: vi.fn(() => 600),
  getKSTTotalMinutes: vi.fn(() => 600),
}));

import { renderConnectedCard, renderStockCard } from "../stock-card.js";

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
  });

  it("renders clearer connected copy on waiting-for-trades cards", () => {
    const svg = renderConnectedCard("Apple", "overseas");

    expect(svg).toContain("실시간 연결됨");
    expect(svg).toContain("데이터 대기");
  });
});
