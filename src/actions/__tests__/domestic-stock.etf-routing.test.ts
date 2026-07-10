import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elgato/streamdeck", () => ({ SingletonAction: class {} }));

import { DomesticStockAction } from "../domestic-stock.js";

const target = {
  appear: vi.fn(async () => undefined),
  updateSettings: vi.fn(async () => undefined),
  disappear: vi.fn(async () => undefined),
  manualRefresh: vi.fn(async () => undefined),
};

function action(id = "etf-1") {
  return {
    id,
    isKey: () => true,
    setImage: vi.fn(async () => undefined),
    setSettings: vi.fn(async () => undefined),
  };
}

function etfSettings() {
  return {
    stockCode: " 0210a0 ",
    stockName: "테스트 ETF",
    instrumentType: "etf",
  };
}

describe("DomesticStockAction ETF routing settings", () => {
  beforeEach(() => vi.clearAllMocks());

  it("normalizes ETF settings before the controller resolves its adapter", async () => {
    const wrapper = new DomesticStockAction(target);
    await wrapper.onWillAppear({
      action: action(),
      payload: { settings: etfSettings() },
    } as never);

    expect(target.appear).toHaveBeenCalledWith(expect.objectContaining({
      settings: expect.objectContaining({
        stockCode: "0210A0",
        instrumentType: "etf",
      }),
    }));
  });

  it("defaults legacy settings to stock", async () => {
    const wrapper = new DomesticStockAction(target);
    await wrapper.onWillAppear({
      action: action(),
      payload: { settings: { stockCode: "005930", stockName: "삼성전자" } },
    } as never);

    expect(target.appear).toHaveBeenCalledWith(expect.objectContaining({
      settings: expect.objectContaining({ instrumentType: "stock" }),
    }));
  });

  it("keeps ETF routing when settings are received again", async () => {
    const wrapper = new DomesticStockAction(target);
    await wrapper.onDidReceiveSettings({
      action: action(),
      payload: { settings: etfSettings() },
    } as never);

    expect(target.updateSettings).toHaveBeenCalledWith(
      "etf-1",
      expect.objectContaining({ stockCode: "0210A0", instrumentType: "etf" }),
    );
  });

  it("preserves unknown action fields during ETF migration", async () => {
    const wrapper = new DomesticStockAction(target);
    await wrapper.onWillAppear({
      action: action(),
      payload: { settings: { ...etfSettings(), futureOption: "preserved" } },
    } as never);

    expect(target.appear).toHaveBeenCalledWith(expect.objectContaining({
      settings: expect.objectContaining({ futureOption: "preserved" }),
    }));
  });

  it("manual refresh delegates by action id without reinterpreting stale payload settings", async () => {
    const wrapper = new DomesticStockAction(target);
    await wrapper.onKeyDown({
      action: action(),
      payload: { settings: { instrumentType: "stock" } },
    } as never);

    expect(target.manualRefresh).toHaveBeenCalledWith("etf-1");
    expect(target.appear).not.toHaveBeenCalled();
  });
});
