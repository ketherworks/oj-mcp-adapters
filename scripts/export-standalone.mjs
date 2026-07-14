import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceRepository = "https://github.com/ketherworks/oj-mcp-adapters";
const excludedNames = new Set(["dist", "node_modules", ".wrangler", "coverage"]);
const execFileAsync = promisify(execFile);
const checkoutAction = "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5";
const setupNodeAction = "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020";
const platforms = {
  atcoder: {
    displayName: "AtCoder Read-Only MCP Server",
    repositoryName: "atcoder-mcp-server",
    packageName: "@ketherworks/atcoder-mcp-server",
    mcpName: "io.github.ketherworks/atcoder",
    binaryName: "atcoder-mcp-server",
    description: "Audited read-only MCP server for exact AtCoder problem statements and samples.",
    remoteUrl: "https://api.ksrnyx.top/oj-mcp/atcoder/mcp",
    tools: ["oj_capabilities", "oj_health", "oj_fetch_problem", "oj_search_problems"],
    worker: true,
    policy: `Do not use this server during ongoing ABC, ARC, or AGC contests. AtCoder's current
[generative-AI rules](https://info.atcoder.jp/entry/llm-rules-en) generally prohibit that use.
This project is intended for practice with past problems. It is unofficial and is not affiliated
with or endorsed by AtCoder Inc. Problem content remains subject to the
[AtCoder Terms of Use](https://atcoder.jp/tos?lang=en).`
  },
  codeforces: {
    displayName: "Codeforces Read-Only MCP Server",
    repositoryName: "codeforces-mcp-server",
    packageName: "@ketherworks/codeforces-mcp-server",
    mcpName: "io.github.ketherworks/codeforces",
    binaryName: "codeforces-mcp-server",
    description: "Bounded read-only MCP server for official Codeforces problem metadata.",
    remoteUrl: "https://codeforces-oj-mcp.lantangtang54.workers.dev/mcp",
    tools: ["oj_capabilities", "oj_health", "oj_search_problems", "codeforces_get_problem_metadata"],
    worker: true,
    policy: "This project is unofficial and is not affiliated with or endorsed by Codeforces."
  },
  luogu: {
    displayName: "Luogu OJ MCP Adapter",
    repositoryName: "luogu-oj-mcp",
    packageName: "@ketherworks/luogu-oj-mcp",
    mcpName: "io.github.ketherworks/luogu-oj-mcp",
    binaryName: "luogu-mcp-server",
    description: "Strict read-only Luogu adapter for the federated OJ MCP contract.",
    remoteUrl: "https://api.ksrnyx.top/oj-mcp/luogu/mcp",
    tools: ["oj_capabilities", "oj_health", "oj_search_problems", "oj_fetch_problem"],
    worker: true,
    policy: "This project is unofficial and is not affiliated with or endorsed by Luogu."
  },
  nowcoder: {
    displayName: "NowCoder ACM Problem MCP Server",
    repositoryName: "nowcoder-oj-mcp",
    packageName: "@ketherworks/nowcoder-oj-mcp",
    mcpName: "io.github.ketherworks/nowcoder-oj-mcp",
    binaryName: "nowcoder-mcp-server",
    description: "Hardened local MCP server for public NowCoder ACM problem pages.",
    tools: ["oj_capabilities", "oj_health", "oj_fetch_problem"],
    worker: false,
    policy: `This project is unofficial and is not affiliated with or endorsed by NowCoder.
It never bypasses anti-bot challenges and intentionally remains local stdio only.`
  }
};

