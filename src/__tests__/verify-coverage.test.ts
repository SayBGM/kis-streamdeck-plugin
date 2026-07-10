import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const tempRoots: string[] = [];
const execFileAsync = promisify(execFile);
const scriptPath = path.resolve(process.cwd(), "scripts/verify-coverage.mjs");

function coveredFile(branchHits: number[], filePath = "fixture.ts"): object {
  return {
    path: filePath,
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
  const baselinePaths = [
    path.join(src, "core/errors.ts"),
    path.join(src, "settings/schema.ts"),
    path.join(src, "actions/stock-action-controller.ts"),
    path.join(src, "renderer/render-scheduler.ts"),
    path.join(src, "kis/credential-session.ts"),
    path.join(src, "kis/rest-coordinator.ts"),
    path.join(src, "kis/connection-supervisor.ts"),
    path.join(src, "kis/subscription-supervisor.ts"),
  ];
  const baseline = Object.fromEntries(
    baselinePaths.map((filePath) => [filePath, coveredFile([2, 2, 2, 2, 2], filePath)]),
  );
  for (const filePath of baselinePaths) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "export {};\n", "utf8");
  }
  const files: Record<string, object> = {
    ...baseline,
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
      const filePath = path.join(root, "src/kis", source);
      coverage[filePath] = coveredFile([2, 0, 0, 0, 0], filePath);
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

  it("rejects a nonexistent fake core record instead of letting it inflate coverage", async () => {
    const { root, report } = await coverageFixture();
    const coverage = JSON.parse(await readFile(report, "utf8"));
    const fakePath = path.join(root, "src/core/fake-high-coverage.ts");
    coverage[fakePath] = coveredFile([2, 2, 2, 2, 2], fakePath);
    await writeFile(report, JSON.stringify(coverage), "utf8");

    const error = await execFileAsync(process.execPath, [scriptPath, report, root])
      .catch((caught: unknown) => caught as { code: number; stderr: string });

    expect(error).toMatchObject({ code: 1 });
    expect(error.stderr).toMatch(/fake-high-coverage\.ts.*존재|찾지 못|regular/i);
  });

  it("rejects an existing coverage source outside projectRoot/src", async () => {
    const { root, report } = await coverageFixture();
    const outsidePath = path.join(root, "outside.ts");
    await writeFile(outsidePath, "export {};\n", "utf8");
    const coverage = JSON.parse(await readFile(report, "utf8"));
    coverage[outsidePath] = coveredFile([2, 2], outsidePath);
    await writeFile(report, JSON.stringify(coverage), "utf8");

    const error = await execFileAsync(process.execPath, [scriptPath, report, root])
      .catch((caught: unknown) => caught as { code: number; stderr: string });

    expect(error).toMatchObject({ code: 1 });
    expect(error.stderr).toMatch(/projectRoot\/src|src 밖|outside\.ts/i);
  });

  it("rejects a non-TypeScript coverage source", async () => {
    const { root, report } = await coverageFixture();
    const javascriptPath = path.join(root, "src/core/not-typescript.js");
    await writeFile(javascriptPath, "export {};\n", "utf8");
    const coverage = JSON.parse(await readFile(report, "utf8"));
    coverage[javascriptPath] = coveredFile([2, 2], javascriptPath);
    await writeFile(report, JSON.stringify(coverage), "utf8");

    const error = await execFileAsync(process.execPath, [scriptPath, report, root])
      .catch((caught: unknown) => caught as { code: number; stderr: string });

    expect(error).toMatchObject({ code: 1 });
    expect(error.stderr).toMatch(/\.ts|TypeScript/i);
  });

  it("rejects two report keys that canonicalize to the same source", async () => {
    const { root, report } = await coverageFixture();
    const coverage = JSON.parse(await readFile(report, "utf8"));
    const canonicalPath = path.join(root, "src/core/errors.ts");
    const aliasPath = `${root}/src/core/../core/errors.ts`;
    coverage[aliasPath] = coveredFile([2, 2], aliasPath);
    await writeFile(report, JSON.stringify(coverage), "utf8");

    const error = await execFileAsync(process.execPath, [scriptPath, report, root])
      .catch((caught: unknown) => caught as { code: number; stderr: string });

    expect(canonicalPath).not.toBe(aliasPath);
    expect(error).toMatchObject({ code: 1 });
    expect(error.stderr).toMatch(/중복|duplicate|canonical/i);
  });

  it.each([
    ["CaseCollision.ts", "casecollision.ts"],
    ["caf\u00e9.ts", "cafe\u0301.ts"],
  ])("rejects case or Unicode canonical source collisions: %s / %s", async (first, second) => {
    const { root, report } = await coverageFixture();
    const firstPath = path.join(root, "src/core", first);
    const secondPath = path.join(root, "src/core", second);
    await writeFile(firstPath, "export {};\n", "utf8");
    await writeFile(secondPath, "export {};\n", "utf8");
    const coverage = JSON.parse(await readFile(report, "utf8"));
    coverage[firstPath] = coveredFile([2, 2], firstPath);
    coverage[secondPath] = coveredFile([2, 2], secondPath);
    await writeFile(report, JSON.stringify(coverage), "utf8");

    const error = await execFileAsync(process.execPath, [scriptPath, report, root])
      .catch((caught: unknown) => caught as { code: number; stderr: string });

    expect(error).toMatchObject({ code: 1 });
    expect(error.stderr).toMatch(/중복|Unicode|대소문자|collision/i);
  });

  it("rejects a report that omits an existing production TypeScript source", async () => {
    const { root, report } = await coverageFixture();
    const omittedPath = path.join(root, "src/core/unreported.ts");
    await writeFile(omittedPath, "export {};\n", "utf8");

    const error = await execFileAsync(process.execPath, [scriptPath, report, root])
      .catch((caught: unknown) => caught as { code: number; stderr: string });

    expect(error).toMatchObject({ code: 1 });
    expect(error.stderr).toMatch(/누락|missing|unreported\.ts/i);
  });

  it.each([
    "src/plugin.ts",
    "src/core/injected.test.ts",
    "src/core/__tests__/helper.ts",
  ])("rejects an excluded non-production coverage record: %s", async (relative) => {
    const { root, report } = await coverageFixture();
    const excludedPath = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(excludedPath), { recursive: true });
    await writeFile(excludedPath, "export {};\n", "utf8");
    const coverage = JSON.parse(await readFile(report, "utf8"));
    coverage[excludedPath] = coveredFile([2, 2], excludedPath);
    await writeFile(report, JSON.stringify(coverage), "utf8");

    const error = await execFileAsync(process.execPath, [scriptPath, report, root])
      .catch((caught: unknown) => caught as { code: number; stderr: string });

    expect(error).toMatchObject({ code: 1 });
    expect(error.stderr).toMatch(/제외|non-production|test|plugin\.ts/i);
  });
});
