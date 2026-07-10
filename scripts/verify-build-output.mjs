import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
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

const requiredRuntimeSources = [
  "src/plugin.ts",
  "src/runtime/plugin-runtime.ts",
  "src/actions/domestic-stock.ts",
  "src/actions/overseas-stock.ts",
  "src/actions/stock-action-wrapper-runtime.ts",
  "src/actions/stock-action-controller.ts",
  "src/settings/schema.ts",
  "src/settings/settings-repository.ts",
  "src/kis/credential-session.ts",
  "src/kis/rest-coordinator.ts",
  "src/kis/connection-supervisor.ts",
  "src/kis/subscription-supervisor.ts",
  "src/core/market-clock.ts",
  "src/core/diagnostics-store.ts",
  "src/markets/market-adapter.ts",
  "src/renderer/render-scheduler.ts",
  "src/renderer/stock-card.ts",
];

const requiredBundleFragments = [
  "createPluginRuntime",
  "useExperimentalMessageIdentifiers",
  "actions.registerAction",
  "streamDeck.connect",
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
  return info;
}

const pluginInfo = await requireNonEmptyFile(pluginPath, "플러그인 번들");
const sourceMapInfo = await requireNonEmptyFile(sourceMapPath, "플러그인 소스맵");

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
  !Array.isArray(sourceMap.sourcesContent) ||
  sourceMap.sourcesContent.length !== sourceMap.sources.length ||
  !sourceMap.sourcesContent.every((source) => typeof source === "string") ||
  typeof sourceMap.mappings !== "string" ||
  sourceMap.mappings.length === 0
) {
  throw new Error("플러그인 소스맵 구조가 올바르지 않습니다.");
}

const sourceRoot = path.join(projectRoot, "src");
const sourceRootPrefix = `${sourceRoot}${path.sep}`;
const normalizedSources = [];
let newestSourceMtime = 0;

for (let index = 0; index < sourceMap.sources.length; index += 1) {
  const mappedSource = sourceMap.sources[index];
  const resolvedSource = path.resolve(path.dirname(sourceMapPath), mappedSource);
  if (resolvedSource !== sourceRoot && !resolvedSource.startsWith(sourceRootPrefix)) {
    throw new Error(`소스맵 경로가 projectRoot/src 밖을 가리킵니다: ${mappedSource}`);
  }
  const relativeSource = `src/${path.relative(sourceRoot, resolvedSource).replaceAll("\\", "/")}`;
  normalizedSources.push(relativeSource);

  let diskSource;
  let sourceInfo;
  try {
    [diskSource, sourceInfo] = await Promise.all([
      readFile(resolvedSource, "utf8"),
      stat(resolvedSource),
    ]);
  } catch {
    throw new Error(`소스맵 원본 파일을 찾을 수 없습니다: ${relativeSource}`);
  }
  if (diskSource !== sourceMap.sourcesContent[index]) {
    throw new Error(`소스맵 내용이 최신 디스크 소스와 일치하지 않습니다: ${relativeSource}`);
  }
  newestSourceMtime = Math.max(newestSourceMtime, sourceInfo.mtimeMs);
}

for (const required of requiredRuntimeSources) {
  if (!normalizedSources.includes(required)) {
    throw new Error(`필수 런타임 소스가 번들 소스맵에 없습니다: ${required}`);
  }
}

for (const forbidden of forbiddenLegacySources) {
  if (
    normalizedSources.some((source) => source.endsWith(forbidden)) ||
    pluginSource.includes(path.basename(forbidden))
  ) {
    throw new Error(`금지된 legacy 런타임 모듈이 번들에 포함됐습니다: ${forbidden}`);
  }
}

if (
  pluginInfo.mtimeMs < newestSourceMtime ||
  sourceMapInfo.mtimeMs < newestSourceMtime
) {
  throw new Error("빌드 산출물이 최신 런타임 소스보다 오래됐습니다.");
}

for (const fragment of requiredBundleFragments) {
  if (!pluginSource.includes(fragment)) {
    throw new Error(`플러그인 번들에 필수 런타임 구성이 없습니다: ${fragment}`);
  }
}

for (const external of ["@elgato/streamdeck", "ws"]) {
  const escaped = external.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const importPattern = new RegExp(`(?:from\\s+|import\\s*)["']${escaped}["']`);
  if (!importPattern.test(pluginSource)) {
    throw new Error(`필수 external import가 번들에 없습니다: ${external}`);
  }
}

const syntaxTree = ts.createSourceFile(
  pluginPath,
  pluginSource,
  ts.ScriptTarget.ESNext,
  true,
  ts.ScriptKind.JS,
);
if (syntaxTree.parseDiagnostics.length > 0) {
  throw new Error("생성된 plugin.js의 JavaScript 구문 검사가 실패했습니다.");
}

const syntaxExitCode = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["--check", pluginPath], {
    stdio: "ignore",
  });
  child.on("error", reject);
  child.on("close", resolve);
}).catch(() => -1);
if (syntaxExitCode !== 0) {
  throw new Error("생성된 plugin.js의 JavaScript 구문 검사가 실패했습니다.");
}

console.log(`빌드 산출물 검증 완료: ${pluginPath}`);
