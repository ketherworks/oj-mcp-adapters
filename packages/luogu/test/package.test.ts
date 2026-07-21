import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

describe("Luogu package deployment metadata", () => {
  test("points Wrangler at the compiled Worker artifact shipped by npm", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      files: string[];
      scripts: Record<string, string>;
    };
    const wrangler = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8")) as {
      main: string;
    };
    const tsconfig = JSON.parse(await readFile(new URL("../tsconfig.json", import.meta.url), "utf8")) as {
      compilerOptions: { tsBuildInfoFile: string };
    };

    expect(wrangler.main).toBe("dist/worker.js");
    expect(packageJson.files).toContain("dist/index.js");
    expect(packageJson.files).toContain("wrangler.jsonc");
    expect(packageJson.scripts.build).toBe(
      "tsc -b && node ../../scripts/bundle-platform.mjs luogu && node scripts/ensure-cli-mode.mjs"
    );
    expect(packageJson.scripts.clean).toBe("node scripts/clean.mjs");
    expect(packageJson.scripts.prepack).toBe("npm run clean && npm run build");
    expect(packageJson.scripts.prepublishOnly).toBe("node scripts/check-publish-platform.mjs");
    expect(packageJson.scripts.pretest).toBe("npm run build");
    expect(tsconfig.compilerOptions.tsBuildInfoFile).not.toContain("dist/");
  });

  test("inspects the compiled CLI and Worker artifacts produced before tests", async () => {
    const cli = await readFile(new URL("../dist/index.js", import.meta.url), "utf8");
    const worker = await readFile(new URL("../dist/worker.js", import.meta.url), "utf8");
    const workerModule = (await import(`${new URL("../dist/worker.js", import.meta.url).href}?test=${Date.now()}`)) as {
      default: { fetch?: unknown };
    };

    expect(cli.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(cli).toContain("StdioServerTransport");
    expect(worker).toContain("WebStandardStreamableHTTPServerTransport");
    expect(workerModule.default.fetch).toBeTypeOf("function");
  });

  test("ships the CLI entrypoint as POSIX 0755 in npm pack metadata", async () => {
    const npmCli = process.env.npm_execpath;
    if (!npmCli) throw new Error("npm_execpath is required to inspect npm pack metadata.");
    const { stdout } = await execFileAsync(process.execPath, [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: new URL("..", import.meta.url)
    });
    const packs = JSON.parse(stdout) as Array<{ files: Array<{ path: string; mode: number }> }>;
    const cli = packs[0]?.files.find((file) => file.path === "dist/index.js");

    expect(cli).toBeDefined();
    if (process.platform !== "win32") {
      expect((await stat(new URL("../dist/index.js", import.meta.url))).mode & 0o777).toBe(0o755);
      expect(cli?.mode).toBe(0o755);
    }
  });

  test("rejects Windows publishing and allows Linux CI publishing", () => {
    const windows = runPublishPlatformCheck("win32");
    expect(windows.status).toBe(1);
    expect(windows.stderr).toContain("npm publish is not supported on Windows");

    const linux = runPublishPlatformCheck("linux");
    expect(linux.status, linux.stderr).toBe(0);
  });

  test("documents audited provenance without a workstation-specific absolute path", async () => {
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

    expect(readme).toContain("https://github.com/Kaiserunix/luogu-mcp-server");
    expect(readme).toContain("9d3f5bc47647620ea2f8566e2be65bdf5cc2ca3b");
    expect(readme).not.toMatch(/[A-Za-z]:\\Users\\/);
  });

  test("documents the sessionless Worker cancellation boundary", async () => {
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

    expect(readme).toContain("same HTTP request");
    expect(readme).toContain("notifications/cancelled");
    expect(readme).toContain("cross-client ID collisions");
    expect(readme).toMatch(/bounded timeout and admission\s+controls remain active/);
    expect(readme).toContain("https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation");
  });

  test("ships without unpublished workspace runtime dependencies", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const cli = await readFile(new URL("../dist/index.js", import.meta.url), "utf8");
    const worker = await readFile(new URL("../dist/worker.js", import.meta.url), "utf8");

    expect(Object.keys(manifest.dependencies).filter((name) => name.startsWith("@kaiserunix/oj-mcp-"))).toEqual([]);
    expect(cli).not.toContain("@kaiserunix/oj-mcp-");
    expect(worker).not.toContain("@kaiserunix/oj-mcp-");
  });

  test("publishes only supported bundled entrypoints", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      files: string[];
    };

    expect(manifest.files).toEqual([
      "dist/index.js",
      "dist/index.js.map",
      "dist/index.d.ts",
      "dist/index.d.ts.map",
      "dist/worker.js",
      "dist/worker.js.map",
      "dist/worker.d.ts",
      "dist/worker.d.ts.map",
      "wrangler.jsonc",
      "README.md",
      "README.zh-CN.md",
      "LICENSE",
      "THIRD_PARTY_NOTICES.md"
    ]);
  });
});

function runPublishPlatformCheck(platform: string) {
  const scriptUrl = new URL("../scripts/check-publish-platform.mjs", import.meta.url).href;
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { assertPublishPlatform } from ${JSON.stringify(scriptUrl)}; assertPublishPlatform(${JSON.stringify(platform)});`
    ],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" }
  );
}
