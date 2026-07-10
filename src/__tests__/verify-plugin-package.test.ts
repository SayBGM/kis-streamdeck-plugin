import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve(process.cwd(), "scripts/verify-plugin-package.mjs");
const tempRoots: string[] = [];

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: Record<string, string>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name, "utf8");
    const data = Buffer.from(content, "utf8");
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    localParts.push(local, nameBuffer, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function validEntries(): Record<string, string> {
  const root = "com.kis.streamdeck.sdPlugin";
  const manifest = {
    UUID: "com.kis.streamdeck",
    SDKVersion: 2,
    Nodejs: { Version: "24" },
    Software: { MinimumVersion: "7.1" },
    Actions: [
      { UUID: "com.kis.streamdeck.domestic-stock" },
      { UUID: "com.kis.streamdeck.overseas-stock" },
    ],
  };
  const packageJson = {
    type: "module",
    dependencies: {
      "@elgato/streamdeck": "2.1.0",
      ws: "8.21.0",
    },
  };
  const entries: Record<string, string> = {
    [`${root}/manifest.json`]: JSON.stringify(manifest),
    [`${root}/package.json`]: JSON.stringify(packageJson),
    [`${root}/package-lock.json`]: "{}",
    [`${root}/bin/plugin.js`]: [
      'import streamDeck from "@elgato/streamdeck";',
      'import WebSocket from "ws";',
      "void streamDeck; void WebSocket;",
    ].join("\n"),
    [`${root}/bin/plugin.js.map`]: "{}",
    [`${root}/ui/domestic-stock-pi.html`]: "<!doctype html>",
    [`${root}/imgs/plugin-icon.png`]: "png",
  };
  for (const [moduleName, version] of [
    ["@elgato/streamdeck", "2.1.0"],
    ["@elgato/utils", "0.4.5"],
    ["@elgato/schemas", "0.4.15"],
    ["zod", "3.25.76"],
    ["ws", "8.21.0"],
  ]) {
    const moduleRoot = `${root}/node_modules/${moduleName}`;
    entries[`${moduleRoot}/package.json`] = JSON.stringify({
      name: moduleName,
      version,
      main: "index.js",
    });
    entries[`${moduleRoot}/index.js`] = "export {};";
  }
  return entries;
}

async function archive(entries = validEntries()): Promise<string> {
  const root = path.join(os.tmpdir(), `kis-package-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  tempRoots.push(root);
  const archivePath = path.join(root, "plugin.streamDeckPlugin");
  await writeFile(archivePath, zip(entries));
  return archivePath;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("verify-plugin-package", () => {
  it("extracts and verifies a complete runtime archive", async () => {
    const archivePath = await archive();

    const result = await execFileAsync(process.execPath, [scriptPath, archivePath]);

    expect(result.stdout).toContain("패키지 smoke 검증 완료");
  });

  it("rejects an archive missing a transitive runtime module", async () => {
    const entries = validEntries();
    for (const entry of Object.keys(entries)) {
      if (entry.includes("/node_modules/zod/")) delete entries[entry];
    }
    const archivePath = await archive(entries);

    const error = await execFileAsync(process.execPath, [scriptPath, archivePath])
      .catch((caught: unknown) => caught as { code: number; stderr: string });

    expect(error).toMatchObject({ code: 1 });
    expect(error.stderr).toContain("zod");
  });

  it("rejects path traversal before extracting any entry", async () => {
    const entries = validEntries();
    entries["../escape.txt"] = "escape";
    const archivePath = await archive(entries);

    const error = await execFileAsync(process.execPath, [scriptPath, archivePath])
      .catch((caught: unknown) => caught as { code: number; stderr: string });

    expect(error).toMatchObject({ code: 1 });
    expect(error.stderr).toMatch(/경로|path traversal/i);
  });

  it("rejects an archive with the wrong exact SDK dependency version", async () => {
    const entries = validEntries();
    const packagePath = "com.kis.streamdeck.sdPlugin/package.json";
    const packageJson = JSON.parse(entries[packagePath]);
    packageJson.dependencies["@elgato/streamdeck"] = "^2.1.0";
    entries[packagePath] = JSON.stringify(packageJson);
    const archivePath = await archive(entries);

    const error = await execFileAsync(process.execPath, [scriptPath, archivePath])
      .catch((caught: unknown) => caught as { code: number; stderr: string });

    expect(error).toMatchObject({ code: 1 });
    expect(error.stderr).toContain("2.1.0");
  });

  it("rejects an archive that exceeds the configured size ceiling", async () => {
    const archivePath = await archive();

    const error = await execFileAsync(process.execPath, [
      scriptPath,
      archivePath,
      "--max-archive-bytes=100",
    ]).catch((caught: unknown) => caught as { code: number; stderr: string });

    expect(error).toMatchObject({ code: 1 });
    expect(error.stderr).toMatch(/크기|size/i);
  });
});
