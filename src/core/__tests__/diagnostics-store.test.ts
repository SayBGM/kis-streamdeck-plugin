import { describe, expect, it, vi } from "vitest";
import { DiagnosticsStore } from "../diagnostics-store.js";
import { KisError } from "../errors.js";

function settingsError(at: number): KisError {
  return new KisError({
    code: "SETTINGS",
    scope: "settings",
    retryable: true,
    safeMessage: "설정을 읽지 못했습니다.",
    at,
  });
}

describe("DiagnosticsStore", () => {
  it("keeps a maximum 100-event ring without raw strings or secrets", () => {
    const store = new DiagnosticsStore();

    for (let at = 0; at < 105; at += 1) {
      store.record(settingsError(at), {
        attempt: at,
        state: "degraded",
        appKey: "secret-key",
        rawPayload: "raw-payload",
        arbitrary: "arbitrary-string",
      });
    }

    const snapshot = store.snapshot();
    expect(snapshot.events).toHaveLength(100);
    expect(snapshot.events[0]?.at).toBe(5);
    expect(snapshot.events.at(-1)?.metadata).toEqual({
      attempt: 104,
      state: "degraded",
    });
    expect(JSON.stringify(snapshot)).not.toContain("secret-key");
    expect(JSON.stringify(snapshot)).not.toContain("raw-payload");
    expect(JSON.stringify(snapshot)).not.toContain("arbitrary-string");
  });

  it("publishes counter and event snapshots until unsubscribed", () => {
    const store = new DiagnosticsStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.increment("settingsFailures");
    store.record(settingsError(1));
    unsubscribe();
    store.increment("settingsFailures");

    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.report()).toEqual(store.snapshot());
    expect(store.snapshot().counters.settingsFailures).toBe(2);
  });

  it("rejects arbitrary counter names at the runtime boundary", () => {
    const store = new DiagnosticsStore();

    store.increment("rawSecret" as "settingsFailures");

    expect(store.snapshot().counters).toEqual({});
  });

  it.each([
    ["record", (store: DiagnosticsStore) => store.record(settingsError(1))],
    ["increment", (store: DiagnosticsStore) => store.increment("settingsFailures")],
  ])("isolates throwing listeners during %s", (_operation, publish) => {
    const store = new DiagnosticsStore();
    const throwingListener = vi.fn(() => {
      throw new Error("listener failure");
    });
    const followingListener = vi.fn();
    store.subscribe(throwingListener);
    store.subscribe(followingListener);

    expect(() => publish(store)).not.toThrow();
    expect(throwingListener).toHaveBeenCalledTimes(1);
    expect(followingListener).toHaveBeenCalledTimes(1);
  });
});
