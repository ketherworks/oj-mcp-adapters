import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmod, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(packageDir, "dist");
const buildInfoFile = join(packageDir, "..", "..", "node_modules", ".cache", "codeforces-mcp", "tsconfig.tsbuildinfo");
if (dirname(distDir) !== packageDir) throw new Error("refusing to clean outside the Codeforces package");

await Promise.all([rm(distDir, { recursive: true, force: true }), rm(buildInfoFile, { force: true })]);

const require = createRequire(import.meta.url);
const tsc = require.resolve("typescript/bin/tsc");
const result = spawnSync(process.execPath, [tsc, "-b"], { cwd: packageDir, stdio: "inherit" });
if (result.status !== 0) throw new Error(`TypeScript build failed with status ${result.status}`);

await chmod(join(distDir, "index.js"), 0o755);
