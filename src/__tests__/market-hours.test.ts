import { describe, expect, it, vi } from "vitest";

vi.mock("../utils/timezone.js", () => ({
  getKSTDayOfWeek: vi.fn(() => 6),
  getKSTTotalMinutes: vi.fn(() => 600),
}));

import { isOverseasDayTrading } from "../types/index.js";

describe("market hours", () => {
  it("treats overseas day trading as closed on weekends", () => {
    expect(isOverseasDayTrading()).toBe(false);
  });
});
