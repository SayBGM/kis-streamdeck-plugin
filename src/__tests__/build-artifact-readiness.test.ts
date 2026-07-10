import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve(process.cwd(), "scripts/wait-for-build-artifacts.mjs");
const tempRoots: string[] = [];

async function fixture(): Promise<{ root: string; plugin: string; sourceMap: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kis-build-ready-"));
  tempRoots.push(root);
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  return {
    root,
    plugin: path.join(bin, "plugin.js"),
    sourceMap: path.join(bin, "plugin.js.map"),
  };
}

function waitCommand(plugin: string, sourceMap: string, timeoutMs = 1_000) {
  return execFileAsync(process.execPath, [
    scriptPath,
    plugin,
    sourceMap,
    `--timeout-ms=${timeoutMs}`,
    "--poll-ms=20",
    "--stable-polls=3",
  ]);
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("build artifact readiness", { timeout: 5_000 }, () => {
  it("accepts regular non-empty artifacts after consecutive stable polls", async () => {
    const { plugin, sourceMap } = await fixture();
    await writeFile(plugin, "plugin", "utf8");
    await writeFile(sourceMap, "map", "utf8");

    const result = await waitCommand(plugin, sourceMap);

    expect(result.stdout).toContain("빌드 산출물 준비 완료");
  });

  it("waits for both artifacts to appear after the producer exits", async () => {
    const { plugin, sourceMap } = await fixture();
    const waiting = waitCommand(plugin, sourceMap);
    const producer = setTimeout(() => {
      void Promise.all([
        writeFile(plugin, "delayed plugin", "utf8"),
        writeFile(sourceMap, "delayed map", "utf8"),
      ]);
    }, 60);

    let result;
    try {
      result = await waiting;
    } finally {
      clearTimeout(producer);
    }

    expect(result.stdout).toContain("빌드 산출물 준비 완료");
  });

  it("does not accept partial files before their content becomes stable", async () => {
    const { plugin, sourceMap } = await fixture();
    const waiting = waitCommand(plugin, sourceMap);
    const partial = setTimeout(() => {
      void Promise.all([
        writeFile(plugin, "partial", "utf8"),
        writeFile(sourceMap, "partial", "utf8"),
      ]);
    }, 30);
    const complete = setTimeout(() => {
      void Promise.all([
        writeFile(plugin, "complete plugin", "utf8"),
        writeFile(sourceMap, "complete map", "utf8"),
      ]);
    }, 70);

    try {
      await waiting;
    } finally {
      clearTimeout(partial);
      clearTimeout(complete);
    }

    expect(await readFile(plugin, "utf8")).toBe("complete plugin");
    expect(await readFile(sourceMap, "utf8")).toBe("complete map");
  });

  it("fails with a bounded timeout when artifacts never appear", async () => {
    const { plugin, sourceMap } = await fixture();

    const error = await waitCommand(plugin, sourceMap, 150)
      .catch((caught: unknown) => caught as { code: number; stderr: string });

    expect(error).toMatchObject({ code: 1 });
    expect(error.stderr).toMatch(/시간|timeout|준비되지/i);
  });
});
