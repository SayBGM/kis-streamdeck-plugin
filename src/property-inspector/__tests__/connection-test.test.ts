import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorType } from "../../types/index.js";
import { runConnectionTest } from "../connection-test.js";

const { getApprovalKey, getAccessToken } = vi.hoisted(() => ({
  getApprovalKey: vi.fn(),
  getAccessToken: vi.fn(),
}));
let fetchMock: ReturnType<typeof vi.fn>;

vi.mock("../../kis/auth.js", () => ({
  getApprovalKey,
  getAccessToken,
}));

vi.mock("../../utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe("runConnectionTest", () => {
  beforeEach(() => {
    getApprovalKey.mockReset();
    getAccessToken.mockReset();
    getApprovalKey.mockResolvedValue("approval-key");
    getAccessToken.mockResolvedValue("access-token");
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns credential success when no stock payload is provided", async () => {
    const result = await runConnectionTest(
      {
        type: "kis.connectionTest",
        requestId: "req-1",
        appKey: " app-key ",
        appSecret: " secret-key ",
      },
      {}
    );

    expect(getApprovalKey).toHaveBeenCalledWith({
      appKey: "app-key",
      appSecret: "secret-key",
    });
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: "kis.connectionTestResult",
      requestId: "req-1",
      ok: true,
      errorType: undefined,
      message: "KIS API 자격증명을 확인했습니다.",
    });
  });

  it("validates a domestic stock when stockCode is provided", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        output: {
          stck_prpr: "61000",
        },
      }),
    } as unknown as Response);

    const result = await runConnectionTest(
      {
        type: "kis.connectionTest",
        requestId: "req-domestic",
        appKey: "app-key",
        appSecret: "secret-key",
        stockCode: "005930",
      },
      {}
    );

    expect(getAccessToken).toHaveBeenCalledWith({
      appKey: "app-key",
      appSecret: "secret-key",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/uapi/domestic-stock/v1/quotations/inquire-price"),
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          authorization: "Bearer access-token",
          appkey: "app-key",
          appsecret: "secret-key",
        }),
      })
    );
    expect(result).toEqual({
      type: "kis.connectionTestResult",
      requestId: "req-domestic",
      ok: true,
      errorType: undefined,
      message: "KIS API 자격증명과 현재 버튼 종목 설정을 확인했습니다.",
    });
  });

  it("validates an overseas stock when ticker and exchange are provided", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        output: {
          last: "188.20",
        },
      }),
    } as unknown as Response);

    const result = await runConnectionTest(
      {
        type: "kis.connectionTest",
        requestId: "req-overseas",
        appKey: "app-key",
        appSecret: "secret-key",
        ticker: "aapl",
        exchange: "NAS",
      },
      {}
    );

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/uapi/overseas-price/v1/quotations/price"),
      expect.objectContaining({
        method: "GET",
      })
    );
    expect(result.ok).toBe(true);
    expect(result.message).toBe("KIS API 자격증명과 현재 버튼 종목 설정을 확인했습니다.");
  });

  it("returns INVALID_STOCK when the domestic stock response is empty", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        output: {},
      }),
    } as unknown as Response);

    const result = await runConnectionTest(
      {
        type: "kis.connectionTest",
        requestId: "req-invalid",
        appKey: "app-key",
        appSecret: "secret-key",
        stockCode: "005930",
      },
      {}
    );

    expect(result).toEqual({
      type: "kis.connectionTestResult",
      requestId: "req-invalid",
      ok: false,
      errorType: ErrorType.INVALID_STOCK,
      message: "종목코드를 확인하세요.",
    });
  });

  it("maps stock validation auth failures to AUTH_FAIL", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
    } as unknown as Response);

    const result = await runConnectionTest(
      {
        type: "kis.connectionTest",
        requestId: "req-auth",
        appKey: "app-key",
        appSecret: "secret-key",
        ticker: "AAPL",
        exchange: "NAS",
      },
      {}
    );

    expect(result).toEqual({
      type: "kis.connectionTestResult",
      requestId: "req-auth",
      ok: false,
      errorType: ErrorType.AUTH_FAIL,
      message: "App Key 또는 App Secret을 확인하세요.",
    });
  });
});
