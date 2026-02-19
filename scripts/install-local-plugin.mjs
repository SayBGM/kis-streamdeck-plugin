import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const manifestPath = path.join(projectRoot, "manifest.json");

const manifestRaw = await readFile(manifestPath, "utf8");
const manifest = JSON.parse(manifestRaw);

if (!manifest.UUID || typeof manifest.UUID !== "string") {
  throw new Error("manifest.json의 UUID를 찾지 못했습니다.");
}

const pluginFolderName = `${manifest.UUID}.sdPlugin`;
const pluginsRoot = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "com.elgato.StreamDeck",
  "Plugins",
);
const targetDir = path.join(pluginsRoot, pluginFolderName);

await mkdir(pluginsRoot, { recursive: true });
await rm(targetDir, { recursive: true, force: true });
await mkdir(targetDir, { recursive: true });

const copyTasks = [
  ["manifest.json", "manifest.json"],
  ["bin", "bin"],
  ["imgs", "imgs"],
  ["ui", "ui"],
];

for (const [from, to] of copyTasks) {
  const fromPath = path.join(projectRoot, from);
  const toPath = path.join(targetDir, to);
  const targetStat = await stat(fromPath).catch(() => null);
  if (!targetStat) {
    throw new Error(`필수 경로가 없습니다: ${from}`);
  }

  if (targetStat.isDirectory()) {
    await cp(fromPath, toPath, { recursive: true, force: true });
  } else {
    await cp(fromPath, toPath, { force: true });
  }
}

const markerPath = path.join(targetDir, ".local-install-marker");
await writeFile(
  markerPath,
  `Installed at ${new Date().toISOString()}\nsource=${projectRoot}\n`,
  "utf8",
);

console.log(`로컬 Stream Deck 플러그인 설치 완료: ${targetDir}`);
console.log("Stream Deck 앱에서 플러그인을 다시 불러오면 최신 빌드가 반영됩니다.");
