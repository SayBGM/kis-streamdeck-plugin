import { readFile, writeFile } from "node:fs/promises";

const PACKAGE_JSON_PATH = new URL("../package.json", import.meta.url);
const MANIFEST_JSON_PATH = new URL("../manifest.json", import.meta.url);
const MANIFEST_VERSION_REGEX = /"Version"\s*:\s*"[^"]+"/;

const packageJsonRaw = await readFile(PACKAGE_JSON_PATH, "utf8");
const manifestJsonRaw = await readFile(MANIFEST_JSON_PATH, "utf8");
const packageJson = JSON.parse(packageJsonRaw);

if (!packageJson.version) {
  throw new Error("package.json version 필드가 비어 있습니다.");
}

if (!MANIFEST_VERSION_REGEX.test(manifestJsonRaw)) {
  throw new Error("manifest.json에서 Version 필드를 찾지 못했습니다.");
}

const updatedManifestJson = manifestJsonRaw.replace(
  MANIFEST_VERSION_REGEX,
  `"Version": "${packageJson.version}"`
);

await writeFile(MANIFEST_JSON_PATH, updatedManifestJson, "utf8");

console.log(`manifest.json Version 동기화 완료: ${packageJson.version}`);
