import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(scriptDir, "..");

const MIN_GLOBAL_LINES = 80;
const MIN_GROUP_BRANCHES = 80;

const exactGroups = [
  {
    name: "stock-action-controller",
    files: ["src/actions/stock-action-controller.ts"],
  },
  {
    name: "render-scheduler",
    files: ["src/renderer/render-scheduler.ts"],
  },
  {
    name: "kis-runtime",
    files: [
      "src/kis/credential-session.ts",
      "src/kis/rest-coordinator.ts",
      "src/kis/connection-supervisor.ts",
      "src/kis/subscription-supervisor.ts",
    ],
  },
];

function percent(covered, total) {
  return total === 0 ? 100 : (covered / total) * 100;
}

async function canonicalCoverageRecords(coverage, projectRoot) {
  const canonicalProjectRoot = await realpath(projectRoot);
  const sourceRoot = await realpath(path.join(canonicalProjectRoot, "src"));
  const sourceRootInfo = await stat(sourceRoot);
  if (!sourceRootInfo.isDirectory()) {
    throw new Error(`projectRoot/src가 디렉터리가 아닙니다: ${sourceRoot}`);
  }

  const canonicalSources = new Set();
  const portableSources = new Set();
  const records = [];
  for (const [reportKey, data] of Object.entries(coverage)) {
    const inputPath = path.isAbsolute(reportKey)
      ? path.resolve(reportKey)
      : path.resolve(canonicalProjectRoot, reportKey);
    let canonicalSource;
    let sourceInfo;
    try {
      canonicalSource = await realpath(inputPath);
      sourceInfo = await stat(canonicalSource);
    } catch {
      throw new Error(`coverage source가 존재하는 regular .ts 파일이 아닙니다: ${reportKey}`);
    }
    if (!sourceInfo.isFile() || path.extname(canonicalSource) !== ".ts") {
      throw new Error(`coverage source가 regular TypeScript .ts 파일이 아닙니다: ${reportKey}`);
    }

    const sourceRelative = path.relative(sourceRoot, canonicalSource);
    if (
      sourceRelative === "" ||
      sourceRelative === ".." ||
      sourceRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(sourceRelative)
    ) {
      throw new Error(`coverage source가 projectRoot/src 밖을 가리킵니다: ${reportKey}`);
    }

    if (typeof data !== "object" || data === null || typeof data.path !== "string") {
      throw new Error(`coverage record path가 올바르지 않습니다: ${reportKey}`);
    }
    const dataPath = path.isAbsolute(data.path)
      ? path.resolve(data.path)
      : path.resolve(canonicalProjectRoot, data.path);
    let canonicalDataPath;
    try {
      canonicalDataPath = await realpath(dataPath);
    } catch {
      throw new Error(`coverage record path가 존재하지 않습니다: ${data.path}`);
    }
    if (canonicalDataPath !== canonicalSource) {
      throw new Error(`coverage key와 record path가 다른 source를 가리킵니다: ${reportKey}`);
    }

    const relative = sourceRelative.replaceAll("\\", "/");
    const portable = relative
      .split("/")
      .map((component) => component.normalize("NFC").toLocaleLowerCase("en-US"))
      .join("/");
    if (canonicalSources.has(canonicalSource) || portableSources.has(portable)) {
      throw new Error(`중복 또는 Unicode/대소문자 충돌 coverage source입니다: ${reportKey}`);
    }
    canonicalSources.add(canonicalSource);
    portableSources.add(portable);
    records.push({ relative: `src/${relative}`, data });
  }
  return records;
}

function lineCounts(fileCoverage) {
  const lines = new Map();
  for (const [statementId, statement] of Object.entries(fileCoverage.statementMap ?? {})) {
    const line = statement?.start?.line;
    if (!Number.isInteger(line)) continue;
    const hits = Number(fileCoverage.s?.[statementId] ?? 0);
    lines.set(line, Math.max(lines.get(line) ?? 0, hits));
  }
  return {
    covered: [...lines.values()].filter((hits) => hits > 0).length,
    total: lines.size,
  };
}

function branchCounts(files) {
  let covered = 0;
  let total = 0;
  for (const file of files) {
    for (const branchHits of Object.values(file.b ?? {})) {
      if (!Array.isArray(branchHits)) continue;
      total += branchHits.length;
      covered += branchHits.filter((hits) => Number(hits) > 0).length;
    }
  }
  return { covered, total };
}

export async function verifyCoverage({
  projectRoot = defaultProjectRoot,
  reportPath = path.join(projectRoot, "coverage", "coverage-final.json"),
} = {}) {
  const coverage = JSON.parse(await readFile(reportPath, "utf8"));
  const records = await canonicalCoverageRecords(coverage, projectRoot);
  if (records.length === 0) {
    throw new Error("coverage-final.json에 측정된 TypeScript 파일이 없습니다.");
  }

  const global = records.reduce(
    (summary, record) => {
      const counts = lineCounts(record.data);
      summary.covered += counts.covered;
      summary.total += counts.total;
      return summary;
    },
    { covered: 0, total: 0 },
  );
  const globalLines = percent(global.covered, global.total);
  if (global.total === 0 || globalLines < MIN_GLOBAL_LINES) {
    throw new Error(
      `전체 TypeScript line coverage ${globalLines.toFixed(2)}%가 ${MIN_GLOBAL_LINES}% 미만입니다.`,
    );
  }

  const directoryGroups = [
    { name: "core", prefix: "src/core/" },
    { name: "settings", prefix: "src/settings/" },
  ].map((group) => {
    const selected = records.filter((record) => record.relative.startsWith(group.prefix));
    if (selected.length === 0) {
      throw new Error(`${group.name} coverage 파일을 찾지 못했습니다: ${group.prefix}`);
    }
    return { name: group.name, records: selected };
  });

  const selectedExactGroups = exactGroups.map((group) => {
    const selected = group.files.map((requiredFile) => {
      const record = records.find((candidate) => candidate.relative === requiredFile);
      if (!record) {
        throw new Error(`${group.name} 필수 coverage 파일이 없습니다: ${requiredFile}`);
      }
      return record;
    });
    return { name: group.name, records: selected };
  });

  const groups = [...directoryGroups, ...selectedExactGroups].map((group) => {
    const counts = branchCounts(group.records.map((record) => record.data));
    const branches = percent(counts.covered, counts.total);
    if (counts.total === 0 || branches < MIN_GROUP_BRANCHES) {
      throw new Error(
        `${group.name} branch coverage ${branches.toFixed(2)}%가 ${MIN_GROUP_BRANCHES}% 미만입니다.`,
      );
    }
    return { name: group.name, branches, ...counts };
  });

  return {
    global: { lines: globalLines, ...global },
    groups,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const reportPath = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  const projectRoot = process.argv[3] ? path.resolve(process.argv[3]) : defaultProjectRoot;
  const result = await verifyCoverage({ projectRoot, reportPath });
  console.log(`coverage 검증 완료 — 전체 line: ${result.global.lines.toFixed(2)}%`);
  for (const group of result.groups) {
    console.log(`- ${group.name} branch: ${group.branches.toFixed(2)}%`);
  }
}
