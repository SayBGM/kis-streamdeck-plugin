/**
 * Characterization tests for DomesticStockAction.renderStockData()
 *
 * Verifies render key deduplication behavior (existing logic, preserved by DDD).
 * Tests debouncing behavior added in SPEC-PERF-001.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { StockData } from "../../types/index.js";

// Mock all external dependencies
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

vi.mock("../../kis/rest-price.js", () => ({
  fetchDomesticPrice: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../renderer/stock-card.js", () => ({
  renderStockCard: vi.fn().mockReturnValue("<svg/>"),
  renderWaitingCard: vi.fn().mockReturnValue("<svg/>"),
  renderConnectedCard: vi.fn().mockReturnValue("<svg/>"),
  renderSetupCard: vi.fn().mockReturnValue("<svg/>"),
  svgToDataUri: vi.fn().mockImplementation((svg: string, key: string) => `data:${key}`),
  getMarketSession: vi.fn().mockReturnValue("REG"),
}));

vi.mock("../../types/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../types/index.js")>();
  return {
    ...actual,
    TR_ID_DOMESTIC: "H0STCNT0",
  };
});

vi.mock("../../utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const makeStockData = (price: number): StockData => ({
  ticker: "005930",
  name: "삼성전자",
  price,
  change: 200,
  changeRate: 0.27,
  sign: "rise",
});

type PrivateAction = {
  renderStockData: (
    actionId: string,
    action: { setImage(image: string): Promise<void> | void; id?: string },
    data: StockData,
    options: { source: "live" | "backup"; force?: boolean }
  ) => Promise<void>;
  connectionStateByAction: Map<string, string>;
  lastRenderKeyByAction: Map<string, string>;
  pendingRenderByAction: Map<string, { action: { setImage(image: string): Promise<void> | void }; dataUri: string; renderKey: string }>;
  flushTimer: ReturnType<typeof setTimeout> | null;
  flushPendingRenders: () => void;
};

describe("DomesticStockAction.renderStockData() — characterization tests", () => {
  let action: PrivateAction;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();

    // Re-import after reset so mocks are applied fresh
    const mod = await import("../../actions/domestic-stock.js");
    action = new mod.DomesticStockAction() as unknown as PrivateAction;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("should enqueue setImage in debounce queue and NOT call immediately", async () => {
    const mockAction = { setImage: vi.fn().mockResolvedValue(undefined) };
    const data = makeStockData(75400);
    action.connectionStateByAction.set("action-1", "LIVE");

    await action.renderStockData("action-1", mockAction, data, { source: "live" });

    // setImage should NOT be called immediately (debounced)
    expect(mockAction.setImage).not.toHaveBeenCalled();
    expect(action.pendingRenderByAction.size).toBe(1);
  });

  it("should call setImage after 50ms debounce timer fires", async () => {
    const mockAction = { setImage: vi.fn().mockResolvedValue(undefined) };
    const data = makeStockData(75400);
    action.connectionStateByAction.set("action-1", "LIVE");

    await action.renderStockData("action-1", mockAction, data, { source: "live" });

    expect(mockAction.setImage).not.toHaveBeenCalled();

    // Advance timer 50ms
    vi.advanceTimersByTime(50);

    expect(mockAction.setImage).toHaveBeenCalledTimes(1);
    expect(action.pendingRenderByAction.size).toBe(0);
    expect(action.flushTimer).toBeNull();
  });

  it("last-write-wins: multiple updates in 50ms window → only last setImage called", async () => {
    const mockAction = { setImage: vi.fn().mockResolvedValue(undefined) };
    action.connectionStateByAction.set("action-1", "LIVE");

    // Enqueue 3 renders with different prices
    await action.renderStockData("action-1", mockAction, makeStockData(100), { source: "live" });
    await action.renderStockData("action-1", mockAction, makeStockData(101), { source: "live" });
    await action.renderStockData("action-1", mockAction, makeStockData(102), { source: "live" });

    expect(mockAction.setImage).not.toHaveBeenCalled();
    expect(action.pendingRenderByAction.size).toBe(1); // only latest pending

    vi.advanceTimersByTime(50);

    // Only 1 setImage call with the last render key (price 102)
    expect(mockAction.setImage).toHaveBeenCalledTimes(1);
    const calledWith = mockAction.setImage.mock.calls[0]?.[0] as string;
    expect(calledWith).toContain("102.00"); // renderKey contains normalized price
  });

  it("deduplication: same renderKey skips scheduling", async () => {
    const mockAction = { setImage: vi.fn().mockResolvedValue(undefined) };
    const data = makeStockData(75400);
    action.connectionStateByAction.set("action-1", "LIVE");

    // First render
    await action.renderStockData("action-1", mockAction, data, { source: "live" });
    vi.advanceTimersByTime(50); // flush
    expect(mockAction.setImage).toHaveBeenCalledTimes(1);

    // Second render with same data (same renderKey)
    mockAction.setImage.mockClear();
    await action.renderStockData("action-1", mockAction, data, { source: "live" });
    vi.advanceTimersByTime(50);

    // Dedup: same key → nothing added to pendingRenderByAction
    expect(mockAction.setImage).not.toHaveBeenCalled();
  });

  it("force=true bypasses deduplication", async () => {
    const mockAction = { setImage: vi.fn().mockResolvedValue(undefined) };
    const data = makeStockData(75400);
    action.connectionStateByAction.set("action-1", "LIVE");

    // First render
    await action.renderStockData("action-1", mockAction, data, { source: "live" });
    vi.advanceTimersByTime(50);
    expect(mockAction.setImage).toHaveBeenCalledTimes(1);

    // Second render with force=true — should render even with same key
    mockAction.setImage.mockClear();
    await action.renderStockData("action-1", mockAction, data, { source: "live", force: true });
    vi.advanceTimersByTime(50);

    expect(mockAction.setImage).toHaveBeenCalledTimes(1);
  });
});
