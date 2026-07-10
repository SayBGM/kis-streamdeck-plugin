import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REST_TR_DOMESTIC_ETF_PRICE,
  REST_TR_DOMESTIC_PRICE,
  type GlobalSettings,
} from "../../types/index.js";

vi.mock("../auth.js", () => ({
  getAccessToken: vi.fn().mockResolvedValue("access-token"),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const credentials: GlobalSettings = {
  appKey: "app-key",
  appSecret: "app-secret",
};

function okPriceResponse(): Response {
  return new Response(JSON.stringify({
    output: {
      stck_prpr: "12345",
      prdy_vrss: "100",
      prdy_vrss_sign: "2",
      prdy_ctrt: "0.82",
    },
  }), { status: 200 });
}

describe("fetchDomesticPriceForSettings instrument routing", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(okPriceResponse());
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("uses the stock API when instrument type is omitted", async () => {
    const { fetchDomesticPriceForSettings } = await import("../rest-price.js");

    await fetchDomesticPriceForSettings(credentials, "005930", "삼성전자");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe(
      "/uapi/domestic-stock/v1/quotations/inquire-price",
    );
    expect((init.headers as Record<string, string>).tr_id).toBe(
      REST_TR_DOMESTIC_PRICE,
    );
  });

  it("uses the ETF API and normalizes an alphanumeric code", async () => {
    const { fetchDomesticPriceForSettings } = await import("../rest-price.js");

    const result = await fetchDomesticPriceForSettings(
      credentials,
      " 0210a0 ",
      "ETF",
      "etf",
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsedUrl = new URL(url);
    expect(parsedUrl.pathname).toBe("/uapi/etfetn/v1/quotations/inquire-price");
    expect(parsedUrl.searchParams.get("FID_COND_MRKT_DIV_CODE")).toBe("UN");
    expect(parsedUrl.searchParams.get("FID_INPUT_ISCD")).toBe("0210A0");
    expect((init.headers as Record<string, string>).tr_id).toBe(
      REST_TR_DOMESTIC_ETF_PRICE,
    );
    expect(result?.ticker).toBe("0210A0");
  });
});
