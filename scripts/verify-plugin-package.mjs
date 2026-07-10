import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const DEFAULT_MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_INSTALLED_BYTES = 50 * 1024 * 1024;
const REQUIRED_MODULES = [
  "@elgato/streamdeck",
  "@elgato/utils",
  "@elgato/schemas",
  "zod",
  "ws",
];
const REQUIRED_ACTION_UUIDS = [
  "com.kis.streamdeck.domestic-stock",
  "com.kis.streamdeck.overseas-stock",
];
const WINDOWS_RESERVED_COMPONENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function findEndOfCentralDirectory(archive) {
  const signature = 0x06054b50;
  const minimumOffset = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= minimumOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) !== signature) continue;
    const commentLength = archive.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === archive.length) return offset;
  }
  throw new Error("ZIP central directory 종료 레코드를 찾지 못했습니다.");
}

function normalizeEntryName(rawName) {
  if (!rawName || rawName.includes("\0")) {
    throw new Error("패키지에 비어 있거나 NUL이 포함된 경로가 있습니다.");
  }
  const name = rawName.replaceAll("\\", "/");
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw new Error(`패키지 절대 경로를 허용하지 않습니다: ${rawName}`);
  }
  const isDirectory = name.endsWith("/");
  const rawComponents = name.split("/");
  if (isDirectory) rawComponents.pop();
  if (
    rawComponents.length === 0 ||
    rawComponents.some((component) => component === "" || component === "." || component === "..")
  ) {
    throw new Error(`패키지 path traversal 경로를 허용하지 않습니다: ${rawName}`);
  }
  const components = rawComponents.map((component) => {
    const normalized = component.normalize("NFC");
    if (/[:\u0000-\u001f]/u.test(normalized) || /[. ]$/u.test(normalized)) {
      throw new Error(`Windows에서 모호한 패키지 경로를 허용하지 않습니다: ${rawName}`);
    }
    if (WINDOWS_RESERVED_COMPONENT.test(normalized)) {
      throw new Error(`Windows 예약 장치 이름을 패키지 경로로 허용하지 않습니다: ${rawName}`);
    }
    return normalized;
  });
  return { name: components.join("/") + (isDirectory ? "/" : ""), isDirectory };
}