export async function exportStandalone({ platform, outputDir, sourceCommit }) {
  const config = platforms[platform];
  if (!config) throw new TypeError(`Unsupported standalone platform: ${platform}`);
  if (!/^[a-f0-9]{40}$/i.test(sourceCommit)) throw new TypeError("sourceCommit must be a full Git commit SHA.");

  const destination = await standaloneDestination(outputDir);
  const stagingDirectory = await archiveSourceCommit(sourceCommit, platform);
  const archivedSource = join(stagingDirectory, "source");
  let destinationCreated = false;

  try {
    try {
      await mkdir(destination);
      destinationCreated = true;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        throw new Error("Standalone export directory must not already exist.");
      }
      throw error;
    }

    await Promise.all([
      copy(archivedSource, "LICENSE", join(destination, "LICENSE")),
      copy(archivedSource, ".gitignore", join(destination, ".gitignore")),
      copy(archivedSource, "tsconfig.base.json", join(destination, "tsconfig.base.json")),
      copy(archivedSource, "scripts/bundle-platform.mjs", join(destination, "scripts", "bundle-platform.mjs")),
      copy(archivedSource, "packages/contracts", join(destination, "packages", "contracts")),
      copy(archivedSource, "packages/server-common", join(destination, "packages", "server-common")),
      copy(archivedSource, `packages/${platform}`, join(destination, "packages", platform))
    ]);

    const providerManifestPath = join(destination, "packages", platform, "package.json");
    const providerManifest = JSON.parse(await readFile(providerManifestPath, "utf8"));
    providerManifest.name = config.packageName;
    providerManifest.description = config.description;
    providerManifest.author = "Kether Works contributors";
    providerManifest.repository = {
      type: "git",
      url: `git+https://github.com/ketherworks/${config.repositoryName}.git`
    };
    providerManifest.homepage = `https://github.com/ketherworks/${config.repositoryName}#readme`;
    providerManifest.bugs = { url: `https://github.com/ketherworks/${config.repositoryName}/issues` };
    providerManifest.mcpName = config.mcpName;
    providerManifest.keywords = [
      platform,
      "competitive-programming",
      "mcp",
      "model-context-protocol",
      "online-judge",
      "read-only"
    ];
    await writeJson(providerManifestPath, providerManifest);
    await mkdir(join(destination, ".github", "workflows"), { recursive: true });
    const releaseReadme = readme(platform, config, sourceCommit);
    const implementationReadme = (await readFile(join(destination, "packages", platform, "README.md"), "utf8"))
      .replace(/^# .+\r?\n/, "")
      .trim();

    await Promise.all([
      writeJson(join(destination, "package.json"), rootManifest(platform, config)),
      writeJson(join(destination, "tsconfig.json"), {
        files: [],
        references: [
          { path: "./packages/contracts" },
          { path: "./packages/server-common" },
          { path: `./packages/${platform}` }
        ]
      }),
      writeFile(join(destination, "vitest.config.ts"), vitestConfig(platform), "utf8"),
      writeFile(join(destination, "README.md"), releaseReadme, "utf8"),
      writeFile(
        join(destination, "packages", platform, "README.md"),
        `${releaseReadme}\n\n## Provider Implementation Details\n\n${implementationReadme}\n`,
        "utf8"
      ),
      writeFile(join(destination, "PROVENANCE.md"), provenance(platform, sourceCommit), "utf8"),
      writeFile(join(destination, "SECURITY.md"), securityPolicy(config), "utf8"),
      writeFile(join(destination, "scripts", "verify-release-tag.mjs"), verifyReleaseTag(platform), "utf8"),
      writeFile(join(destination, ".github", "workflows", "ci.yml"), ciWorkflow(platform, config), "utf8"),
      writeFile(join(destination, ".github", "workflows", "release.yml"), releaseWorkflow(config), "utf8")
    ]);
    await runNpm(
      ["install", "--package-lock-only", "--ignore-scripts", "--include=dev", "--no-audit", "--no-fund"],
      destination
    );
  } catch (error) {
    if (destinationCreated) await rm(destination, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

async function standaloneDestination(outputDir) {
  const requested = resolve(outputDir);
  const parent = dirname(requested);
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error("Standalone export parent must be an existing, non-symlink directory.");
  }
  const [canonicalParent, canonicalRepository] = await Promise.all([realpath(parent), realpath(repositoryRoot)]);
  const destination = join(canonicalParent, basename(requested));
  const repositoryRelativePath = relative(canonicalRepository, destination);
  if (repositoryRelativePath === "" || (!repositoryRelativePath.startsWith("..") && !isAbsolute(repositoryRelativePath))) {
    throw new Error("Standalone export directory must be outside the source repository.");
  }
  return destination;
}

async function archiveSourceCommit(sourceCommit, platform) {
  try {
    await execFileAsync("git", ["-C", repositoryRoot, "cat-file", "-e", `${sourceCommit}^{commit}`]);
  } catch (error) {
    throw new Error(`The source commit ${sourceCommit} does not exist in the canonical repository.`, { cause: error });
  }

  const stagingDirectory = await mkdtemp(join(tmpdir(), "oj-mcp-standalone-source-"));
  const archivePath = join(stagingDirectory, "source.tar");
  const sourceDirectory = join(stagingDirectory, "source");
  await mkdir(sourceDirectory);
  try {
    await execFileAsync("git", [
      "-C",
      repositoryRoot,
      "archive",
      "--format=tar",
      `--output=${archivePath}`,
      sourceCommit,
      "--",
      "LICENSE",
      ".gitignore",
      "tsconfig.base.json",
      "scripts/bundle-platform.mjs",
      "packages/contracts",
      "packages/server-common",
      `packages/${platform}`
    ]);
    await execFileAsync("tar", ["-xf", archivePath, "-C", sourceDirectory]);
    return stagingDirectory;
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw new Error(`The source commit ${sourceCommit} could not be archived.`, { cause: error });
  }
}

async function copy(sourceRoot, source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await cp(join(sourceRoot, source), destination, {
    recursive: true,
    filter: (path) => !excludedNames.has(basename(path)) && !path.endsWith(".tsbuildinfo")
  });
}

function rootManifest(platform, config) {
  const packCheck =
    platform === "codeforces"
      ? `npm run test:pack --workspace ${config.packageName}`
      : platform === "nowcoder"
        ? `npm run pack:check --workspace ${config.packageName}`
        : `npm pack --dry-run --workspace ${config.packageName}`;
  return {
    name: `${platform}-mcp-server-workspace`,
    version: "0.1.0",
    private: true,
    type: "module",
    workspaces: ["packages/*"],
    scripts: {
      clean: "tsc -b --clean",
      build: "tsc -b",
      postbuild: `node scripts/bundle-platform.mjs ${platform}`,
      test: "vitest run",
      check: "npm run clean && npm run build && npm test",
      "pack:check": packCheck,
      "release:verify-tag": "node scripts/verify-release-tag.mjs",
      "release:pack": `npm pack --json --pack-destination release --workspace ${config.packageName}`,
      ...(config.worker
        ? { "deploy:dry": `npx wrangler deploy --dry-run --config packages/${platform}/wrangler.jsonc` }
        : {})
    },
    devDependencies: {
      "@types/node": "22.15.3",
      esbuild: "0.28.1",
      typescript: "5.8.3",
      vitest: "4.1.10",
      ...(config.worker ? { wrangler: "4.110.0" } : {})
    },
    engines: { node: ">=22" }
  };
}

function readme(platform, config, sourceCommit) {
  const remote = config.remoteUrl
    ? `## Hosted Endpoint

The public anonymous read-only endpoint is:

\`\`\`json
{
  "servers": {
    "${platform}": {
      "type": "http",
      "url": "${config.remoteUrl}"
    }
  }
}
\`\`\`

No end-user API key, cookie, or account credential is accepted.

`
    : "";
  return `# ${config.displayName}

${config.description}

This is a standalone release workspace generated from the audited
[Kether Works OJ adapter source](${sourceRepository}/tree/${sourceCommit}/packages/${platform}).
The release package bundles the shared OJ contract implementation, so its runtime does not depend
on unpublished workspace packages.

## Tools

${config.tools.map((tool) => `- \`${tool}\``).join("\n")}

${remote}## Local Stdio

Requires Node.js 22 or newer.

\`\`\`bash
npm ci
npm run check
npm run build
node packages/${platform}/dist/index.js
\`\`\`

MCP client configuration from a source checkout:

\`\`\`json
{
  "servers": {
    "${platform}": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/packages/${platform}/dist/index.js"]
    }
  }
}
\`\`\`

Tagged GitHub releases attach a standalone npm tarball. npm Registry and official MCP Registry
publication are intentionally separate steps and are not claimed until their ownership checks pass.

## Policy

${config.policy}

The server exposes no run or submit tool. It accepts no judge account credentials. See
[SECURITY.md](SECURITY.md) for the security boundary and [PROVENANCE.md](PROVENANCE.md) for the
canonical source revision.

## Development

\`\`\`bash
npm ci
npm run check
npm run pack:check
${config.worker ? "npm run deploy:dry\n" : ""}\`\`\`

## License

Adapter source code is MIT licensed. Judge problem content and trademarks are not relicensed by
this repository.
`;
}

