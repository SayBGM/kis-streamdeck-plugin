import { cp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyPluginPackage } from "./verify-plugin-package.mjs";
import { packageManagerCommand } from "./package-manager-command.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const manifestPath = path.join(projectRoot, "manifest.json");
const distRoot = path.join(projectRoot, "dist");

function run(command, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env,
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with code ${code ?? "unknown"}`));
    });
  });
}

const manifestRaw = await readFile(manifestPath, "utf8");
const manifest = JSON.parse(manifestRaw);
const uuid = manifest.UUID;
const version = manifest.Version;

if (
  typeof uuid !== "string" ||
  !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(uuid) ||
  typeof version !== "string" ||
  !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)
) {
  throw new Error("manifest.json의 UUID 또는 Version이 안전한 형식이 아닙니다.");
}

const stageDirName = `${uuid}.sdPlugin`;
const stageDir = path.join(distRoot, stageDirName);
const outputFile = `${uuid}-v${version}.streamDeckPlugin`;
const outputPath = path.join(distRoot, outputFile);

await rm(distRoot, { recursive: true, force: true });
await rm(outputPath, { force: true });
await mkdir(stageDir, { recursive: true });

await cp(path.join(projectRoot, "manifest.json"), path.join(stageDir, "manifest.json"));
await cp(path.join(projectRoot, "imgs"), path.join(stageDir, "imgs"), {
  recursive: true,
});
await cp(path.join(projectRoot, "ui"), path.join(stageDir, "ui"), {
  recursive: true,
});
await mkdir(path.join(stageDir, "bin"), { recursive: true });
await cp(
  path.join(projectRoot, "bin", "plugin.js"),
  path.join(stageDir, "bin", "plugin.js"),
);
await cp(
  path.join(projectRoot, "bin", "plugin.js.map"),
  path.join(stageDir, "bin", "plugin.js.map"),
);
await cp(path.join(projectRoot, "package.json"), path.join(stageDir, "package.json"));
await cp(
  path.join(projectRoot, "package-lock.json"),
  path.join(stageDir, "package-lock.json"),
);

await run(
  packageManagerCommand(os.platform()),
  ["ci", "--omit=dev", "--prefix", stageDir],
  projectRoot,
);

if (os.platform() === "win32") {
  await run(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Compress-Archive -LiteralPath $env:KIS_STAGE_DIR -DestinationPath $env:KIS_OUTPUT_ZIP -Force",
    ],
    projectRoot,
    {
      ...process.env,
      KIS_STAGE_DIR: stageDir,
      KIS_OUTPUT_ZIP: `${outputPath}.zip`,
    },
  );
  await rm(outputPath, { force: true });
  await cp(`${outputPath}.zip`, outputPath);
  await rm(`${outputPath}.zip`, { force: true });
} else {
  await run("zip", ["-rq", outputFile, stageDirName], distRoot);
}

const smoke = await verifyPluginPackage({ archivePath: outputPath });
console.log(`패키징 완료: ${outputPath}`);
console.log(
  `패키지 크기: archive ${smoke.archiveBytes} bytes, installed ${smoke.installedBytes} bytes`,
);
