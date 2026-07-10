import { describe, expect, it, vi } from "vitest";

vi.mock("@elgato/streamdeck", () => ({ SingletonAction: class {} }));

import { DomesticStockAction } from "../domestic-stock.js";
import { OverseasStockAction } from "../overseas-stock.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function actionEvent(settings: Record<string, unknown>) {
  return {
    action: {
      id: "action-1",
      isKey: () => true,
      setSettings: vi.fn(async () => undefined),
      setImage: vi.fn(async () => undefined),
    },
    payload: { settings },
  };
}

function waitingController() {
  const ready = deferred();
  return {
    ready,
    port: {
      appear: vi.fn(() => ready.promise),
      updateSettings: vi.fn(async () => undefined),
      disappear: vi.fn(async () => undefined),
      manualRefresh: vi.fn(async () => undefined),
    },
  };
}

describe("action readiness barrier delegation", () => {
  it("keeps a domestic appear pending until the controller readiness barrier opens", async () => {
    const target = waitingController();
    const wrapper = new DomesticStockAction(target.port);
    let settled = false;
    const operation = wrapper.onWillAppear(actionEvent({ stockCode: "005930" }) as never)
      .then(() => { settled = true; });

    await Promise.resolve();
    expect(settled).toBe(false);
    target.ready.resolve();
    await operation;
    expect(settled).toBe(true);
  });

  it("keeps an overseas appear pending until the controller readiness barrier opens", async () => {
    const target = waitingController();
    const wrapper = new OverseasStockAction(target.port);
    let settled = false;
    const operation = wrapper.onWillAppear(actionEvent({ ticker: "AAPL", exchange: "NAS" }) as never)
      .then(() => { settled = true; });

    await Promise.resolve();
    expect(settled).toBe(false);
    target.ready.resolve();
    await operation;
    expect(settled).toBe(true);
  });
});
