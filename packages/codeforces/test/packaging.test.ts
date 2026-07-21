import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));

describe("Codeforces package lifecycle", () => {
  test("requires Node 22 and builds cleanly before packing and deployment", async () => {
    const packageJson = await readJson("package.json");
    const scripts = packageJson.scripts as Record<string, string>;

    expect(packageJson.engines).toEqual({ node: ">=22" });
    expect(scripts.build).toBe("node scripts/build.mjs");
    expect(scripts.prepack).toBe("npm run build");
    expect(scripts.prepublishOnly).toBe("node scripts/check-publish-platform.mjs");
    expect(scripts["test:pack"]).toBe("node scripts/pack-smoke.mjs");
    expect(scripts["deploy:cf"]).toBe("npm run build && wrangler deploy");
    expect(scripts["deploy:cf:dry-run"]).toBe("npm run build && wrangler deploy --dry-run");
  });

  test("keeps build metadata outside dist and ships the compiled Worker", async () => {
    const config = await readJson("tsconfig.json");
    const wrangler = await readJson("wrangler.jsonc");
    expect((config.compilerOptions as Record<string, unknown>).tsBuildInfoFile).toBe(
      "../../node_modules/.cache/codeforces-mcp/tsconfig.tsbuildinfo"
    );
    expect(wrangler.main).toBe("dist/worker.js");
  });

  test("makes the CLI executable and has pack smoke verify its POSIX mode", async () => {
    const buildScript = await readFile(new URL("../scripts/build.mjs", import.meta.url), "utf8");
    const packSmoke = await readFile(new URL("../scripts/pack-smoke.mjs", import.meta.url), "utf8");

    expect(buildScript).toContain('chmod(join(distDir, "index.js"), 0o755)');
    expect(packSmoke).toContain("assertExecutableMode");
  });

  test("rejects Windows publishing and allows non-Windows publishing", () => {
    const windows = runPublishPlatformCheck("win32");
    expect(windows.status).toBe(1);
    expect(windows.stderr).toContain("npm publish is not supported on Windows");

    const linux = runPublishPlatformCheck("linux");
    expect(linux.status, linux.stderr).toBe(0);
  });

  test("includes package documentation and license", async () => {
    await expect(access(new URL("../README.md", import.meta.url))).resolves.toBeUndefined();
    await expect(access(new URL("../README.zh-CN.md", import.meta.url))).resolves.toBeUndefined();
    await expect(access(new URL("../LICENSE", import.meta.url))).resolves.toBeUndefined();
  });

  test("ships without unpublished workspace runtime dependencies", async () => {
    const packageJson = await readJson("package.json");
    const dependencies = packageJson.dependencies as Record<string, string>;
    const cli = await readFile(new URL("../dist/index.js", import.meta.url), "utf8");
    const worker = await readFile(new URL("../dist/worker.js", import.meta.url), "utf8");

    expect(Object.keys(dependencies).filter((name) => name.startsWith("@kaiserunix/oj-mcp-"))).toEqual([]);
    expect(cli).not.toContain("@kaiserunix/oj-mcp-");
    expect(worker).not.toContain("@kaiserunix/oj-mcp-");
  });

  test("publishes only supported bundled entrypoints", async () => {
    const packageJson = await readJson("package.json");
    expect(packageJson.files).toEqual([
      "dist/index.js",
      "dist/index.js.map",
      "dist/index.d.ts",
      "dist/index.d.ts.map",
      "dist/worker.js",
      "dist/worker.js.map",
      "dist/worker.d.ts",
      "dist/worker.d.ts.map",
      "dist/coordinator.d.ts",
      "dist/coordinator.d.ts.map",
      "wrangler.jsonc",
      "README.md",
      "README.zh-CN.md",
      "LICENSE"
    ]);
  });

  test("smokes the packed CLI and Worker entrypoints", () => {
    const result = spawnSync(process.execPath, ["scripts/pack-smoke.mjs"], {
      cwd: packageDir,
      encoding: "utf8",
      timeout: 120_000
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("pack smoke passed");
  }, 125_000);
});

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8")) as Record<string, unknown>;
}

function runPublishPlatformCheck(platform: string) {
  const scriptUrl = new URL("../scripts/check-publish-platform.mjs", import.meta.url).href;
  return spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", `import { assertPublishPlatform } from ${JSON.stringify(scriptUrl)}; assertPublishPlatform(${JSON.stringify(platform)});`],
    { cwd: packageDir, encoding: "utf8" }
  );
}
