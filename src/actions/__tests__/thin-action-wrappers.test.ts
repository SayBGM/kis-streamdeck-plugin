import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elgato/streamdeck", () => ({
  default: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
  SingletonAction: class {},
}));

import { DomesticStockAction } from "../domestic-stock.js";
import { OverseasStockAction } from "../overseas-stock.js";
import { KisError } from "../../core/errors.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function diagnostics() {
  return { record: vi.fn() };
}

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
    setImage: vi.fn<(image?: string) => Promise<void>>(async () => undefined),
    setSettings: vi.fn<(settings: Record<string, unknown>) => Promise<void>>(
      async () => undefined,
    ),
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

  it("delegates appear before an asynchronous migration write settles", async () => {
    const target = controller<Record<string, unknown>>();
    const delayedWrite = deferred();
    const action = keyAction();
    action.setSettings.mockImplementationOnce(() => delayedWrite.promise);
    const wrapper = new DomesticStockAction(target, diagnostics());

    await expect(wrapper.onWillAppear({
      action,
      payload: { settings: { stockCode: "005930", stockName: "삼성전자" } },
    } as never)).resolves.toBeUndefined();

    expect(target.appear).toHaveBeenCalledOnce();
    expect(action.setSettings).toHaveBeenCalledOnce();
    delayedWrite.resolve();
    await delayedWrite.promise;
  });

  it("invalidates a pending appear migration when the action disappears", async () => {
    const target = controller<Record<string, unknown>>();
    const delayedAppear = deferred();
    target.appear.mockImplementationOnce(() => delayedAppear.promise);
    const action = keyAction();
    const wrapper = new DomesticStockAction(target, diagnostics());

    const appear = wrapper.onWillAppear({
      action,
      payload: { settings: { stockCode: "005930", stockName: "삼성전자" } },
    } as never);
    await vi.waitFor(() => expect(target.appear).toHaveBeenCalledOnce());
    await wrapper.onWillDisappear({ action } as never);
    delayedAppear.resolve();
    await appear;

    expect(action.setSettings).not.toHaveBeenCalled();
    expect(target.disappear).toHaveBeenCalledWith("action-1");
  });

  it("serializes consecutive A/B migrations so only the latest setting wins", async () => {
    const target = controller<Record<string, unknown>>();
    const firstWrite = deferred();
    const action = keyAction();
    action.setSettings
      .mockImplementationOnce(() => firstWrite.promise)
      .mockResolvedValueOnce(undefined);
    const wrapper = new DomesticStockAction(target, diagnostics());

    await wrapper.onWillAppear({
      action,
      payload: { settings: { stockCode: "005930", stockName: "A" } },
    } as never);
    await vi.waitFor(() => expect(action.setSettings).toHaveBeenCalledOnce());
    await wrapper.onDidReceiveSettings({
      action,
      payload: { settings: { stockCode: "000660", stockName: "B" } },
    } as never);

    expect(target.updateSettings).toHaveBeenCalledWith(
      "action-1",
      expect.objectContaining({ stockCode: "000660", stockName: "B" }),
    );
    expect(action.setSettings).toHaveBeenCalledOnce();
    firstWrite.resolve();
    await vi.waitFor(() => expect(action.setSettings).toHaveBeenCalledTimes(2));
    expect(action.setSettings.mock.calls[1]?.[0]).toMatchObject({
      stockCode: "000660",
      stockName: "B",
    });
  });

  it("suppresses a stale internal migration event after a newer setting is active", async () => {
    const target = controller<Record<string, unknown>>();
    const firstWrite = deferred();
    const action = keyAction();
    action.setSettings.mockImplementationOnce(() => firstWrite.promise);
    const wrapper = new DomesticStockAction(target, diagnostics());

    await wrapper.onWillAppear({
      action,
      payload: { settings: { stockCode: "005930", stockName: "A" } },
    } as never);
    await vi.waitFor(() => expect(action.setSettings).toHaveBeenCalledOnce());
    await wrapper.onDidReceiveSettings({
      action,
      payload: { settings: { stockCode: "000660", stockName: "B" } },
    } as never);
    target.updateSettings.mockClear();

    await wrapper.onDidReceiveSettings({
      action,
      payload: { settings: action.setSettings.mock.calls[0]?.[0] },
    } as never);

    expect(target.updateSettings).not.toHaveBeenCalled();
    firstWrite.resolve();
  });

  it("records only a safe generic action error when an isolated callback throws", async () => {
    const target = controller<Record<string, unknown>>();
    target.appear.mockRejectedValueOnce(new Error("raw-secret raw-token"));
    const sink = diagnostics();
    const wrapper = new DomesticStockAction(target, sink);

    await wrapper.onWillAppear({
      action: keyAction(),
      payload: { settings: { stockCode: "005930", stockName: "삼성전자" } },
    } as never);

    expect(sink.record).toHaveBeenCalledOnce();
    const recorded = sink.record.mock.calls[0]?.[0];
    expect(recorded).toBeInstanceOf(KisError);
    expect(recorded).toMatchObject({ code: "SETTINGS", scope: "action" });
    expect(JSON.stringify(recorded)).not.toContain("raw-secret");
    expect(JSON.stringify(recorded)).not.toContain("raw-token");
  });
});
