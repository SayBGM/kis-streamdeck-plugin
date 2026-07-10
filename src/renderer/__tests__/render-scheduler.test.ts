import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RenderScheduler,
  type RenderCategory,
  type RenderRequest,
} from "../render-scheduler.js";

function makeRequest(
  semanticKey: string,
  category: RenderCategory,
  rendered: string,
  renders: string[],
  commits: string[],
): RenderRequest {
  return {
    category,
    semanticKey,
    render: () => {
      renders.push(semanticKey);
      return rendered;
    },
    commit: (image) => {
      commits.push(image);
    },
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("RenderScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces 1,000 quote updates over ten seconds to at most five renders", async () => {
    const scheduler = new RenderScheduler();
    const generation = scheduler.activate("button", 2_000);
    const renders: string[] = [];
    const commits: string[] = [];

    for (let tick = 0; tick < 1_000; tick += 1) {
      scheduler.submit(
        "button",
        generation,
        makeRequest(`quote-${tick}`, "normal", `image-${tick}`, renders, commits),
      );
      await vi.advanceTimersByTimeAsync(10);
    }
    await vi.advanceTimersByTimeAsync(2_000);

    expect(renders.length).toBeLessThanOrEqual(5);
    expect(commits).toHaveLength(renders.length);
    expect(commits.at(-1)).toBe("image-999");
  });

  it("coalesces control-state flapping to at most ten renders in ten seconds", async () => {
    const scheduler = new RenderScheduler();
    const generation = scheduler.activate("button", 2_000);
    const renders: string[] = [];
    const commits: string[] = [];

    for (let tick = 0; tick < 100; tick += 1) {
      scheduler.submit(
        "button",
        generation,
        makeRequest(`control-${tick}`, "control", `state-${tick}`, renders, commits),
      );
      await vi.advanceTimersByTimeAsync(100);
    }
    await settle();

    expect(renders.length).toBeLessThanOrEqual(10);
    expect(commits).toHaveLength(renders.length);
  });

  it("flushes manual and fatal requests immediately without changing the normal interval", async () => {
    const scheduler = new RenderScheduler();
    const generation = scheduler.activate("button", 5_000);
    const renders: string[] = [];
    const commits: string[] = [];

    scheduler.submit(
      "button",
      generation,
      makeRequest("waiting", "normal", "waiting-image", renders, commits),
    );
    scheduler.submit(
      "button",
      generation,
      makeRequest("manual", "immediate", "manual-image", renders, commits),
    );
    await settle();

    expect(commits).toEqual(["manual-image"]);

    scheduler.submit(
      "button",
      generation,
      makeRequest("next", "normal", "next-image", renders, commits),
    );
    await vi.advanceTimersByTimeAsync(4_999);
    expect(commits).toEqual(["manual-image"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(commits).toEqual(["manual-image", "next-image"]);
  });

  it("applies interval changes to the pending last-write-wins request", async () => {
    const scheduler = new RenderScheduler();
    const generation = scheduler.activate("button", 10_000);
    const renders: string[] = [];
    const commits: string[] = [];

    scheduler.submit(
      "button",
      generation,
      makeRequest("old", "normal", "old-image", renders, commits),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(scheduler.updateInterval("button", generation, 2_000)).toBe(true);
    scheduler.submit(
      "button",
      generation,
      makeRequest("new", "normal", "new-image", renders, commits),
    );
    await vi.advanceTimersByTimeAsync(1_999);
    expect(commits).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(commits).toEqual(["new-image"]);
  });

  it("skips both rendering and IPC when the semantic state was committed", async () => {
    const scheduler = new RenderScheduler();
    const generation = scheduler.activate("button", 2_000);
    const renders: string[] = [];
    const commits: string[] = [];

    scheduler.submit(
      "button",
      generation,
      makeRequest("same", "immediate", "image", renders, commits),
    );
    await settle();
    scheduler.submit(
      "button",
      generation,
      makeRequest("same", "immediate", "different-image", renders, commits),
    );
    await settle();

    expect(renders).toEqual(["same"]);
    expect(commits).toEqual(["image"]);
    expect(scheduler.getDiagnostics()).toMatchObject({ semanticSkips: 1 });
  });

  it("skips IPC for identical generated images and commits the new semantic state", async () => {
    const scheduler = new RenderScheduler();
    const generation = scheduler.activate("button", 2_000);
    const renders: string[] = [];
    const commits: string[] = [];

    scheduler.submit(
      "button",
      generation,
      makeRequest("one", "immediate", "same-image", renders, commits),
    );
    await settle();
    scheduler.submit(
      "button",
      generation,
      makeRequest("two", "immediate", "same-image", renders, commits),
    );
    await settle();
    scheduler.submit(
      "button",
      generation,
      makeRequest("two", "immediate", "unused", renders, commits),
    );
    await settle();

    expect(renders).toEqual(["one", "two"]);
    expect(commits).toEqual(["same-image"]);
    expect(scheduler.getDiagnostics()).toMatchObject({ imageSkips: 1, semanticSkips: 1 });
  });

  it("ignores stale async render results after removal and reactivation", async () => {
    const scheduler = new RenderScheduler();
    const firstGeneration = scheduler.activate("button", 2_000);
    let resolveOld!: (image: string) => void;
    const oldImage = new Promise<string>((resolve) => {
      resolveOld = resolve;
    });
    const commits: string[] = [];

    scheduler.submit("button", firstGeneration, {
      category: "immediate",
      semanticKey: "old",
      render: () => oldImage,
      commit: (image) => {
        commits.push(image);
      },
    });
    await settle();
    expect(scheduler.remove("button", firstGeneration)).toBe(true);
    const secondGeneration = scheduler.activate("button", 2_000);
    expect(secondGeneration).toBeGreaterThan(firstGeneration);

    resolveOld("old-image");
    await settle();
    expect(commits).toEqual([]);
  });

  it("fences old settings work when activating the same target generation", async () => {
    const scheduler = new RenderScheduler();
    const oldGeneration = scheduler.activate("button", 10_000);
    const commits: string[] = [];
    scheduler.submit("button", oldGeneration, {
      category: "normal",
      semanticKey: "old-settings",
      render: () => "old-image",
      commit: (image) => {
        commits.push(image);
      },
    });

    const newGeneration = scheduler.activate("button", 2_000);
    expect(newGeneration).toBe(oldGeneration + 1);
    expect(
      scheduler.submit("button", oldGeneration, {
        category: "immediate",
        semanticKey: "stale-settings",
        render: () => "stale-image",
        commit: (image) => {
          commits.push(image);
        },
      }),
    ).toBe(false);
    scheduler.submit("button", newGeneration, {
      category: "immediate",
      semanticKey: "new-settings",
      render: () => "new-image",
      commit: (image) => {
        commits.push(image);
      },
    });
    await vi.runAllTimersAsync();

    expect(commits).toEqual(["new-image"]);
  });

  it("serializes async commits and lets the newest pending request win", async () => {
    const scheduler = new RenderScheduler();
    const generation = scheduler.activate("button", 2_000);
    let resolveCommit!: () => void;
    const events: string[] = [];

    scheduler.submit("button", generation, {
      category: "immediate",
      semanticKey: "first",
      render: () => {
        events.push("render:first");
        return "first-image";
      },
      commit: async () => {
        events.push("commit:first:start");
        await new Promise<void>((resolve) => {
          resolveCommit = resolve;
        });
        events.push("commit:first:end");
      },
    });
    await settle();

    scheduler.submit("button", generation, {
      category: "immediate",
      semanticKey: "second",
      render: () => {
        events.push("render:second");
        return "second-image";
      },
      commit: () => {
        events.push("commit:second");
      },
    });
    scheduler.submit("button", generation, {
      category: "immediate",
      semanticKey: "third",
      render: () => {
        events.push("render:third");
        return "third-image";
      },
      commit: () => {
        events.push("commit:third");
      },
    });
    await settle();
    expect(events).not.toContain("render:third");

    resolveCommit();
    await settle();
    expect(events).toEqual([
      "render:first",
      "commit:first:start",
      "commit:first:end",
      "render:third",
      "commit:third",
    ]);
  });

  it("schedules a throttled request that arrives during an async commit", async () => {
    const scheduler = new RenderScheduler();
    const generation = scheduler.activate("button", 2_000);
    let resolveCommit!: () => void;
    const commits: string[] = [];
    scheduler.submit("button", generation, {
      category: "immediate",
      semanticKey: "first",
      render: () => "first-image",
      commit: () => new Promise<void>((resolve) => {
        resolveCommit = resolve;
      }),
    });
    await settle();
    scheduler.submit("button", generation, {
      category: "normal",
      semanticKey: "next",
      render: () => "next-image",
      commit: (image) => {
        commits.push(image);
      },
    });
    resolveCommit();
    await settle();

    await vi.advanceTimersByTimeAsync(1_999);
    expect(commits).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(commits).toEqual(["next-image"]);
  });

  it("isolates render and commit failures so future requests recover", async () => {
    const scheduler = new RenderScheduler();
    const generation = scheduler.activate("button", 2_000);
    const commits: string[] = [];

    scheduler.submit("button", generation, {
      category: "immediate",
      semanticKey: "render-failure",
      render: () => {
        throw new Error("render failed");
      },
      commit: () => {
        commits.push("unreachable");
      },
    });
    await settle();
    scheduler.submit("button", generation, {
      category: "immediate",
      semanticKey: "commit-failure",
      render: () => "bad-image",
      commit: () => {
        throw new Error("commit failed");
      },
    });
    await settle();
    scheduler.submit("button", generation, {
      category: "immediate",
      semanticKey: "recovered",
      render: () => "good-image",
      commit: (image) => {
        commits.push(image);
      },
    });
    await settle();

    expect(commits).toEqual(["good-image"]);
    expect(scheduler.getDiagnostics()).toMatchObject({ failures: 2, commits: 1 });
  });

  it("rejects stale generations and becomes inert after destroy", async () => {
    const scheduler = new RenderScheduler();
    const generation = scheduler.activate("button", 2_000);
    const renders: string[] = [];
    const commits: string[] = [];

    expect(
      scheduler.submit(
        "button",
        generation + 1,
        makeRequest("stale", "immediate", "stale-image", renders, commits),
      ),
    ).toBe(false);
    scheduler.destroy();
    expect(
      scheduler.submit(
        "button",
        generation,
        makeRequest("destroyed", "immediate", "destroyed-image", renders, commits),
      ),
    ).toBe(false);
    expect(() => scheduler.activate("other", 2_000)).toThrow(/destroyed/i);
    await vi.runAllTimersAsync();
    expect(commits).toEqual([]);
  });

  it("handles a rolling-back clock and a synchronous timer callback safely", async () => {
    let now = 10_000;
    let nextHandle = 0;
    const cleared: number[] = [];
    const scheduler = new RenderScheduler({
      now: () => now,
      setTimeout: (callback) => {
        callback();
        return ++nextHandle;
      },
      clearTimeout: (handle) => cleared.push(handle as number),
    });
    const generation = scheduler.activate("button", 2_000);
    const renders: string[] = [];
    const commits: string[] = [];

    now = 1;
    expect(
      scheduler.submit(
        "button",
        generation,
        makeRequest("safe", "normal", "safe-image", renders, commits),
      ),
    ).toBe(true);
    await settle();

    expect(commits).toEqual(["safe-image"]);
    scheduler.remove("button", generation);
    expect(cleared.length).toBeLessThanOrEqual(1);
  });

  it("isolates timer setup and cancellation failures", async () => {
    const scheduler = new RenderScheduler({
      setTimeout: () => {
        throw new Error("timer unavailable");
      },
      clearTimeout: () => {
        throw new Error("clear failed");
      },
    });
    const generation = scheduler.activate("button", 2_000);
    const commits: string[] = [];
    scheduler.submit("button", generation, {
      category: "normal",
      semanticKey: "fallback",
      render: () => "fallback-image",
      commit: (image) => {
        commits.push(image);
      },
    });
    await settle();
    expect(commits).toEqual(["fallback-image"]);
    expect(scheduler.getDiagnostics().failures).toBe(1);

    const schedulerWithBadClear = new RenderScheduler({
      setTimeout: () => 7,
      clearTimeout: () => {
        throw new Error("clear failed");
      },
    });
    const secondGeneration = schedulerWithBadClear.activate("button", 2_000);
    schedulerWithBadClear.submit("button", secondGeneration, {
      category: "normal",
      semanticKey: "pending",
      render: () => "pending-image",
      commit: () => undefined,
    });
    expect(schedulerWithBadClear.remove("button", secondGeneration)).toBe(true);
    expect(schedulerWithBadClear.getDiagnostics().failures).toBe(1);
  });

  it("rejects unsupported intervals and stale interval updates", () => {
    const scheduler = new RenderScheduler();
    expect(() => scheduler.activate("button", 3_000 as 2_000)).toThrow(RangeError);
    const generation = scheduler.activate("button", 2_000);
    expect(scheduler.updateInterval("button", generation + 1, 5_000)).toBe(false);
    expect(() => scheduler.updateInterval("button", generation, 3_000 as 2_000)).toThrow(
      RangeError,
    );
  });
});
