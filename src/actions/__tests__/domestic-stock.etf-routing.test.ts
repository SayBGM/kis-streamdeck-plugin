import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TR_ID_DOMESTIC } from "../../types/index.js";

const mocks = vi.hoisted(() => ({
  fetchDomesticPrice: vi.fn().mockResolvedValue(null),
  subscribe: vi.fn().mockResolvedValue(undefined),
  unsubscribe: vi.fn(),
  getGlobalSettings: vi.fn(),
}));

vi.mock("@elgato/streamdeck", () => ({
  SingletonAction: class {
    readonly manifestId = "";
  },
}));

vi.mock("../../kis/websocket-manager.js", () => ({
  kisWebSocket: {
    subscribe: mocks.subscribe,
    unsubscribe: mocks.unsubscribe,
  },
}));

vi.mock("../../kis/domestic-parser.js", () => ({
  parseDomesticData: vi.fn(),
}));

vi.mock("../../kis/rest-price.js", () => ({
  fetchDomesticPrice: mocks.fetchDomesticPrice,
}));

vi.mock("../../renderer/stock-card.js", () => ({
  renderStockCard: vi.fn().mockReturnValue("<svg/>"),
  renderWaitingCard: vi.fn().mockReturnValue("<svg/>"),
  renderConnectedCard: vi.fn().mockReturnValue("<svg/>"),
  renderSetupCard: vi.fn().mockReturnValue("<svg/>"),
  renderErrorCard: vi.fn().mockReturnValue("<svg/>"),
  renderRecoveryCard: vi.fn().mockReturnValue("<svg/>"),
  svgToDataUri: vi.fn().mockReturnValue("data:image/svg+xml,test"),
}));

vi.mock("../../kis/settings-store.js", () => ({
  kisGlobalSettings: {
    get: mocks.getGlobalSettings,
    waitUntilReady: vi.fn(),
  },
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { DomesticStockAction } from "../domestic-stock.js";

function etfSettings() {
  return {
    stockCode: " 0210a0 ",
    stockName: "테스트 ETF",
    instrumentType: "etf",
  };
}

describe("DomesticStockAction ETF routing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.getGlobalSettings.mockReturnValue({
      appKey: "app-key",
      appSecret: "app-secret",
    });
    mocks.fetchDomesticPrice.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("normalizes an ETF code, routes its snapshot, and keeps unified live trades", async () => {
    const action = new DomesticStockAction();

    await action.onWillAppear({
      action: { id: "etf-1", setImage: vi.fn() },
      payload: { settings: etfSettings() },
    } as never);

    expect(mocks.fetchDomesticPrice).toHaveBeenCalledWith(
      "0210A0",
      "테스트 ETF",
      "etf",
    );
    expect(mocks.subscribe).toHaveBeenCalledWith(
      TR_ID_DOMESTIC,
      "0210A0",
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("defaults legacy settings to stock on manual refresh", async () => {
    const action = new DomesticStockAction();

    await action.onKeyDown({
      action: { id: "stock-1", setImage: vi.fn() },
      payload: { settings: { stockCode: "005930", stockName: "삼성전자" } },
    } as never);

    expect(mocks.fetchDomesticPrice).toHaveBeenCalledWith(
      "005930",
      "삼성전자",
      "stock",
    );
  });

  it("keeps ETF routing when settings are received again", async () => {
    const action = new DomesticStockAction();

    await action.onDidReceiveSettings({
      action: { id: "etf-1", setImage: vi.fn() },
      payload: { settings: etfSettings() },
    } as never);

    expect(mocks.fetchDomesticPrice).toHaveBeenCalledWith(
      "0210A0",
      "테스트 ETF",
      "etf",
    );
  });

  it("keeps ETF routing for the initial retry", async () => {
    const action = new DomesticStockAction();

    await action.onWillAppear({
      action: { id: "etf-1", setImage: vi.fn() },
      payload: { settings: etfSettings() },
    } as never);
    await vi.advanceTimersByTimeAsync(4_000);

    expect(mocks.fetchDomesticPrice).toHaveBeenNthCalledWith(
      2,
      "0210A0",
      "테스트 ETF",
      "etf",
    );
  });

  it("keeps ETF routing while polling", async () => {
    mocks.getGlobalSettings.mockReturnValue({
      appKey: "app-key",
      appSecret: "app-secret",
      updateMode: "poll",
      pollIntervalSec: "30",
    });
    const action = new DomesticStockAction();

    await action.onWillAppear({
      action: { id: "etf-1", setImage: vi.fn() },
      payload: { settings: etfSettings() },
    } as never);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(mocks.fetchDomesticPrice).toHaveBeenNthCalledWith(
      2,
      "0210A0",
      "테스트 ETF",
      "etf",
    );
  });
});