function parseCentralDirectory(archive) {
  const endOffset = findEndOfCentralDirectory(archive);
  const diskNumber = archive.readUInt16LE(endOffset + 4);
  const centralDisk = archive.readUInt16LE(endOffset + 6);
  const diskEntries = archive.readUInt16LE(endOffset + 8);
  const totalEntries = archive.readUInt16LE(endOffset + 10);
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
    throw new Error("분할 ZIP 패키지는 지원하지 않습니다.");
  }
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error("ZIP64 패키지는 크기 제한상 허용하지 않습니다.");
  }
  if (totalEntries === 0 || totalEntries > 100_000) {
    throw new Error(`ZIP 엔트리 수가 허용 범위를 벗어났습니다: ${totalEntries}`);
  }
  if (centralOffset + centralSize !== endOffset) {
    throw new Error("ZIP central directory 범위가 올바르지 않습니다.");
  }

  const entries = [];
  const names = new Set();
  const foldedNames = new Set();
  let offset = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > endOffset || archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("ZIP central directory 엔트리가 손상됐습니다.");
    }
    const flags = archive.readUInt16LE(offset + 8);
    const compression = archive.readUInt16LE(offset + 10);
    const checksum = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const diskStart = archive.readUInt16LE(offset + 34);
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const localOffset = archive.readUInt32LE(offset + 42);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nextOffset > endOffset) throw new Error("ZIP 엔트리 이름 범위가 올바르지 않습니다.");
    if (flags & 0x1) throw new Error("암호화된 ZIP 엔트리는 허용하지 않습니다.");
    if (compression !== 0 && compression !== 8) {
      throw new Error(`지원하지 않는 ZIP 압축 방식입니다: ${compression}`);
    }
    if (diskStart !== 0) throw new Error("분할 ZIP 엔트리는 허용하지 않습니다.");
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error("ZIP64 엔트리는 허용하지 않습니다.");
    }
    const rawName = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const normalized = normalizeEntryName(rawName);
    if (
      normalized.isDirectory &&
      (checksum !== 0 || compressedSize !== 0 || uncompressedSize !== 0)
    ) {
      throw new Error(`ZIP 디렉터리 엔트리의 CRC와 크기는 0이어야 합니다: ${rawName}`);
    }
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0o170000) === 0o120000) {
      throw new Error(`심볼릭 링크 ZIP 엔트리는 허용하지 않습니다: ${normalized.name}`);
    }
    const folded = normalized.name.toLocaleLowerCase("en-US");
    if (names.has(normalized.name) || foldedNames.has(folded)) {
      throw new Error(`중복 또는 Unicode/대소문자 충돌 ZIP 경로를 허용하지 않습니다: ${rawName}`);
    }
    names.add(normalized.name);
    foldedNames.add(folded);
    entries.push({
      ...normalized,
      rawName,
      flags,
      compression,
      checksum,
      compressedSize,
      uncompressedSize,
      localOffset,
    });
    offset = nextOffset;
  }
  if (offset !== endOffset) throw new Error("ZIP central directory 크기가 일치하지 않습니다.");
  return { entries, centralOffset };
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function extractEntry(archive, entry, centralOffset, maxInstalledBytes) {
  const offset = entry.localOffset;
  if (offset + 30 > centralOffset || archive.readUInt32LE(offset) !== 0x04034b50) {
    throw new Error(`ZIP local header가 손상됐습니다: ${entry.name}`);
  }
  const flags = archive.readUInt16LE(offset + 6);
  const compression = archive.readUInt16LE(offset + 8);
  const localChecksum = archive.readUInt32LE(offset + 14);
  const localCompressedSize = archive.readUInt32LE(offset + 18);
  const localUncompressedSize = archive.readUInt32LE(offset + 22);
  const nameLength = archive.readUInt16LE(offset + 26);
  const extraLength = archive.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (flags !== entry.flags || compression !== entry.compression || dataEnd > centralOffset) {
    throw new Error(`ZIP local/central 메타데이터가 일치하지 않습니다: ${entry.name}`);
  }
  if (
    entry.isDirectory &&
    (localChecksum !== 0 || localCompressedSize !== 0 || localUncompressedSize !== 0)
  ) {
    throw new Error(`ZIP 디렉터리 local header의 CRC와 크기는 0이어야 합니다: ${entry.name}`);
  }
  const localName = archive.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
  if (normalizeEntryName(localName).name !== entry.name) {
    throw new Error(`ZIP local/central 경로가 일치하지 않습니다: ${entry.name}`);
  }
  if (entry.uncompressedSize > maxInstalledBytes) {
    throw new Error(`ZIP 엔트리 설치 크기가 제한을 초과합니다: ${entry.name}`);
  }
  const compressed = archive.subarray(dataStart, dataEnd);
  let data;
  try {
    data = entry.compression === 0
      ? Buffer.from(compressed)
      : inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize + 1 });
  } catch (cause) {
    throw new Error(`ZIP 엔트리 압축 해제에 실패했습니다: ${entry.name}`, { cause });
  }
  if (data.length !== entry.uncompressedSize || crc32(data) !== entry.checksum) {
    throw new Error(`ZIP 엔트리 무결성 검사가 실패했습니다: ${entry.name}`);
  }
  return data;
}

async function nodeSyntaxCheck(filePath) {
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--check", filePath], { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (exitCode !== 0) throw new Error("archive의 bin/plugin.js 구문 검사가 실패했습니다.");
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (cause) {
    throw new Error(`${label} JSON이 올바르지 않습니다.`, { cause });
  }
}

function requireExact(value, expected, label) {
  if (value !== expected) {
    throw new Error(`${label}은(는) 정확히 ${expected}이어야 합니다. 현재 값: ${String(value)}`);
  }
}

function manifestReference(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\")) {
    throw new Error(`${label} 경로가 올바르지 않습니다.`);
  }
  const normalized = normalizeEntryName(value);
  if (normalized.isDirectory) throw new Error(`${label}은 파일을 가리켜야 합니다.`);
  return normalized.name;
}

function requireArchiveFile(fileNames, rootName, reference, label) {
  const relative = manifestReference(reference, label);
  const archiveName = `${rootName}/${relative}`;
  if (!fileNames.has(archiveName)) {
    throw new Error(`${label} 참조 파일이 archive에 없습니다: ${relative}`);
  }
  return relative;
}

function requireManifestImage(fileNames, rootName, reference, label) {
  const relative = manifestReference(reference, label);
  const extension = path.posix.extname(relative).toLocaleLowerCase("en-US");
  if (extension !== "" && extension !== ".png" && extension !== ".svg") {
    throw new Error(`${label} 이미지는 .png/.svg 또는 확장자 없는 base 경로여야 합니다: ${relative}`);
  }
  const candidates = extension === "" ? [`${relative}.png`, `${relative}.svg`] : [relative];
  const imagePath = candidates.find((candidate) => fileNames.has(`${rootName}/${candidate}`));
  if (!imagePath) {
    throw new Error(`${label} 참조 이미지가 archive에 없습니다: ${candidates.join(" 또는 ")}`);
  }
  return imagePath;
}

