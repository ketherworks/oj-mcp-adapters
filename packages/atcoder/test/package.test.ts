import { exec } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { access, cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, test } from "vitest";

const execAsync = promisify(exec);
const require = createRequire(import.meta.url);

describe("AtCoder package deployment metadata", () => {
  test("pins the DOM and SAX parsers to the audited versions", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      dependencies: Record<string, string>;
    };

    expect(packageJson.dependencies).toMatchObject({
      parse5: "8.0.1",
      "parse5-sax-parser": "8.0.0"
    });
  });

  test("uses package-local cleanup before project-reference builds", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts).toMatchObject({
      clean: "node scripts/clean.mjs",
      build: "npm run clean && tsc -b && node ../../scripts/bundle-platform.mjs atcoder",
      postbuild: "node scripts/set-bin-mode.mjs",
      prepack: "npm run build",
      "deploy:cf": "npm run build && wrangler deploy"
    });
  });

  test("cleaning AtCoder preserves shared dependency artifacts", { timeout: 30_000 }, async () => {
    const sandbox = await createPackSandbox();
    const packageDirectory = join(sandbox, "packages", "atcoder");
    const contractsArtifact = join(sandbox, "packages", "contracts", "dist", "index.d.ts");
    const commonArtifact = join(sandbox, "packages", "server-common", "dist", "index.d.ts");
    try {
      await execAsync("npm run build", {
        cwd: packageDirectory,
        env: { ...process.env, PATH: `${join(sandbox, "tool-bin")}${delimiter}${process.env.PATH ?? ""}` }
      });
      await execAsync("npm run clean", {
        cwd: packageDirectory,
        env: { ...process.env, PATH: `${join(sandbox, "tool-bin")}${delimiter}${process.env.PATH ?? ""}` }
      });

      await expect(access(join(packageDirectory, "dist", "index.d.ts"))).rejects.toThrow();
      await expect(access(contractsArtifact)).resolves.toBeUndefined();
      await expect(access(commonArtifact)).resolves.toBeUndefined();
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test.runIf(process.platform !== "win32")(
    "clean build marks the stdio entry point executable",
    { timeout: 30_000 },
    async () => {
      const sandbox = await createPackSandbox();
      const packageDirectory = join(sandbox, "packages", "atcoder");
      try {
        await execAsync("npm run build", {
          cwd: packageDirectory,
          env: { ...process.env, PATH: `${join(sandbox, "tool-bin")}${delimiter}${process.env.PATH ?? ""}` }
        });

        expect((await stat(join(packageDirectory, "dist", "index.js"))).mode & 0o777).toBe(0o755);
      } finally {
        await rm(sandbox, { recursive: true, force: true });
      }
    }
  );

  test("production stdio entry point reports local_stdio capabilities", { timeout: 30_000 }, async () => {
    const sandbox = await createPackSandbox();
    const packageDirectory = join(sandbox, "packages", "atcoder");
    const client = new Client({ name: "atcoder-production-stdio-test", version: "0.1.0" });
    try {
      await execAsync("npm run build", {
        cwd: packageDirectory,
        env: { ...process.env, PATH: `${join(sandbox, "tool-bin")}${delimiter}${process.env.PATH ?? ""}` }
      });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(packageDirectory, "dist", "index.js")],
        cwd: packageDirectory
      });
      await client.connect(transport);

      const result = await client.callTool({ name: "oj_capabilities", arguments: {} });
      const operations = (result.structuredContent as { operations: Record<string, { transport: string }> }).operations;
      expect(Object.values(operations).every((operation) => operation.transport === "local_stdio")).toBe(true);
    } finally {
      await client.close().catch(() => {});
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test("points Wrangler at the Worker JavaScript shipped in the npm artifact", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      files: string[];
    };
    const wrangler = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8")) as {
      main: string;
      compatibility_flags?: string[];
    };

    expect(wrangler.main).toBe("dist/worker.js");
    expect(wrangler.compatibility_flags).toEqual(expect.arrayContaining(["nodejs_compat"]));
    expect(packageJson.files).toContain("dist/index.js");
    expect(packageJson.files).toContain("wrangler.jsonc");
  });

  test("ships substantive MIT license and read-only adapter documentation", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      files: string[];
      license: string;
    };
    const license = await readFile(new URL("../LICENSE", import.meta.url), "utf8");
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

    expect(packageJson.license).toBe("MIT");
    expect(packageJson.files).toEqual(expect.arrayContaining(["LICENSE", "README.md", "README.zh-CN.md"]));
    expect(license).toContain("MIT License");
    expect(readme).toContain("anonymous read-only");
    expect(readme).toContain("No authentication, code execution, or submission tools");
    expect(readme).toContain("Do not use this server during ongoing ABC, ARC, or AGC contests");
    expect(readme).toContain("https://info.atcoder.jp/entry/llm-rules-en");
    expect(readme).toContain("https://atcoder.jp/tos?lang=en");
    expect(readme).toContain("unofficial and is not affiliated with or endorsed by AtCoder Inc.");
  });

  test("ships without unpublished workspace runtime dependencies", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const cli = await readFile(new URL("../dist/index.js", import.meta.url), "utf8");
    const worker = await readFile(new URL("../dist/worker.js", import.meta.url), "utf8");

    expect(Object.keys(packageJson.dependencies).filter((name) => name.startsWith("@kaiserunix/oj-mcp-"))).toEqual([]);
    expect(cli).not.toContain("@kaiserunix/oj-mcp-");
    expect(worker).not.toContain("@kaiserunix/oj-mcp-");
  });

  test("publishes only supported bundled entrypoints", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      files: string[];
    };

    expect(packageJson.files).toEqual([
      "dist/index.js",
      "dist/index.js.map",
      "dist/index.d.ts",
      "dist/index.d.ts.map",
      "dist/worker.js",
      "dist/worker.js.map",
      "dist/worker.d.ts",
      "dist/worker.d.ts.map",
      "wrangler.jsonc",
      "LICENSE",
      "README.md",
      "README.zh-CN.md"
    ]);
  });

  test("prepacks from absent dist and excludes source and compiler internals", { timeout: 30_000 }, async () => {
    const sandbox = await createPackSandbox();
    const packageDirectory = join(sandbox, "packages", "atcoder");
    try {
      await expect(access(join(packageDirectory, "dist"))).rejects.toThrow();
      const { stdout } = await execAsync("npm pack --dry-run --json", {
        cwd: packageDirectory,
        env: { ...process.env, PATH: `${join(sandbox, "tool-bin")}${delimiter}${process.env.PATH ?? ""}` }
      }).catch((error: unknown) => {
        const failure = error as Error & { stdout?: string; stderr?: string };
        throw new Error([failure.message, failure.stdout, failure.stderr].filter(Boolean).join("\n"), { cause: error });
      });
      const packed = JSON.parse(stdout) as Array<{ files: Array<{ path: string; mode?: number }> }>;
      const paths = packed[0]!.files.map((file) => file.path);
      const stdioEntry = packed[0]!.files.find((file) => file.path === "dist/index.js");

      await expect(access(join(packageDirectory, "dist", "worker.js"))).resolves.toBeUndefined();
      expect(paths).toEqual(
        expect.arrayContaining([
          "dist/index.js",
          "dist/worker.js",
          "wrangler.jsonc",
          "LICENSE",
          "README.md",
          "README.zh-CN.md"
        ])
      );
      expect(paths.some((path) => path.endsWith(".tsbuildinfo"))).toBe(false);
      expect(paths.some((path) => path.startsWith("src/"))).toBe(false);
      if (process.platform !== "win32") expect(stdioEntry?.mode).toBe(0o755);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});

async function createPackSandbox(): Promise<string> {
  const repository = fileURLToPath(new URL("../../../", import.meta.url));
  const sandbox = await mkdtemp(join(tmpdir(), "atcoder-pack-"));
  await cp(join(repository, "tsconfig.base.json"), join(sandbox, "tsconfig.base.json"));
  await mkdir(join(sandbox, "scripts"), { recursive: true });
  await cp(join(repository, "scripts", "bundle-platform.mjs"), join(sandbox, "scripts", "bundle-platform.mjs"));
  for (const packageName of ["contracts", "server-common", "atcoder"]) {
    await cp(join(repository, "packages", packageName), join(sandbox, "packages", packageName), {
      recursive: true,
      filter: (source) => !["dist", "node_modules", ".wrangler"].includes(source.split(/[\\/]/).at(-1)!)
    });
  }

  const modules = join(sandbox, "node_modules");
  await linkPackage(packageRoot("@types/node/package.json"), join(modules, "@types", "node"));
  await linkPackage(packageRoot("zod"), join(modules, "zod"));
  await linkPackage(packageRoot("@modelcontextprotocol/sdk/types.js"), join(modules, "@modelcontextprotocol", "sdk"));
  await linkPackage(packageRoot("parse5"), join(modules, "parse5"));
  await linkPackage(packageRoot("parse5-sax-parser"), join(modules, "parse5-sax-parser"));
  await linkPackage(packageRoot("entities"), join(modules, "entities"));
  await linkPackage(packageRoot("esbuild"), join(modules, "esbuild"));
  await linkPackage(join(sandbox, "packages", "contracts"), join(modules, "@kaiserunix", "oj-mcp-contracts"));
  await linkPackage(join(sandbox, "packages", "server-common"), join(modules, "@kaiserunix", "oj-mcp-server-common"));
  await createTscLauncher(sandbox);
  return sandbox;
}

async function linkPackage(target: string, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await symlink(target, path, process.platform === "win32" ? "junction" : "dir");
}

function packageRoot(specifier: string): string {
  let current = dirname(require.resolve(specifier));
  while (true) {
    try {
      const packageJson = JSON.parse(require("node:fs").readFileSync(join(current, "package.json"), "utf8")) as {
        name?: string;
      };
      if (packageJson.name) return current;
    } catch {
      // Walk upward from the resolved entry until its package root is found.
    }
    const parent = dirname(current);
    if (parent === current) throw new Error(`Could not locate package root for ${specifier}.`);
    current = parent;
  }
}

async function createTscLauncher(sandbox: string): Promise<void> {
  const bin = join(sandbox, "tool-bin");
  const tsc = require.resolve("typescript/bin/tsc");
  await mkdir(bin, { recursive: true });
  if (process.platform === "win32") {
    await writeFile(join(bin, "tsc.cmd"), `@echo off\r\n"${process.execPath}" "${tsc}" %*\r\n`, "utf8");
  } else {
    const launcher = join(bin, "tsc");
    await writeFile(launcher, `#!/bin/sh\nexec "${process.execPath}" "${tsc}" "$@"\n`, { mode: 0o755 });
  }
}
