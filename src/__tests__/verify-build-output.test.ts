import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve(process.cwd(), "scripts/verify-build-output.mjs");
const tempRoots: string[] = [];

async function fixture(sources: string[] = ["../src/plugin.ts"]): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kis-build-verify-"));
  tempRoots.push(root);
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(
    path.join(bin, "plugin.js"),
    'import streamDeck from "@elgato/streamdeck";\nvoid streamDeck;\n//# sourceMappingURL=plugin.js.map\n',
    "utf8",
  );
  await writeFile(
    path.join(bin, "plugin.js.map"),
    JSON.stringify({
      version: 3,
      file: "plugin.js",
      sources,
      sourcesContent: sources.map(() => "export {};"),
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

describe("verify-build-output", () => {
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
    const root = await fixture(["../src/plugin.ts", "../src/kis/auth.ts"]);

    const error = await execFileAsync(process.execPath, [scriptPath, root])
      .catch((caught: unknown) => caught as { code: number; stderr: string });

    expect(error).toMatchObject({ code: 1 });
    expect(error.stderr).toContain("auth.ts");
  });
});