function verifyManifestAssets(manifest, entries, rootName) {
  requireExact(manifest.CodePath, "bin/plugin.js", "manifest CodePath");
  const fileNames = new Set(
    entries.filter((entry) => !entry.isDirectory).map((entry) => entry.name),
  );
  for (const directory of ["bin", "ui", "imgs", "node_modules"]) {
    if (![...fileNames].some((name) => name.startsWith(`${rootName}/${directory}/`))) {
      throw new Error(`archive 필수 디렉터리가 비어 있습니다: ${directory}`);
    }
  }
  requireArchiveFile(fileNames, rootName, manifest.CodePath, "CodePath");
  requireManifestImage(fileNames, rootName, manifest.Icon, "Icon");
  requireManifestImage(fileNames, rootName, manifest.CategoryIcon, "CategoryIcon");
  for (const action of manifest.Actions) {
    const actionLabel = `Action ${String(action?.UUID ?? "unknown")}`;
    requireArchiveFile(
      fileNames,
      rootName,
      action?.PropertyInspectorPath,
      `${actionLabel} PropertyInspectorPath`,
    );
    if (path.posix.extname(action.PropertyInspectorPath).toLocaleLowerCase("en-US") !== ".html") {
      throw new Error(`${actionLabel} PropertyInspectorPath는 .html 파일이어야 합니다.`);
    }
    requireManifestImage(fileNames, rootName, action?.Icon, `${actionLabel} Icon`);
    if (!Array.isArray(action?.States) || action.States.length === 0) {
      throw new Error(`${actionLabel} States가 비어 있습니다.`);
    }
    action.States.forEach((state, index) => {
      requireManifestImage(
        fileNames,
        rootName,
        state?.Image,
        `${actionLabel} States[${index}].Image`,
      );
    });
  }
}

