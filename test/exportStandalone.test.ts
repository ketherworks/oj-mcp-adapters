import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { exportStandalone } from "../scripts/export-standalone.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("standalone MCP source export", () => {
  test("exports one self-contained provider workspace with release metadata", async () => {
    const parentDir = await mkdtemp(join(tmpdir(), "atcoder-mcp-export-"));
    const outputDir = join(parentDir, "standalone");
    temporaryDirectories.push(parentDir);
    const sourceCommit = currentCommit();

    await exportStandalone({
      platform: "atcoder",
      outputDir,
      sourceCommit
    });

    expect((await readdir(join(outputDir, "packages"))).sort()).toEqual(["atcoder", "contracts", "server-common"]);
    expect(await readdir(join(outputDir, "packages", "atcoder"))).not.toContain("dist");

    const rootManifest = JSON.parse(await readFile(join(outputDir, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
      workspaces: string[];
      version: string;
    };
    expect(rootManifest.workspaces).toEqual(["packages/*"]);
    expect(rootManifest.scripts.check).toBe("npm run clean && npm run build && npm test");
    expect(rootManifest.scripts["pack:check"]).toContain("@ketherworks/atcoder-mcp-server");

    const packageManifest = JSON.parse(
      await readFile(join(outputDir, "packages", "atcoder", "package.json"), "utf8")
    ) as Record<string, unknown>;
    expect(packageManifest).toMatchObject({
      name: "@ketherworks/atcoder-mcp-server",
      mcpName: "io.github.ketherworks/atcoder",
      repository: { type: "git", url: "git+https://github.com/ketherworks/atcoder-mcp-server.git" }
    });
    expect(rootManifest.version).toBe(packageManifest.version);

    const provenance = await readFile(join(outputDir, "PROVENANCE.md"), "utf8");
    expect(provenance).toContain(sourceCommit);
    expect(provenance).toContain("packages/atcoder");
    const packagedReadme = await readFile(join(outputDir, "packages", "atcoder", "README.md"), "utf8");
    expect(packagedReadme).toContain("Tagged GitHub releases attach a standalone npm tarball");
    expect(packagedReadme).toContain("## Security Bounds");
    expect(await readFile(join(outputDir, ".gitignore"), "utf8")).toContain("release/");
    const lockfile = JSON.parse(await readFile(join(outputDir, "package-lock.json"), "utf8")) as {
      lockfileVersion: number;
    };
    expect(lockfile.lockfileVersion).toBeGreaterThanOrEqual(3);
    const ciWorkflow = await readFile(join(outputDir, ".github", "workflows", "ci.yml"), "utf8");
    expect(ciWorkflow).toContain("npm run check");
    expect(ciWorkflow).toMatch(/uses: actions\/checkout@[a-f0-9]{40} # v7/);
    expect(ciWorkflow).toMatch(/uses: actions\/setup-node@[a-f0-9]{40} # v7/);
    const releaseWorkflow = await readFile(join(outputDir, ".github", "workflows", "release.yml"), "utf8");
    expect(releaseWorkflow).toContain("npm run release:pack");
    expect(releaseWorkflow).toContain("npm run release:verify-tag");
    expect(releaseWorkflow).toContain("gh release create");
    expect(await readFile(join(outputDir, "scripts", "verify-release-tag.mjs"), "utf8")).toContain(
      "GITHUB_REF_NAME"
    );
    expect(() =>
      execFileSync(process.execPath, ["scripts/verify-release-tag.mjs", "v0.1.0"], {
        cwd: outputDir,
        env: { ...process.env, GITHUB_REF_NAME: "not-the-release-tag" },
        stdio: "pipe"
      })
    ).not.toThrow();
    expect(() =>
      execFileSync(process.execPath, ["scripts/verify-release-tag.mjs", "v0.2.0"], {
        cwd: outputDir,
        stdio: "pipe"
      })
    ).toThrow();
  }, 120_000);

  test("refuses to overwrite any existing export directory", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "nowcoder-mcp-export-"));
    temporaryDirectories.push(outputDir);

    await expect(
      exportStandalone({
        platform: "nowcoder",
        outputDir,
        sourceCommit: currentCommit()
      })
    ).rejects.toThrow("must not already exist");
  });

  test("exports the NowCoder session boundary and Chinese README", async () => {
    const parentDir = await mkdtemp(join(tmpdir(), "nowcoder-mcp-export-"));
    const outputDir = join(parentDir, "standalone");
    temporaryDirectories.push(parentDir);

    await exportStandalone({
      platform: "nowcoder",
      outputDir,
      sourceCommit: currentCommit()
    });

    const manifest = JSON.parse(await readFile(join(outputDir, "package.json"), "utf8")) as {
      version: string;
    };
    const readme = await readFile(join(outputDir, "README.md"), "utf8");
    const chineseReadme = await readFile(join(outputDir, "README.zh-CN.md"), "utf8");
    const security = await readFile(join(outputDir, "SECURITY.md"), "utf8");

    expect(manifest.version).toBe("0.2.0");
    expect(readme).toContain("[简体中文](README.zh-CN.md)");
    expect(readme).toContain("`nowcoder_auth_status`");
    expect(readme).toContain("`NOWCODER_SESSION_COOKIE`");
    expect(chineseReadme).toContain("## 本地登录态");
    expect(security).toContain("must never enter tool arguments");
    expect(security).toContain("remotely hosted transport");
  }, 120_000);

  test("rejects a syntactically valid commit that does not exist", async () => {
    const parentDir = await mkdtemp(join(tmpdir(), "invalid-commit-export-"));
    const outputDir = join(parentDir, "standalone");
    temporaryDirectories.push(parentDir);

    await expect(
      exportStandalone({ platform: "nowcoder", outputDir, sourceCommit: "0".repeat(40) })
    ).rejects.toThrow("source commit");
  });
});

function currentCommit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: new URL("..", import.meta.url), encoding: "utf8" }).trim();
}