function provenance(platform, sourceCommit) {
  return `# Provenance

This standalone workspace is generated from:

- Repository: ${sourceRepository}
- Commit: \`${sourceCommit}\`
- Provider source: \`packages/${platform}\`
- Shared contract source: \`packages/contracts\`
- Shared MCP result helpers: \`packages/server-common\`

The standalone repository is a release surface. Cross-platform contract changes are developed and
reviewed in the canonical monorepo, then exported with the exact source commit recorded here.
`;
}

function securityPolicy(config) {
  return `# Security Policy

Report vulnerabilities through the private GitHub Security Advisory form for
\`ketherworks/${config.repositoryName}\`. Do not include judge cookies, account tokens, source code,
or other secrets in a public issue.

This server is read-only. It must not gain submission, code-execution, credential-forwarding, or
challenge-bypass behavior without a separate threat model and explicit security review.
`;
}

function vitestConfig(platform) {
  return `import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/${platform}/test/**/*.test.ts"]
  }
});
`;
}

function verifyReleaseTag(platform) {
  return `import { readFile } from "node:fs/promises";

const manifest = JSON.parse(
  await readFile(new URL("../packages/${platform}/package.json", import.meta.url), "utf8")
);
const actualTag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
const expectedTag = \`v\${manifest.version}\`;

if (actualTag !== expectedTag) {
  console.error(\`Release tag \${actualTag ?? "<missing>"} does not match package version \${expectedTag}.\`);
  process.exit(1);
}

process.stdout.write(\`Release tag \${actualTag} matches package version.\\n\`);
`;
}

