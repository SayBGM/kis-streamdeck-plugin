import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(
  new URL("../../ui/domestic-stock-pi.html", import.meta.url),
  "utf8",
);
const configuration = readFileSync(
  new URL("../../ui/domestic-stock-pi.js", import.meta.url),
  "utf8",
);

describe("domestic stock property inspector", () => {
  it("offers stock and ETF instrument types", () => {
    expect(html).toContain('src="domestic-stock-pi.js"');
    expect(configuration).toContain('id: "instrumentType"');
    expect(configuration).toContain('{ value: "stock", label: "주식" }');
    expect(configuration).toContain('{ value: "etf", label: "ETF/ETN" }');
  });

  it("accepts and uppercases six-character alphanumeric codes", () => {
    expect(configuration).toContain('return /^[0-9A-Z]{6}$/i.test(value);');
    expect(configuration).toContain('return value.trim().toUpperCase();');
    expect(configuration).toContain("0210A0");
  });
});
