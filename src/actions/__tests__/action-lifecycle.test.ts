import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../../renderer/stock-card.js", () => ({
  renderStockCard: vi.fn().mockReturnValue("<svg/>"),
  renderWaitingCard: vi.fn().mockReturnValue("<svg/>"),
  renderConnectedCard: vi.fn().mockReturnValue("<svg/>"),
  renderSetupCard: vi.fn().mockReturnValue("<svg/>"),
  renderErrorCard: vi.fn().mockReturnValue("<svg/>"),
  renderRecoveryCard: vi.fn().mockReturnValue("<svg/>"),
  svgToDataUri: vi.fn().mockImplementation((_svg: string, key: string) => `data:${key}`),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

type ActionWithPollState = {
  onWillDisappear: (ev: { action: { id: string } }) => Promise<void>;
  pollTimers: Map<string, ReturnType<typeof setInterval>>;
  staleTimers: Map<string, ReturnType<typeof setTimeout>>;
};

describe("Action lifecycle cleanup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("cleans up domestic poll timers even without websocket subscription entry", async () => {
    const mod = await import("../../actions/domestic-stock.js");
    const action = new mod.DomesticStockAction() as unknown as ActionWithPollState;

    action.pollTimers.set("action-1", setInterval(() => undefined, 1000));
    action.staleTimers.set("action-1", setTimeout(() => undefined, 1000));

    await action.onWillDisappear({ action: { id: "action-1" } });

    expect(action.pollTimers.has("action-1")).toBe(false);
    expect(action.staleTimers.has("action-1")).toBe(false);
  });

  it("cleans up overseas poll timers even without websocket subscription entry", async () => {
    const mod = await import("../../actions/overseas-stock.js");
    const action = new mod.OverseasStockAction() as unknown as ActionWithPollState;

    action.pollTimers.set("action-1", setInterval(() => undefined, 1000));
    action.staleTimers.set("action-1", setTimeout(() => undefined, 1000));

    await action.onWillDisappear({ action: { id: "action-1" } });

    expect(action.pollTimers.has("action-1")).toBe(false);
    expect(action.staleTimers.has("action-1")).toBe(false);
  });
});
