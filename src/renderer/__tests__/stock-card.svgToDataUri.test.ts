/** svgToDataUri() caches the generated URI by the actual SVG content. */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Reset module cache between tests to clear the module-level svgDataUriCache
beforeEach(() => {
  vi.resetModules();
});

describe("svgToDataUri() — characterization tests", () => {
  it("encodes SVG to data URI format", async () => {
    const { svgToDataUri } = await import("../stock-card.js");
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
    const result = svgToDataUri(svg, "test:key");
    expect(result).toBe(
      "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg)
    );
  });

  it("uses the actual SVG as the cache key even when semantic keys differ", async () => {
    const { svgToDataUri } = await import("../stock-card.js");
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
    const encodeSpy = vi.spyOn(globalThis, "encodeURIComponent");
    encodeSpy.mockClear();

    const first = svgToDataUri(svg, "old-semantic-key");
    const second = svgToDataUri(svg, "new-semantic-key");

    expect(first).toBe(second);
    expect(encodeSpy).toHaveBeenCalledTimes(1);
    encodeSpy.mockRestore();
  });

  it("does NOT re-encode SVG on cache hit (encodeURIComponent called only once)", async () => {
    const encodeSpy = vi.spyOn(globalThis, "encodeURIComponent");
    const { svgToDataUri } = await import("../stock-card.js");
    const svg = '<svg/>';
    const key = "cache-hit-test-key";

    encodeSpy.mockClear();
    svgToDataUri(svg, key);       // miss → encodes
    const callsAfterMiss = encodeSpy.mock.calls.length;
    svgToDataUri(svg, key);       // hit → should NOT encode
    const callsAfterHit = encodeSpy.mock.calls.length;

    expect(callsAfterMiss).toBe(1);
    expect(callsAfterHit).toBe(1); // no additional encoding on hit

    encodeSpy.mockRestore();
  });

  it("does not alias different SVG content that shares a semantic key", async () => {
    const { svgToDataUri } = await import("../stock-card.js");
    const key = "same-semantic-key";
    const firstSvg = '<svg id="first"/>';
    const secondSvg = '<svg id="second"/>';

    const uri1 = svgToDataUri(firstSvg, key);
    const uri2 = svgToDataUri(secondSvg, key);

    expect(uri1).not.toBe(uri2);
    expect(uri1).toContain(encodeURIComponent(firstSvg));
    expect(uri2).toContain(encodeURIComponent(secondSvg));
  });

  it("LRU eviction: oldest entry removed when cache reaches 500 entries", async () => {
    const { svgToDataUri } = await import("../stock-card.js");

    // Fill cache to 500 entries
    for (let i = 0; i < 500; i++) {
      svgToDataUri(`<svg id="${i}"/>`, "ignored");
    }

    // Access key-0 to make it recently used (LRU update)
    svgToDataUri(`<svg id="0"/>`, "different-semantic-key");

    // Add 501st entry — should evict key-1 (oldest not accessed)
    svgToDataUri('<svg id="new"/>', "ignored");

    // Verify the new entry is cached (no re-encoding on second call)
    const encodeSpy = vi.spyOn(globalThis, "encodeURIComponent");
    encodeSpy.mockClear();
    svgToDataUri('<svg id="new"/>', "another-ignored-key");
    expect(encodeSpy.mock.calls.length).toBe(0); // hit, no encode

    encodeSpy.mockClear();
    svgToDataUri('<svg id="1"/>', "ignored-after-eviction");
    expect(encodeSpy).toHaveBeenCalledTimes(1); // key was the oldest untouched SVG

    encodeSpy.mockRestore();
  });

  it("LRU update: accessed entry moves to most-recent position", async () => {
    const { svgToDataUri } = await import("../stock-card.js");

    // Fill cache to 500 entries
    for (let i = 0; i < 500; i++) {
      svgToDataUri(`<svg id="${i}"/>`, "ignored");
    }

    // Access key-0 — it becomes most recent
    svgToDataUri(`<svg id="0"/>`, "ignored-again");

    // Add 501st entry — key-1 should be evicted (was oldest after key-0 was refreshed)
    svgToDataUri('<svg id="501"/>', "ignored");

    // key-0 should still be in cache (was refreshed to most-recent)
    const encodeSpy = vi.spyOn(globalThis, "encodeURIComponent");
    encodeSpy.mockClear();
    svgToDataUri(`<svg id="0"/>`, "ignored-on-hit");
    expect(encodeSpy.mock.calls.length).toBe(0); // hit

    encodeSpy.mockClear();
    svgToDataUri(`<svg id="1"/>`, "ignored-after-eviction");
    expect(encodeSpy).toHaveBeenCalledTimes(1); // untouched oldest SVG was evicted

    encodeSpy.mockRestore();
  });
});
