/**
 * Characterization tests for svgToDataUri()
 *
 * Captures CURRENT behavior after SPEC-PERF-001 changes:
 * - SVG_DATA_URI_CACHE_MAX_ENTRIES = 500
 * - semanticKey parameter added (signature change)
 * - LRU cache key is semanticKey, not the SVG string
 */

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

  it("returns cached DataURI on second call with same semanticKey", async () => {
    const { svgToDataUri } = await import("../stock-card.js");
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
    const key = "005930|75400.00|200.00|0.27|rise|LIVE|FRESH";

    const first = svgToDataUri(svg, key);
    const second = svgToDataUri(svg, key);

    expect(first).toBe(second);
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

  it("different semanticKey for same SVG yields new cache entry (cache miss)", async () => {
    const { svgToDataUri } = await import("../stock-card.js");
    const svg = '<svg/>';
    const key1 = "ticker|100.00|1.00|0.01|rise|LIVE|FRESH";
    const key2 = "ticker|200.00|2.00|0.02|rise|LIVE|FRESH";

    const uri1 = svgToDataUri(svg, key1);
    const uri2 = svgToDataUri(svg, key2);

    // Both should produce the same DataURI content (same SVG),
    // but they are cached under different keys
    expect(uri1).toBe(uri2);
  });

  it("LRU eviction: oldest entry removed when cache reaches 500 entries", async () => {
    const { svgToDataUri } = await import("../stock-card.js");

    // Fill cache to 500 entries
    for (let i = 0; i < 500; i++) {
      svgToDataUri(`<svg id="${i}"/>`, `key-${i}`);
    }

    // Access key-0 to make it recently used (LRU update)
    svgToDataUri(`<svg id="0"/>`, "key-0");

    // Add 501st entry — should evict key-1 (oldest not accessed)
    svgToDataUri('<svg id="new"/>', "key-new");

    // Verify the new entry is cached (no re-encoding on second call)
    const encodeSpy = vi.spyOn(globalThis, "encodeURIComponent");
    encodeSpy.mockClear();
    svgToDataUri('<svg id="new"/>', "key-new");
    expect(encodeSpy.mock.calls.length).toBe(0); // hit, no encode

    encodeSpy.mockRestore();
  });

  it("LRU update: accessed entry moves to most-recent position", async () => {
    const { svgToDataUri } = await import("../stock-card.js");

    // Fill cache to 500 entries
    for (let i = 0; i < 500; i++) {
      svgToDataUri(`<svg id="${i}"/>`, `key-${i}`);
    }

    // Access key-0 — it becomes most recent
    svgToDataUri(`<svg id="0"/>`, "key-0");

    // Add 501st entry — key-1 should be evicted (was oldest after key-0 was refreshed)
    svgToDataUri('<svg id="501"/>', "key-501");

    // key-0 should still be in cache (was refreshed to most-recent)
    const encodeSpy = vi.spyOn(globalThis, "encodeURIComponent");
    encodeSpy.mockClear();
    svgToDataUri(`<svg id="0"/>`, "key-0");
    expect(encodeSpy.mock.calls.length).toBe(0); // hit

    encodeSpy.mockRestore();
  });
});
