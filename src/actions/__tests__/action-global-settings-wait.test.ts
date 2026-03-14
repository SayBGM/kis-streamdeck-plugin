import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const waitUntilReady = vi.fn();

vi.mock("@elgato/streamdeck", () => ({
  SingletonAction: class {
    readonly manifestId = "";
  },
}));

vi.mock("../../kis/websocket-manager.js", () => ({
  kisWebSocket: {
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn(),
  },
}));

vi.mock("../../kis/domestic-parser.js", () => ({
  parseDomesticData: vi.fn(),
}));

vi.mock("../../kis/overseas-parser.js", () => ({
  parseOverseasData: vi.fn(),
}));

vi.mock("../../kis/rest-price.js", () => ({
  fetchDomesticPrice: vi.fn().mockResolvedValue(null),
  fetchOverseasPrice: vi.fn().mockResolvedValue(null),
}));

const renderErrorCard = vi.fn().mockReturnValue("<error/>");
const renderWaitingCard = vi.fn().mockReturnValue("<waiting/>");

vi.mock("../../renderer/stock-card.js", () => ({
  renderStockCard: vi.fn().mockReturnValue("<svg/>"),
  renderWaitingCard,
  renderConnectedCard: vi.fn().mockReturnValue("<svg/>"),
  renderSetupCard: vi.fn().mockReturnValue("<svg/>"),
  renderErrorCard,
  renderRecoveryCard: vi.fn().mockReturnValue("<svg/>"),
  svgToDataUri: vi.fn().mockImplementation((_svg: string, key: string) => `data:${key}`),
}));

vi.mock("../../kis/settings-store.js", () => ({
  kisGlobalSettings: {
    get: vi.fn().mockReturnValue(null),
    waitUntilReady,
  },
}));

vi.mock("../../utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe("action startup waits for global settings", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    waitUntilReady.mockReset();
    renderErrorCard.mockClear();
    renderWaitingCard.mockClear();
    waitUntilReady.mockResolvedValue({
      appKey: "app-key",
      appSecret: "app-secret",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("waits before showing missing credential error for domestic actions", async () => {
    const mod = await import("../../actions/domestic-stock.js");
    const action = new mod.DomesticStockAction();
    const setImage = vi.fn().mockResolvedValue(undefined);

    await action.onWillAppear({
      action: { id: "domestic-1", setImage },
      payload: { settings: { stockCode: "005930", stockName: "삼성전자" } },
    } as never);

    expect(waitUntilReady).toHaveBeenCalledWith(15000);
    expect(renderErrorCard).not.toHaveBeenCalled();
    expect(renderWaitingCard).toHaveBeenCalledWith("삼성전자", "domestic");
  });

  it("waits before showing missing credential error for overseas actions", async () => {
    const mod = await import("../../actions/overseas-stock.js");
    const action = new mod.OverseasStockAction();
    const setImage = vi.fn().mockResolvedValue(undefined);

    await action.onWillAppear({
      action: { id: "overseas-1", setImage },
      payload: {
        settings: { ticker: "TSLA", stockName: "테슬라", exchange: "NAS" },
      },
    } as never);

    expect(waitUntilReady).toHaveBeenCalledWith(15000);
    expect(renderErrorCard).not.toHaveBeenCalled();
    expect(renderWaitingCard).toHaveBeenCalledWith("테슬라", "overseas");
  });
});
