/** Rendering policy moved to StockActionController + RenderScheduler. These tests
 * preserve the SDK boundary: the thin wrapper never renders independently. */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elgato/streamdeck", () => ({ SingletonAction: class {} }));

import { DomesticStockAction } from "../domestic-stock.js";

function controller() {
  return {
    appear: vi.fn(async (_input: unknown) => undefined),
    updateSettings: vi.fn(async () => undefined),
    disappear: vi.fn(async () => undefined),
    manualRefresh: vi.fn(async () => undefined),
  };
}

function action() {
  return {
    id: "action-1",
    isKey: () => true,
    setImage: vi.fn(async () => undefined),
    setSettings: vi.fn(async () => undefined),
  };
}

function appearEvent(target = action()) {
  return {
    action: target,
    payload: {
      settings: {
        schemaVersion: 2,
        stockCode: "005930",
        stockName: "삼성전자",
        instrumentType: "stock",
      },
    },
  };
}

describe("DomesticStockAction rendering boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not render before the controller submits a view", async () => {
    const target = controller();
    const sdkAction = action();
    await new DomesticStockAction(target).onWillAppear(appearEvent(sdkAction) as never);
    expect(sdkAction.setImage).not.toHaveBeenCalled();
  });

  it("passes controller output through the plain action port", async () => {
    const target = controller();
    target.appear.mockImplementationOnce(async (input: unknown) => {
      const port = (input as { actionPort: { setImage(image: string): Promise<void> } }).actionPort;
      await port.setImage("data:image/svg+xml,one");
    });
    const sdkAction = action();

    await new DomesticStockAction(target).onWillAppear(appearEvent(sdkAction) as never);

    expect(sdkAction.setImage).toHaveBeenCalledWith("data:image/svg+xml,one");
  });

  it("does not coalesce images because scheduling belongs to RenderScheduler", async () => {
    const target = controller();
    target.appear.mockImplementationOnce(async (input: unknown) => {
      const port = (input as { actionPort: { setImage(image: string): Promise<void> } }).actionPort;
      await port.setImage("first");
      await port.setImage("last");
    });
    const sdkAction = action();

    await new DomesticStockAction(target).onWillAppear(appearEvent(sdkAction) as never);

    expect(sdkAction.setImage.mock.calls).toEqual([["first"], ["last"]]);
  });

  it("isolates a controller rejection caused by a late image failure", async () => {
    const target = controller();
    const sdkAction = action();
    sdkAction.setImage.mockRejectedValueOnce(new Error("gone"));
    target.appear.mockImplementationOnce(async (input: unknown) => {
      const port = (input as { actionPort: { setImage(image: string): Promise<void> } }).actionPort;
      await port.setImage("late");
    });

    await expect(new DomesticStockAction(target).onWillAppear(
      appearEvent(sdkAction) as never,
    )).resolves.toBeUndefined();
  });

  it("settings receipt delegates policy changes without direct rendering", async () => {
    const target = controller();
    const sdkAction = action();
    await new DomesticStockAction(target).onDidReceiveSettings(
      appearEvent(sdkAction) as never,
    );
    expect(target.updateSettings).toHaveBeenCalledOnce();
    expect(sdkAction.setImage).not.toHaveBeenCalled();
  });

  it("manual refresh delegates without direct rendering", async () => {
    const target = controller();
    const sdkAction = action();
    await new DomesticStockAction(target).onKeyDown({ action: sdkAction } as never);
    expect(target.manualRefresh).toHaveBeenCalledOnce();
    expect(sdkAction.setImage).not.toHaveBeenCalled();
  });

  it("ignores dial appearances because the manifest action is a key", async () => {
    const target = controller();
    const sdkAction = { ...action(), isKey: () => false };
    await new DomesticStockAction(target).onWillAppear(appearEvent(sdkAction) as never);
    expect(target.appear).not.toHaveBeenCalled();
  });

  it("keeps the exact manifest UUID", () => {
    expect(new DomesticStockAction(controller()).manifestId)
      .toBe("com.kis.streamdeck.domestic-stock");
  });
});
