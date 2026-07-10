import path from "node:path";
import { fileURLToPath } from "node:url";

export function packageManagerCommand(platform = process.platform) {
  return platform === "win32" ? "npm.cmd" : "npm";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(packageManagerCommand(process.argv[2] ?? process.platform));
}