function ciWorkflow(platform, config) {
  return `name: ci

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: ${checkoutAction} # v4
      - uses: ${setupNodeAction} # v4
        with:
          node-version: 22.23.1
          cache: npm
      - run: npm ci --include=dev
      - run: npm run check
      - run: npm run pack:check
${config.worker ? "      - run: npm run deploy:dry\n" : ""}      - run: npm audit --omit=dev --audit-level=high
`;
}

function releaseWorkflow(config) {
  return `name: release

on:
  push:
    tags:
      - "v*"

permissions:
  contents: write

jobs:
  github-release:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: ${checkoutAction} # v4
      - uses: ${setupNodeAction} # v4
        with:
          node-version: 22.23.1
          cache: npm
      - run: npm ci --include=dev
      - run: npm run release:verify-tag
      - run: npm run check
      - run: mkdir release
      - run: npm run release:pack
      - name: Create GitHub release
        env:
          GH_TOKEN: \${{ github.token }}
        run: gh release create "\${GITHUB_REF_NAME}" release/*.tgz --verify-tag --generate-notes --title "${config.displayName} \${GITHUB_REF_NAME}"
`;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function runNpm(args, cwd) {
  if (process.platform !== "win32") {
    await execFileAsync("npm", args, { cwd });
    return;
  }
  await execFileAsync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `npm.cmd ${args.join(" ")}`], { cwd });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [platform, outputDir, sourceCommit] = process.argv.slice(2);
  await exportStandalone({ platform, outputDir, sourceCommit });
}
