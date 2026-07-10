import { describe, expect, it } from "vitest";
import {
  normalizeDomesticStockCode,
  resolveDomesticInstrumentType,
} from "../domestic-instrument.js";

describe("domestic instrument settings", () => {
  it("normalizes a six-character alphanumeric code", () => {
    expect(normalizeDomesticStockCode(" 0210a0 ")).toBe("0210A0");
  });

  it("defaults missing or unknown instrument types to stock", () => {
    expect(resolveDomesticInstrumentType(undefined)).toBe("stock");
    expect(resolveDomesticInstrumentType("unknown")).toBe("stock");
    expect(resolveDomesticInstrumentType("etf")).toBe("etf");
  });
});
