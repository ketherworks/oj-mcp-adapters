import { access, readFile, stat } from "node:fs/promises";

const packageRoot = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("package.json", packageRoot), "utf8"));
const binPaths = Object.values(manifest.bin ?? {});
const requiredPaths = [manifest.main, manifest.types, ...binPaths, "LICENSE"];

if (requiredPaths.some((path) => typeof path !== "string" || path.length === 0)) {
  throw new Error("Package main, types, bin, and LICENSE paths must be declared.");
}
await Promise.all(requiredPaths.map((path) => access(new URL(path, packageRoot))));

for (const binPath of binPaths) {
  const source = await readFile(new URL(binPath, packageRoot), "utf8");
  if (!source.startsWith("#!/usr/bin/env node\n")) {
    throw new Error(`Package bin ${binPath} is missing its Node shebang.`);
  }
  if (process.platform !== "win32" && ((await stat(new URL(binPath, packageRoot))).mode & 0o111) === 0) {
    throw new Error(`Package bin ${binPath} is not executable.`);
  }
}
