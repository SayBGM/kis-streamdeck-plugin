import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

const domesticHtml = readFileSync(
  new URL("../../ui/domestic-stock-pi.html", import.meta.url),
  "utf8",
);
const domesticConfiguration = readFileSync(
  new URL("../../ui/domestic-stock-pi.js", import.meta.url),
  "utf8",
);
const overseasHtml = readFileSync(
  new URL("../../ui/overseas-stock-pi.html", import.meta.url),
  "utf8",
);
const overseasConfiguration = readFileSync(
  new URL("../../ui/overseas-stock-pi.js", import.meta.url),
  "utf8",
);
const sharedUi = readFileSync(
  new URL("../../ui/stock-pi-shared.js", import.meta.url),
  "utf8",
);

function renderConfiguration(configuration: string): Window["document"] {
  const window = new Window({ url: "http://localhost/" });
  window.document.body.innerHTML = '<div id="piRoot"></div>';
  Object.assign(window, {
    sendToPlugin: () => undefined,
    setSettings: () => undefined,
  });
  window.eval(sharedUi);
  window.eval(configuration);
  return window.document;
}

describe("domestic stock property inspector", () => {
  it("offers stock and ETF instrument types", () => {
    expect(domesticHtml).toContain('src="domestic-stock-pi.js"');
    expect(domesticConfiguration).toContain('id: "instrumentType"');
    expect(domesticConfiguration).toContain('{ value: "stock", label: "주식" }');
    expect(domesticConfiguration).toContain('{ value: "etf", label: "ETF/ETN" }');
  });

  it("accepts and uppercases six-character alphanumeric codes", () => {
    expect(domesticConfiguration).toContain('return /^[0-9A-Z]{6}$/i.test(value);');
    expect(domesticConfiguration).toContain('return value.trim().toUpperCase();');
    expect(domesticConfiguration).toContain("0210A0");
  });

  it.each([
    ["domestic", domesticHtml, domesticConfiguration, ["instrumentType", "stockCode", "stockName"]],
    ["overseas", overseasHtml, overseasConfiguration, ["ticker", "exchange", "stockName"]],
  ] as const)(
    "%s entry uses the shared UI without duplicated form markup",
    (_market, entryHtml, configuration, expectedFields) => {
      expect(entryHtml).toContain('href="sdpi.css"');
      expect(entryHtml).toContain('src="stock-pi-shared.js"');
      expect(entryHtml.match(/id="piRoot"/g)).toHaveLength(1);
      expect(entryHtml).not.toMatch(/<(?:details|summary|input|select|button)\b/i);
      expect(configuration).not.toMatch(/innerHTML|data-section|<(?:details|summary|input|select|button)\b/i);

      const document = renderConfiguration(configuration);
      const actionSection = document.querySelector('[data-section="stock-settings"]');
      expect(actionSection).not.toBeNull();
      for (const field of expectedFields) {
        expect(actionSection?.querySelector(`#${field}`)).not.toBeNull();
      }
    },
  );
});
