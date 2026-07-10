import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const tempRoots: string[] = [];
const execFileAsync = promisify(execFile);
const scriptPath = path.resolve(process.cwd(), "scripts/verify-coverage.mjs");

function coveredFile(branchHits: number[]): object {
  return {
    path: "fixture.ts",
    statementMap: { 0: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } } },
    s: { 0: 1 },
    fnMap: { 0: {} },
    f: { 0: 1 },
    branchMap: Object.fromEntries(branchHits.map((_, index) => [index, {}])),
    b: Object.fromEntries(
      branchHits.map((hits, index) => [index, hits === 2 ? [1, 1] : [1, 0]]),
    ),
  };
}

async function coverageFixture(
  overrides: Record<string, object> = {},
): Promise<{ root: string; report: string }> {
  const root = path.join(os.tmpdir(), `kis-coverage-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  tempRoots.push(root);
  const src = path.join(root, "src");
  const report = path.join(root, "coverage", "coverage-final.json");
  const files: Record<string, object> = {
    [path.join(src, "core/errors.ts")]: coveredFile([2, 2, 2, 2, 2]),
    [path.join(src, "settings/schema.ts")]: coveredFile([2, 2, 2, 2, 2]),
    [path.join(src, "actions/stock-action-controller.ts")]: coveredFile([2, 2, 2, 2, 2]),
    [path.join(src, "renderer/render-scheduler.ts")]: coveredFile([2, 2, 2, 2, 2]),
    [path.join(src, "kis/credential-session.ts")]: coveredFile([2, 2, 2, 2, 2]),
    [path.join(src, "kis/rest-coordinator.ts")]: coveredFile([2, 2, 2, 2, 2]),
    [path.join(src, "kis/connection-supervisor.ts")]: coveredFile([2, 2, 2, 2, 2]),
    [path.join(src, "kis/subscription-supervisor.ts")]: coveredFile([2, 2, 2, 2, 2]),
    ...overrides,
  };
  await mkdir(path.dirname(report), { recursive: true });
  await writeFile(report, JSON.stringify(files), "utf8");
  return { root, report };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("verify-coverage", () => {
  it("accepts global line and required group branch coverage at 80%", async () => {
    const { root, report } = await coverageFixture();

    const result = await execFileAsync(process.execPath, [scriptPath, report, root]);

    expect(result.stdout).toContain("전체 line: 100.00%");
    for (const group of [
      "core",
      "settings",
      "stock-action-controller",
      "render-scheduler",
      "kis-runtime",
    ]) expect(result.stdout).toContain(group);
  });

  it("rejects a required group whose aggregate branch coverage is below 80%", async () => {
    const { root, report } = await coverageFixture();
    const coverage = JSON.parse(await readFile(report, "utf8"));
    for (const source of [
      "credential-session.ts",
      "rest-coordinator.ts",
      "connection-supervisor.ts",
      "subscription-supervisor.ts",
    ]) {
      coverage[path.join(root, "src/kis", source)] = coveredFile([2, 0, 0, 0, 0]);
    }
    await writeFile(report, JSON.stringify(coverage), "utf8");

    const error = await execFileAsync(process.execPath, [scriptPath, report, root])
      .catch((caught: unknown) => caught as { code: number; stderr: string });

    expect(error).toMatchObject({ code: 1 });
    expect(error.stderr).toMatch(/kis-runtime.*80%/);
  });

  it("rejects a missing required runtime source instead of silently excluding it", async () => {
    const { root, report } = await coverageFixture();
    const coverage = JSON.parse(await readFile(report, "utf8"));
    delete coverage[path.join(root, "src/kis/subscription-supervisor.ts")];
    await writeFile(report, JSON.stringify(coverage), "utf8");

    const error = await execFileAsync(process.execPath, [scriptPath, report, root])
      .catch((caught: unknown) => caught as { code: number; stderr: string });

    expect(error).toMatchObject({ code: 1 });
    expect(error.stderr).toContain("subscription-supervisor.ts");
  });
});
