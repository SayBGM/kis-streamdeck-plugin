import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("delivery configuration", () => {
  it("runs Node 24 verification and package smoke in CI with read-only permissions", async () => {
    const workflow = await readFile(path.join(root, ".github/workflows/ci.yml"), "utf8");

    expect(workflow).toContain('node-version: "24"');
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("npm ci");
    expect(workflow).toContain("npm run verify");
    expect(workflow).toContain("npm run package:plugin");
  });

  it("reuses package scripts in the Node 24 release workflow", async () => {
    const workflow = await readFile(
      path.join(root, ".github/workflows/release-streamdeck-plugin.yml"),
      "utf8",
    );

    expect(workflow).toContain('node-version: "24"');
    expect(workflow).toContain("npm run verify");
    expect(workflow).toContain("npm run package:plugin");
    expect(workflow).not.toContain("npm ci --omit=dev --prefix");
    expect(workflow).not.toContain("zip -r");
  });

  it("documents the v2 support policy, migration, diagnostics, and holiday limitation", async () => {
    const readme = await readFile(path.join(root, "README.md"), "utf8");

    for (const text of [
      "Stream Deck 7.1",
      "Node.js 24",
      "@elgato/streamdeck 2.1.0",
      "자동",
      "REST 전용",
      "2초",
      "5초",
      "10초",
      "15초",
      "30초",
      "60초",
      "v1",
      "v2",
      "진단",
      "공휴일",
      "실전투자",
    ]) {
      expect(readme).toContain(text);
    }
    expect(readme).not.toContain("src/kis/auth.ts");
    expect(readme).not.toContain("src/kis/websocket-manager.ts");
    expect(readme).not.toContain("src/kis/rest-price.ts");
  });

  it("packages only the verified runtime bundle files from bin", async () => {
    const script = await readFile(
      path.join(root, "scripts/package-streamdeck-plugin.mjs"),
      "utf8",
    );

    expect(script).toContain('path.join(stageDir, "bin", "plugin.js")');
    expect(script).toContain('path.join(stageDir, "bin", "plugin.js.map")');
    expect(script).not.toContain(
      'cp(path.join(projectRoot, "bin"), path.join(stageDir, "bin")',
    );
  });

  it("selects npm.cmd on Windows and npm on POSIX", async () => {
    const commandScript = path.join(root, "scripts/package-manager-command.mjs");

    const windows = execFileSync(process.execPath, [commandScript, "win32"], {
      encoding: "utf8",
    });
    const posix = execFileSync(process.execPath, [commandScript, "linux"], {
      encoding: "utf8",
    });

    expect(windows.trim()).toBe("npm.cmd");
    expect(posix.trim()).toBe("npm");
  });

  it("documents the POSIX zip CLI packaging prerequisite", async () => {
    const readme = await readFile(path.join(root, "README.md"), "utf8");

    expect(readme).toMatch(/zip CLI|zip 명령|`zip`/i);
  });
});
