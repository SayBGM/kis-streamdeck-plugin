import { describe, expect, it, vi } from "vitest";

vi.mock("@elgato/streamdeck", () => ({ SingletonAction: class {} }));

import { DomesticStockAction } from "../domestic-stock.js";
import { OverseasStockAction } from "../overseas-stock.js";

function controller() {
  return {
    appear: vi.fn(async () => undefined),
    updateSettings: vi.fn(async () => undefined),
    disappear: vi.fn(async () => undefined),
    manualRefresh: vi.fn(async () => undefined),
  };
}

describe("stock action lifecycle wrapper cleanup", () => {
  it("delegates domestic disappear even when no appear completed", async () => {
    const target = controller();
    const action = new DomesticStockAction(target);

    await action.onWillDisappear({ action: { id: "domestic-1" } } as never);

    expect(target.disappear).toHaveBeenCalledWith("domestic-1");
  });

  it("isolates a late overseas disappear rejection", async () => {
    const target = controller();
    target.disappear.mockRejectedValueOnce(new Error("late"));
    const action = new OverseasStockAction(target);

    await expect(action.onWillDisappear({
      action: { id: "overseas-1" },
    } as never)).resolves.toBeUndefined();
  });
});
