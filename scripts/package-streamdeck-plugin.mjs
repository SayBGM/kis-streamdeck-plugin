import { cp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const manifestPath = path.join(projectRoot, "manifest.json");
const distRoot = path.join(projectRoot, "dist");

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: process.env,
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

if (!uuid || !version) {
  throw new Error("manifest.json 에서 UUID 또는 Version을 찾지 못했습니다.");
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
await cp(path.join(projectRoot, "bin"), path.join(stageDir, "bin"), {
  recursive: true,
});
await cp(path.join(projectRoot, "package.json"), path.join(stageDir, "package.json"));
await cp(
  path.join(projectRoot, "package-lock.json"),
  path.join(stageDir, "package-lock.json"),
);

await run("npm", ["ci", "--omit=dev", "--prefix", stageDir], projectRoot);

const zipCommand =
  os.platform() === "win32"
    ? [
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Compress-Archive -Path "${stageDir}" -DestinationPath "${outputPath}.zip" -Force`,
        ],
      ]
    : [
        "zip",
        ["-r", outputFile, stageDirName],
      ];

if (os.platform() === "win32") {
  await run(zipCommand[0], zipCommand[1], projectRoot);
  await rm(outputPath, { force: true });
  await cp(`${outputPath}.zip`, outputPath);
  await rm(`${outputPath}.zip`, { force: true });
} else {
  await run(zipCommand[0], zipCommand[1], distRoot);
}

console.log(`패키징 완료: ${outputPath}`);
