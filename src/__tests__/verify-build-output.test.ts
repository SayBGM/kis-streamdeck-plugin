import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve(process.cwd(), "scripts/verify-build-output.mjs");
const tempRoots: string[] = [];

const requiredSources = [
  "../src/plugin.ts",
  "../src/runtime/plugin-runtime.ts",
  "../src/actions/domestic-stock.ts",
  "../src/actions/overseas-stock.ts",
  "../src/actions/stock-action-wrapper-runtime.ts",
  "../src/actions/stock-action-controller.ts",
  "../src/settings/schema.ts",
  "../src/settings/settings-repository.ts",
  "../src/kis/connection-supervisor.ts",
  "../src/kis/credential-session.ts",
  "../src/kis/rest-coordinator.ts",
  "../src/kis/subscription-supervisor.ts",
  "../src/core/market-clock.ts",
  "../src/core/diagnostics-store.ts",
  "../src/markets/market-adapter.ts",
  "../src/renderer/render-scheduler.ts",
  "../src/renderer/stock-card.ts",
];

async function fixture(sources: string[] = requiredSources): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kis-build-verify-"));
  tempRoots.push(root);
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  for (const source of sources) {
    const sourcePath = path.resolve(bin, source);
    const sourceRoot = path.join(root, "src");
    if (sourcePath !== sourceRoot && !sourcePath.startsWith(`${sourceRoot}${path.sep}`)) {
      continue;
    }
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, "export {};\n", "utf8");
  }
  await writeFile(
    path.join(bin, "plugin.js"),
    [
      'import streamDeck from "@elgato/streamdeck";',
      'import WebSocket from "ws";',
      "function createPluginRuntime() { return {}; }",
      "const runtime = createPluginRuntime();",
      "void WebSocket;",
      "streamDeck.settings.useExperimentalMessageIdentifiers = true;",
      "streamDeck.actions.registerAction(runtime);",
      "void streamDeck.connect();",
      "//# sourceMappingURL=plugin.js.map",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(bin, "plugin.js.map"),
    JSON.stringify({
      version: 3,
      file: "plugin.js",
      sources,
      sourcesContent: sources.map(() => "export {};\n"),
      names: [],
      mappings: "AAAA",
    }),
    "utf8",
  );
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true }),
  ));
});

// Each case launches a real Node subprocess. Under full-suite parallel load on
// Node 24, process startup can exceed Vitest's 5s default despite taking <1s alone.
describe("verify-build-output", { timeout: 15_000 }, () => {
  it("accepts a non-empty syntax-valid bundle and source map", async () => {
    const root = await fixture();

    const result = await execFileAsync(process.execPath, [scriptPath, root]);

    expect(result.stdout).toContain("빌드 산출물 검증 완료");
  });

  it("rejects an empty generated bundle", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "bin/plugin.js"), "", "utf8");

    await expect(execFileAsync(process.execPath, [scriptPath, root]))
      .rejects.toMatchObject({ code: 1 });
  });

  it("rejects source maps that include forbidden legacy runtime modules", async () => {
    const root = await fixture([...requiredSources, "../src/kis/auth.ts"]);

    const error = await execFileAsync(process.execPath, [scriptPath, root])
      .catch((caught: unknown) => caught as { code: number; stderr: string });

    expect(error).toMatchObject({ code: 1 });
    expect(error.stderr).toContain("auth.ts");
  });

  it("rejects a placeholder bundle whose source map only names plugin.ts", async () => {
    const root = await fixture(["../src/plugin.ts"]);

    const error = await execFileAsync(process.execPath, [scriptPath, root])
      .catch((caught: unknown) => caught as { code: number; stderr: string });

    expect(error).toMatchObject({ code: 1 });
    expect(error.stderr).toContain("plugin-runtime.ts");
  });

  it("rejects outputs older than a mapped runtime source", async () => {
    const root = await fixture();
    const future = new Date(Date.now() + 60_000);
    await utimes(path.join(root, "src/plugin.ts"), future, future);

    const error = await execFileAsync(process.execPath, [scriptPath, root])
      .catch((caught: unknown) => caught as { code: number; stderr: string });

    expect(error).toMatchObject({ code: 1 });
    expect(error.stderr).toContain("최신");
  });

  it("rejects source-map paths that escape projectRoot/src", async () => {
    const root = await fixture([...requiredSources, "../../escape.ts"]);

    const error = await execFileAsync(process.execPath, [scriptPath, root])
      .catch((caught: unknown) => caught as { code: number; stderr: string });

    expect(error).toMatchObject({ code: 1 });
    expect(error.stderr).toContain("projectRoot/src 밖");
  });

  it("rejects a no-op bundle even when all required sources are named", async () => {
    const root = await fixture();
    await writeFile(
      path.join(root, "bin/plugin.js"),
      'import streamDeck from "@elgato/streamdeck";\nimport WebSocket from "ws";\nvoid streamDeck; void WebSocket;\n//# sourceMappingURL=plugin.js.map\n',
      "utf8",
    );

    const error = await execFileAsync(process.execPath, [scriptPath, root])
      .catch((caught: unknown) => caught as { code: number; stderr: string });

    expect(error).toMatchObject({ code: 1 });
    expect(error.stderr).toContain("필수 런타임 구성");
  });

  it("rejects mismatched sources and sourcesContent", async () => {
    const root = await fixture();
    const mapPath = path.join(root, "bin/plugin.js.map");
    const sourceMap = JSON.parse(await readFile(mapPath, "utf8")) as {
      sourcesContent: string[];
    };
    sourceMap.sourcesContent.pop();
    await writeFile(mapPath, JSON.stringify(sourceMap), "utf8");

    await expect(execFileAsync(process.execPath, [scriptPath, root]))
      .rejects.toMatchObject({ code: 1 });
  });

  it("rejects a syntax-invalid runtime bundle", async () => {
    const root = await fixture();
    const pluginPath = path.join(root, "bin/plugin.js");
    await writeFile(
      pluginPath,
      `${await readFile(pluginPath, "utf8")}\nfunction broken( {\n`,
      "utf8",
    );
    expect(await readFile(pluginPath, "utf8")).toContain("function broken( {");

    const error = await execFileAsync(process.execPath, [scriptPath, root])
      .catch((caught: unknown) => caught as { code: number; stderr: string });

    expect(error).toMatchObject({ code: 1 });
    expect(error.stderr).toContain("구문 검사");
  });
});
