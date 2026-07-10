import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elgato/streamdeck", () => ({
  default: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
  SingletonAction: class {},
}));

import { DomesticStockAction } from "../domestic-stock.js";
import { OverseasStockAction } from "../overseas-stock.js";

interface ControllerFake<Settings> {
  appear: ReturnType<typeof vi.fn<(input: unknown) => Promise<void>>>;
  updateSettings: ReturnType<typeof vi.fn<(actionId: string, settings: Settings) => Promise<void>>>;
  disappear: ReturnType<typeof vi.fn<(actionId: string) => Promise<void>>>;
  manualRefresh: ReturnType<typeof vi.fn<(actionId: string) => Promise<void>>>;
}

function controller<Settings>(): ControllerFake<Settings> {
  return {
    appear: vi.fn(async () => undefined),
    updateSettings: vi.fn(async () => undefined),
    disappear: vi.fn(async () => undefined),
    manualRefresh: vi.fn(async () => undefined),
  };
}

function keyAction(id = "action-1") {
  return {
    id,
    isKey: () => true,
    setImage: vi.fn(async () => undefined),
    setSettings: vi.fn(async () => undefined),
  };
}

describe("thin Stream Deck stock action wrappers", () => {
  beforeEach(() => vi.clearAllMocks());

  it("migrates and persists domestic ETF settings before delegating appear", async () => {
    const target = controller<Record<string, unknown>>();
    const wrapper = new DomesticStockAction(target);
    const action = keyAction("domestic-1");

    await wrapper.onWillAppear({
      action,
      payload: {
        settings: {
          stockCode: " 0210a0 ",
          stockName: " 테스트 ETF ",
          instrumentType: "etf",
          retained: "value",
        },
      },
    } as never);

    const expected = expect.objectContaining({
      schemaVersion: 2,
      stockCode: "0210A0",
      stockName: "테스트 ETF",
      instrumentType: "etf",
      retained: "value",
    });
    expect(action.setSettings).toHaveBeenCalledWith(expected);
    expect(target.appear).toHaveBeenCalledWith({
      actionId: "domestic-1",
      settings: expected,
      actionPort: { setImage: expect.any(Function) },
    });

    const input = target.appear.mock.calls[0]?.[0] as {
      actionPort: { setImage(image: string): Promise<void> };
    };
    await input.actionPort.setImage("image:data");
    expect(action.setImage).toHaveBeenCalledWith("image:data");
  });

  it("does not persist an already migrated action setting or create a settings loop", async () => {
    const target = controller<Record<string, unknown>>();
    const wrapper = new DomesticStockAction(target);
    const action = keyAction();
    const settings = {
      schemaVersion: 2,
      stockCode: "005930",
      stockName: "삼성전자",
      instrumentType: "stock",
    };

    await wrapper.onDidReceiveSettings({ action, payload: { settings } } as never);

    expect(action.setSettings).not.toHaveBeenCalled();
    expect(target.updateSettings).toHaveBeenCalledOnce();
    expect(target.updateSettings).toHaveBeenCalledWith("action-1", settings);
  });

  it("normalizes overseas settings and delegates all remaining lifecycle events", async () => {
    const target = controller<Record<string, unknown>>();
    const wrapper = new OverseasStockAction(target);
    const action = keyAction("overseas-1");

    await wrapper.onWillAppear({
      action,
      payload: {
        settings: { ticker: " aapl ", stockName: " Apple ", exchange: "nas" },
      },
    } as never);
    await wrapper.onDidReceiveSettings({
      action,
      payload: {
        settings: {
          schemaVersion: 2,
          ticker: "MSFT",
          stockName: "Microsoft",
          exchange: "NYS",
        },
      },
    } as never);
    await wrapper.onKeyDown({ action, payload: { settings: {} } } as never);
    await wrapper.onWillDisappear({ action, payload: { settings: {} } } as never);

    expect(target.appear).toHaveBeenCalledWith(expect.objectContaining({
      actionId: "overseas-1",
      settings: expect.objectContaining({
        schemaVersion: 2,
        ticker: "AAPL",
        stockName: "Apple",
        exchange: "NAS",
      }),
    }));
    expect(target.updateSettings).toHaveBeenCalledWith(
      "overseas-1",
      expect.objectContaining({ ticker: "MSFT", exchange: "NYS" }),
    );
    expect(target.manualRefresh).toHaveBeenCalledWith("overseas-1");
    expect(target.disappear).toHaveBeenCalledWith("overseas-1");
  });

  it("isolates migration persistence and late controller failures", async () => {
    const target = controller<Record<string, unknown>>();
    target.appear.mockRejectedValueOnce(new Error("late controller failure"));
    const wrapper = new DomesticStockAction(target);
    const action = keyAction();
    action.setSettings.mockRejectedValueOnce(new Error("persistence failure"));

    await expect(wrapper.onWillAppear({
      action,
      payload: { settings: { stockCode: "005930", stockName: "삼성전자" } },
    } as never)).resolves.toBeUndefined();

    expect(target.appear).toHaveBeenCalledOnce();
  });

  it("rejects accessor-backed action settings without invoking the accessor", async () => {
    const target = controller<Record<string, unknown>>();
    const wrapper = new DomesticStockAction(target);
    const action = keyAction();
    const getter = vi.fn(() => "005930");
    const settings = Object.defineProperty({}, "stockCode", {
      enumerable: true,
      get: getter,
    });

    await expect(wrapper.onWillAppear({
      action,
      payload: { settings },
    } as never)).resolves.toBeUndefined();

    expect(getter).not.toHaveBeenCalled();
    expect(target.appear).not.toHaveBeenCalled();
    expect(action.setSettings).not.toHaveBeenCalled();
  });
});
