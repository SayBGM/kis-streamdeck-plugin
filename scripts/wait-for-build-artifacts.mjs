import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 50;
const DEFAULT_STABLE_POLLS = 3;

function delay(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function artifactSnapshot(artifactPaths) {
  const fingerprints = [];
  try {
    for (const artifactPath of artifactPaths) {
      const before = await stat(artifactPath);
      if (!before.isFile() || before.size <= 0) return null;
      const content = await readFile(artifactPath);
      const after = await stat(artifactPath);
      if (
        !after.isFile() ||
        after.size <= 0 ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        content.length !== after.size
      ) {
        return null;
      }
      fingerprints.push([
        after.size,
        after.mtimeMs,
        createHash("sha256").update(content).digest("hex"),
      ].join(":"));
    }
  } catch {
    return null;
  }
  return fingerprints.join("|");
}

export async function waitForBuildArtifacts(
  artifactPaths,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollMs = DEFAULT_POLL_MS,
    stablePolls = DEFAULT_STABLE_POLLS,
  } = {},
) {
  if (
    !Array.isArray(artifactPaths) ||
    artifactPaths.length === 0 ||
    artifactPaths.some((artifactPath) => typeof artifactPath !== "string" || artifactPath.length === 0)
  ) {
    throw new Error("대기할 빌드 산출물 경로가 필요합니다.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new Error("빌드 산출물 timeout은 1~60000ms 정수여야 합니다.");
  }
  if (!Number.isSafeInteger(pollMs) || pollMs <= 0 || pollMs > 1_000) {
    throw new Error("빌드 산출물 poll 간격은 1~1000ms 정수여야 합니다.");
  }
  if (!Number.isSafeInteger(stablePolls) || stablePolls < 2 || stablePolls > 10) {
    throw new Error("빌드 산출물 stable poll 횟수는 2~10회여야 합니다.");
  }

  const startedAt = performance.now();
  let previousSnapshot;
  let stableCount = 0;
  while (true) {
    const snapshot = await artifactSnapshot(artifactPaths);
    if (snapshot !== null) {
      if (snapshot === previousSnapshot) stableCount += 1;
      else {
        previousSnapshot = snapshot;
        stableCount = 1;
      }
      if (stableCount >= stablePolls) return;
    } else {
      previousSnapshot = undefined;
      stableCount = 0;
    }

    const elapsed = performance.now() - startedAt;
    const remaining = timeoutMs - elapsed;
    if (remaining <= 0) {
      const names = artifactPaths.map((artifactPath) => path.basename(artifactPath)).join(", ");
      throw new Error(`빌드 산출물이 제한 시간 안에 안정적으로 준비되지 않았습니다: ${names}`);
    }
    await delay(Math.min(pollMs, remaining));
  }
}

function numericOption(name, fallback) {
  const prefix = `--${name}=`;
  const raw = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} 값이 정수가 아닙니다.`);
  return value;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const artifactPaths = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
  await waitForBuildArtifacts(artifactPaths.map((artifactPath) => path.resolve(artifactPath)), {
    timeoutMs: numericOption("timeout-ms", DEFAULT_TIMEOUT_MS),
    pollMs: numericOption("poll-ms", DEFAULT_POLL_MS),
    stablePolls: numericOption("stable-polls", DEFAULT_STABLE_POLLS),
  });
  console.log(`빌드 산출물 준비 완료: ${artifactPaths.map((artifactPath) => path.basename(artifactPath)).join(", ")}`);
}