export async function verifyPluginPackage({
  archivePath,
  maxArchiveBytes = DEFAULT_MAX_ARCHIVE_BYTES,
  maxInstalledBytes = DEFAULT_MAX_INSTALLED_BYTES,
}) {
  if (!archivePath) throw new Error("검증할 .streamDeckPlugin 경로가 필요합니다.");
  const archiveInfo = await stat(archivePath);
  if (!archiveInfo.isFile() || archiveInfo.size === 0) {
    throw new Error("패키지 archive가 비어 있거나 일반 파일이 아닙니다.");
  }
  if (archiveInfo.size > maxArchiveBytes) {
    throw new Error(`패키지 archive 크기 ${archiveInfo.size} bytes가 제한 ${maxArchiveBytes} bytes를 초과합니다.`);
  }

  const archive = await readFile(archivePath);
  const { entries, centralOffset } = parseCentralDirectory(archive);
  const roots = new Set(entries.map((entry) => entry.name.split("/")[0]));
  if (roots.size !== 1) throw new Error("archive에는 단 하나의 루트 플러그인 폴더만 있어야 합니다.");
  const rootName = [...roots][0];
  if (!rootName.endsWith(".sdPlugin")) {
    throw new Error(`archive 루트가 .sdPlugin 폴더가 아닙니다: ${rootName}`);
  }

  const installedBytes = entries.reduce((total, entry) => total + entry.uncompressedSize, 0);
  if (!Number.isSafeInteger(installedBytes) || installedBytes > maxInstalledBytes) {
    throw new Error(`패키지 설치 크기 ${installedBytes} bytes가 제한 ${maxInstalledBytes} bytes를 초과합니다.`);
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "kis-plugin-smoke-"));
  try {
    for (const entry of entries) {
      const relative = entry.name.slice(rootName.length).replace(/^\//, "");
      const target = path.resolve(tempRoot, rootName, ...relative.split("/").filter(Boolean));
      const allowedRoot = path.join(tempRoot, rootName);
      if (target !== allowedRoot && !target.startsWith(`${allowedRoot}${path.sep}`)) {
        throw new Error(`추출 경로가 임시 루트를 벗어났습니다: ${entry.name}`);
      }
      if (entry.isDirectory) {
        extractEntry(archive, entry, centralOffset, maxInstalledBytes);
        await mkdir(target, { recursive: true });
        continue;
      }
      const data = extractEntry(archive, entry, centralOffset, maxInstalledBytes);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, data, { flag: "wx" });
    }

    const extractedRoot = path.join(tempRoot, rootName);
    const requiredPaths = [
      "manifest.json",
      "package.json",
      "package-lock.json",
      "bin/plugin.js",
      "bin/plugin.js.map",
    ];
    for (const required of requiredPaths) {
      const info = await stat(path.join(extractedRoot, required)).catch(() => null);
      if (!info?.isFile()) throw new Error(`archive 필수 파일이 없습니다: ${required}`);
    }
    for (const requiredDirectory of ["ui", "imgs", "node_modules"]) {
      const info = await stat(path.join(extractedRoot, requiredDirectory)).catch(() => null);
      if (!info?.isDirectory()) {
        throw new Error(`archive 필수 디렉터리가 없습니다: ${requiredDirectory}`);
      }
    }

    const [manifest, packageJson] = await Promise.all([
      readJson(path.join(extractedRoot, "manifest.json"), "manifest.json"),
      readJson(path.join(extractedRoot, "package.json"), "package.json"),
    ]);
    requireExact(manifest.UUID, rootName.slice(0, -".sdPlugin".length), "manifest UUID");
    requireExact(manifest.SDKVersion, 2, "manifest SDKVersion");
    requireExact(manifest.Nodejs?.Version, "24", "manifest Nodejs.Version");
    requireExact(manifest.Software?.MinimumVersion, "7.1", "manifest Software.MinimumVersion");
    const actionUuids = Array.isArray(manifest.Actions)
      ? manifest.Actions.map((action) => action?.UUID).sort()
      : [];
    if (JSON.stringify(actionUuids) !== JSON.stringify([...REQUIRED_ACTION_UUIDS].sort())) {
      throw new Error(`manifest action UUID가 기존 계약과 다릅니다: ${actionUuids.join(", ")}`);
    }
    verifyManifestAssets(manifest, entries, rootName);
    requireExact(
      packageJson.dependencies?.["@elgato/streamdeck"],
      "2.1.0",
      "@elgato/streamdeck dependency",
    );
    requireExact(packageJson.dependencies?.ws, "8.21.0", "ws dependency");

    const pluginPath = path.join(extractedRoot, "bin", "plugin.js");
    const pluginSource = await readFile(pluginPath, "utf8");
    for (const external of ["@elgato/streamdeck", "ws"]) {
      const escaped = external.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!new RegExp(`(?:from\\s+|import\\s*)["']${escaped}["']`).test(pluginSource)) {
        throw new Error(`archive plugin.js에 필수 external import가 없습니다: ${external}`);
      }
    }
    await nodeSyntaxCheck(pluginPath);

    const runtimeRequire = createRequire(path.join(extractedRoot, "package.json"));
    const modulesRoot = await realpath(path.join(extractedRoot, "node_modules"));
    for (const moduleName of REQUIRED_MODULES) {
      let resolved;
      try {
        resolved = runtimeRequire.resolve(moduleName);
      } catch (cause) {
        throw new Error(`archive에서 런타임 모듈을 resolve하지 못했습니다: ${moduleName}`, { cause });
      }
      const canonicalResolved = await realpath(resolved);
      if (!canonicalResolved.startsWith(`${modulesRoot}${path.sep}`)) {
        throw new Error(`런타임 모듈이 archive 밖에서 resolve됐습니다: ${moduleName}`);
      }
    }
    const streamDeckPackage = await readJson(
      path.join(extractedRoot, "node_modules", "@elgato", "streamdeck", "package.json"),
      "설치된 @elgato/streamdeck package.json",
    );
    const wsPackage = await readJson(
      path.join(extractedRoot, "node_modules", "ws", "package.json"),
      "설치된 ws package.json",
    );
    requireExact(streamDeckPackage.version, "2.1.0", "설치된 @elgato/streamdeck version");
    requireExact(wsPackage.version, "8.21.0", "설치된 ws version");

    return { archiveBytes: archiveInfo.size, installedBytes, rootName };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function numericOption(name, fallback) {
  const prefix = `--${name}=`;
  const raw = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} 값이 올바르지 않습니다.`);
  return value;
}

async function findDefaultArchive() {
  const manifest = await readJson(path.join(projectRoot, "manifest.json"), "manifest.json");
  return path.join(projectRoot, "dist", `${manifest.UUID}-v${manifest.Version}.streamDeckPlugin`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const archiveArgument = process.argv.slice(2).find((argument) => !argument.startsWith("--"));
  const archivePath = archiveArgument ? path.resolve(archiveArgument) : await findDefaultArchive();
  const result = await verifyPluginPackage({
    archivePath,
    maxArchiveBytes: numericOption("max-archive-bytes", DEFAULT_MAX_ARCHIVE_BYTES),
    maxInstalledBytes: numericOption("max-installed-bytes", DEFAULT_MAX_INSTALLED_BYTES),
  });
  console.log(
    `패키지 smoke 검증 완료: ${archivePath} (archive ${result.archiveBytes} bytes, installed ${result.installedBytes} bytes)`,
  );
}
