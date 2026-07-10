import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MarketClock,
  getMarketSnapshot,
  isOverseasDayTradingAt,
} from "../market-clock.js";

const at = (iso: string): number => Date.parse(iso);

describe("getMarketSnapshot", () => {
  it.each([
    ["2026-07-05T23:29:59.000Z", "CLOSED"],
    ["2026-07-05T23:30:00.000Z", "PRE"],
    ["2026-07-06T00:00:00.000Z", "REG"],
    ["2026-07-06T06:30:00.000Z", "CLOSED"],
    ["2026-07-06T06:40:00.000Z", "AFT"],
    ["2026-07-06T09:00:00.000Z", "CLOSED"],
  ] as const)("classifies domestic boundary %s as %s", (iso, session) => {
    expect(getMarketSnapshot("domestic", at(iso)).session).toBe(session);
  });

  it("keeps a stable epoch within a session and exposes its next transition", () => {
    const first = getMarketSnapshot("domestic", at("2026-07-06T01:00:00.000Z"));
    const later = getMarketSnapshot("domestic", at("2026-07-06T06:29:59.000Z"));

    expect(first.session).toBe("REG");
    expect(first.sessionEpoch).toBe(at("2026-07-06T00:00:00.000Z"));
    expect(later.sessionEpoch).toBe(first.sessionEpoch);
    expect(first.nextTransitionAt).toBe(at("2026-07-06T06:30:00.000Z"));
  });

  it("assigns different epochs to the midday and overnight CLOSED intervals", () => {
    const midday = getMarketSnapshot("domestic", at("2026-07-06T06:35:00.000Z"));
    const overnight = getMarketSnapshot("domestic", at("2026-07-06T10:00:00.000Z"));

    expect(midday.session).toBe("CLOSED");
    expect(midday.sessionEpoch).toBe(at("2026-07-06T06:30:00.000Z"));
    expect(overnight.session).toBe("CLOSED");
    expect(overnight.sessionEpoch).toBe(at("2026-07-06T09:00:00.000Z"));
  });

  it("keeps the weekend closed epoch and advances to Monday in Seoul", () => {
    const snapshot = getMarketSnapshot("domestic", at("2026-07-04T03:00:00.000Z"));

    expect(snapshot.session).toBe("CLOSED");
    expect(snapshot.sessionEpoch).toBe(at("2026-07-03T09:00:00.000Z"));
    expect(snapshot.nextTransitionAt).toBe(at("2026-07-05T23:30:00.000Z"));
  });

  it("uses New York DST offsets for the same local market boundary", () => {
    const winter = getMarketSnapshot("overseas", at("2026-01-05T09:00:00.000Z"));
    const summer = getMarketSnapshot("overseas", at("2026-07-06T08:00:00.000Z"));

    expect(winter.session).toBe("PRE");
    expect(winter.sessionEpoch).toBe(at("2026-01-05T09:00:00.000Z"));
    expect(summer.session).toBe("PRE");
    expect(summer.sessionEpoch).toBe(at("2026-07-06T08:00:00.000Z"));
  });

  it.each([
    ["spring", "2026-03-06T09:00:00.000Z", "2026-03-09T08:00:00.000Z"],
    ["fall", "2026-10-30T08:00:00.000Z", "2026-11-02T09:00:00.000Z"],
  ])("tracks the %s DST weekend on both sides", (_name, beforeIso, afterIso) => {
    const before = getMarketSnapshot("overseas", at(beforeIso));
    const after = getMarketSnapshot("overseas", at(afterIso));

    expect(before).toMatchObject({ session: "PRE", sessionEpoch: at(beforeIso) });
    expect(after).toMatchObject({ session: "PRE", sessionEpoch: at(afterIso) });
  });

  it.each([
    ["2026-07-06T07:59:59.000Z", "CLOSED"],
    ["2026-07-06T08:00:00.000Z", "PRE"],
    ["2026-07-06T13:30:00.000Z", "REG"],
    ["2026-07-06T20:00:00.000Z", "AFT"],
    ["2026-07-07T00:00:00.000Z", "CLOSED"],
  ] as const)("classifies New York boundary %s as %s", (iso, session) => {
    expect(getMarketSnapshot("overseas", at(iso)).session).toBe(session);
  });
});

