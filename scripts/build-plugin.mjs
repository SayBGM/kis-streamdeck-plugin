import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waitForBuildArtifacts } from "./wait-for-build-artifacts.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const rollupBin = path.join(projectRoot, "node_modules", "rollup", "dist", "bin", "rollup");
const pluginPath = path.join(projectRoot, "bin", "plugin.js");
const sourceMapPath = `${pluginPath}.map`;

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`node ${args.join(" ")} failed with code ${code ?? "unknown"}`));
    });
  });
}

// A failed forced-exit build must not leave a previous bundle available to packaging.
await Promise.all([
  rm(pluginPath, { force: true }),
  rm(sourceMapPath, { force: true }),
]);
await runNode([rollupBin, "-c", "--forceExit"]);
await waitForBuildArtifacts([pluginPath, sourceMapPath]);
await runNode([path.join(scriptDir, "verify-build-output.mjs"), projectRoot]);
