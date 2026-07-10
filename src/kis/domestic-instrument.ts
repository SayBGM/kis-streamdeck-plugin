import type { DomesticInstrumentType } from "../types/index.js";

export function normalizeDomesticStockCode(value?: string): string {
  return value?.trim().toUpperCase() ?? "";
}

export function resolveDomesticInstrumentType(
  value?: string,
): DomesticInstrumentType {
  return value === "etf" ? "etf" : "stock";
}
