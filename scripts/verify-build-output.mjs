import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(scriptDir, "..");
const projectRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : defaultProjectRoot;
const pluginPath = path.join(projectRoot, "bin", "plugin.js");
const sourceMapPath = `${pluginPath}.map`;

const forbiddenLegacySources = [
  "src/kis/auth.ts",
  "src/kis/rest-price.ts",
  "src/kis/settings-store.ts",
  "src/kis/websocket-manager.ts",
];

async function requireNonEmptyFile(filePath, label) {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new Error(`${label} 파일을 찾을 수 없습니다: ${filePath}`);
  }
  if (!info.isFile() || info.size <= 0) {
    throw new Error(`${label} 파일이 비어 있거나 일반 파일이 아닙니다: ${filePath}`);
  }
}

await requireNonEmptyFile(pluginPath, "플러그인 번들");
await requireNonEmptyFile(sourceMapPath, "플러그인 소스맵");

const [pluginSource, sourceMapRaw] = await Promise.all([
  readFile(pluginPath, "utf8"),
  readFile(sourceMapPath, "utf8"),
]);

if (!pluginSource.includes("sourceMappingURL=plugin.js.map")) {
  throw new Error("플러그인 번들이 plugin.js.map을 참조하지 않습니다.");
}

let sourceMap;
try {
  sourceMap = JSON.parse(sourceMapRaw);
} catch {
  throw new Error("플러그인 소스맵 JSON이 올바르지 않습니다.");
}

if (
  sourceMap?.version !== 3 ||
  sourceMap.file !== "plugin.js" ||
  !Array.isArray(sourceMap.sources) ||
  sourceMap.sources.length === 0 ||
  !sourceMap.sources.every((source) => typeof source === "string") ||
  typeof sourceMap.mappings !== "string" ||
  sourceMap.mappings.length === 0
) {
  throw new Error("플러그인 소스맵 구조가 올바르지 않습니다.");
}

const normalizedSources = sourceMap.sources.map((source) =>
  source.replaceAll("\\", "/").replace(/^\.\.\//, ""),
);
for (const forbidden of forbiddenLegacySources) {
  if (
    normalizedSources.some((source) => source.endsWith(forbidden)) ||
    pluginSource.includes(path.basename(forbidden))
  ) {
    throw new Error(`금지된 legacy 런타임 모듈이 번들에 포함됐습니다: ${forbidden}`);
  }
}

try {
  await execFileAsync(process.execPath, ["--check", pluginPath], {
    encoding: "utf8",
  });
} catch {
  throw new Error("생성된 plugin.js의 JavaScript 구문 검사가 실패했습니다.");
}

console.log(`빌드 산출물 검증 완료: ${pluginPath}`);