describe("isOverseasDayTradingAt", () => {
  it("uses KST weekdays from 09:00 inclusive to 15:30 exclusive", () => {
    expect(isOverseasDayTradingAt(at("2026-07-06T00:00:00.000Z"))).toBe(true);
    expect(isOverseasDayTradingAt(at("2026-07-06T06:29:59.000Z"))).toBe(true);
    expect(isOverseasDayTradingAt(at("2026-07-06T06:30:00.000Z"))).toBe(false);
    expect(isOverseasDayTradingAt(at("2026-07-05T01:00:00.000Z"))).toBe(false);
  });
});

describe("MarketClock lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses one resync and one transition timer and catches a wake-like clock jump", () => {
    vi.useFakeTimers();
    let now = at("2026-07-05T23:40:00.000Z");
    const sessions: string[] = [];
    const clock = new MarketClock("domestic", { now: () => now });
    const unsubscribe = clock.subscribe((snapshot) => {
      sessions.push(snapshot.session);
    });

    clock.start();
    clock.start();
    expect(vi.getTimerCount()).toBe(2);
    expect(sessions).toEqual(["PRE"]);

    now = at("2026-07-06T01:00:00.000Z");
    vi.advanceTimersByTime(60_000);

    expect(sessions).toEqual(["PRE", "REG"]);
    expect(vi.getTimerCount()).toBe(2);

    unsubscribe();
    clock.stop();
    clock.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("delivers exactly one current snapshot to a listener added after a clock jump", () => {
    let now = at("2026-07-05T23:40:00.000Z");
    const clock = new MarketClock("domestic", { now: () => now });
    now = at("2026-07-06T01:00:00.000Z");
    const listener = vi.fn();

    clock.subscribe(listener);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ session: "REG" }));
  });

  it("isolates an asynchronously failing listener", async () => {
    const clock = new MarketClock("domestic", {
      now: () => at("2026-07-06T01:00:00.000Z"),
    });
    const rejected = Promise.reject(new Error("listener failure"));
    const catchSpy = vi.spyOn(rejected, "catch");

    clock.subscribe(() => rejected);
    await Promise.resolve();

    expect(catchSpy).toHaveBeenCalledOnce();
  });

  it("publishes explicit snapshots before start and after stop", () => {
    let now = at("2026-07-05T23:40:00.000Z");
    const sessions: string[] = [];
    const clock = new MarketClock("domestic", { now: () => now });
    clock.subscribe((snapshot) => {
      sessions.push(snapshot.session);
    });

    now = at("2026-07-06T01:00:00.000Z");
    expect(clock.snapshot().session).toBe("REG");
    clock.start();
    clock.stop();
    now = at("2026-07-06T06:45:00.000Z");
    expect(clock.snapshot().session).toBe("AFT");

    expect(sessions).toEqual(["PRE", "REG", "AFT"]);
  });

  it("ignores callbacks from a canceled timer generation", () => {
    let now = at("2026-07-05T23:40:00.000Z");
    const callbacks: Array<() => void> = [];
    const clock = new MarketClock("domestic", {
      now: () => now,
      setTimeout: (callback) => {
        callbacks.push(callback);
        return callbacks.length - 1;
      },
      clearTimeout: () => undefined,
    });
    clock.start();
    const staleTransitionCallback = callbacks[1];

    now = at("2026-07-06T01:00:00.000Z");
    callbacks[0]();
    expect(callbacks).toHaveLength(4);
    staleTransitionCallback();
    expect(callbacks).toHaveLength(4);

    const canceledAfterStop = callbacks[2];
    clock.stop();
    canceledAfterStop();
    expect(callbacks).toHaveLength(4);
  });

  it("serializes reentrant evaluation so every listener observes the same order", () => {
    let now = at("2026-07-05T23:40:00.000Z");
    const clock = new MarketClock("domestic", { now: () => now });
    const observedBySecondListener: string[] = [];
    let reentered = false;

    clock.subscribe((snapshot) => {
      if (snapshot.session === "REG" && !reentered) {
        reentered = true;
        now = at("2026-07-06T06:45:00.000Z");
        clock.snapshot();
      }
    });
    clock.subscribe((snapshot) => {
      observedBySecondListener.push(snapshot.session);
    });
    observedBySecondListener.length = 0;

    now = at("2026-07-06T01:00:00.000Z");
    clock.snapshot();

    expect(observedBySecondListener).toEqual(["REG", "AFT"]);
  });
});
