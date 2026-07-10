import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(
  new URL("../../ui/domestic-stock-pi.html", import.meta.url),
  "utf8",
);

describe("domestic stock property inspector", () => {
  it("offers stock and ETF instrument types", () => {
    expect(html).toContain('id: "instrumentType"');
    expect(html).toContain('{ value: "stock", label: "주식" }');
    expect(html).toContain('{ value: "etf", label: "ETF/ETN" }');
  });

  it("accepts and uppercases six-character alphanumeric codes", () => {
    expect(html).toContain('return /^[0-9A-Z]{6}$/i.test(value);');
    expect(html).toContain('return value.trim().toUpperCase();');
    expect(html).toContain("0210A0");
  });
});
