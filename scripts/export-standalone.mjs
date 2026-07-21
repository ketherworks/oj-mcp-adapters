import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceRepository = "https://github.com/ketherworks/competitive-programming-mcp";
const excludedNames = new Set(["dist", "node_modules", ".wrangler", "coverage"]);
const execFileAsync = promisify(execFile);
const checkoutAction = "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0";
const setupNodeAction = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const platforms = {
  atcoder: {
    displayName: "AtCoder MCP Server",
    repositoryName: "atcoder-mcp-server",
    packageName: "@ketherworks/atcoder-mcp-server",
    mcpName: "io.github.ketherworks/atcoder",
    binaryName: "atcoder-mcp-server",
    description: "Find and read past AtCoder problems through MCP, locally or over hosted HTTP.",
    descriptionZh: "通过 MCP 查找并读取 AtCoder 历史题目，可直接连接公共服务，也可以在本地运行。",
    examplePrompt: "Fetch AtCoder problem abc086_a and show its samples.",
    examplePromptZh: "获取 AtCoder abc086_a 的题面、样例和限制。",
    remoteUrl: "https://api.ksrnyx.top/oj-mcp/atcoder/mcp",
    tools: ["oj_capabilities", "oj_health", "oj_fetch_problem", "oj_search_problems"],
    toolDescriptions: {
      oj_capabilities: "Report the available AtCoder read operations and transport.",
      oj_health: "Report process readiness and the latest upstream read.",
      oj_fetch_problem: "Fetch one past problem by canonical URL or contest/task id.",
      oj_search_problems: "Resolve an exact task URL or contest/task identifier."
    },
    toolDescriptionsZh: {
      oj_capabilities: "报告当前可用的 AtCoder 读取能力和传输方式。",
      oj_health: "报告进程状态和最近一次上游读取结果。",
      oj_fetch_problem: "按规范 URL 或比赛号/题号读取一道历史题目。",
      oj_search_problems: "解析准确的题目 URL 或比赛号/题号。"
    },
    worker: true,
    localizedReadme: "README.zh-CN.md",
    policy: `Do not use this server during ongoing ABC, ARC, or AGC contests. AtCoder's current
[generative-AI rules](https://info.atcoder.jp/entry/llm-rules-en) generally prohibit that use.
This project is intended for practice with past problems. It is unofficial and is not affiliated
with or endorsed by AtCoder Inc. Problem content remains subject to the
[AtCoder Terms of Use](https://atcoder.jp/tos?lang=en).`,
    policyZh: `请勿在正在进行的 ABC、ARC 或 AGC 比赛中使用。AtCoder 当前的
[生成式 AI 规则](https://info.atcoder.jp/entry/llm-rules)通常禁止这类使用。
本项目用于历史题目练习，与 AtCoder Inc. 无隶属或背书关系；题目内容遵循
[AtCoder 使用条款](https://atcoder.jp/tos)。`
  },
  codeforces: {
    displayName: "Codeforces MCP Server",
    repositoryName: "codeforces-mcp-server",
    packageName: "@ketherworks/codeforces-mcp-server",
    mcpName: "io.github.ketherworks/codeforces",
    binaryName: "codeforces-mcp-server",
    description: "Search official Codeforces problem metadata through a small MCP server.",
    descriptionZh: "通过 MCP 搜索 Codeforces 官方公开的题目元数据，可按题名、题号、难度和标签筛选。",
    examplePrompt: "Find five beginner Codeforces problems tagged implementation.",
    examplePromptZh: "在 Codeforces 找五道适合入门、标签为 implementation 的题。",
    remoteUrl: "https://codeforces-oj-mcp.lantangtang54.workers.dev/mcp",
    tools: ["oj_capabilities", "oj_health", "oj_search_problems", "codeforces_get_problem_metadata"],
    toolDescriptions: {
      oj_capabilities: "Report the available Codeforces read operations and transport.",
      oj_health: "Report service health and the latest official API observation.",
      oj_search_problems: "Search the official problemset by title, id, rating, or tag.",
      codeforces_get_problem_metadata: "Fetch one problem's official metadata by native id."
    },
    toolDescriptionsZh: {
      oj_capabilities: "报告当前可用的 Codeforces 读取能力和传输方式。",
      oj_health: "报告服务状态和最近一次官方 API 读取结果。",
      oj_search_problems: "按题名、题号、难度或标签搜索官方题库。",
      codeforces_get_problem_metadata: "按平台题号读取一道题的官方元数据。"
    },
    worker: true,
    localizedReadme: "README.zh-CN.md",
    policy: "This project is unofficial and is not affiliated with or endorsed by Codeforces.",
    policyZh: "本项目是社区实现，与 Codeforces 无隶属或背书关系。"
  },
  luogu: {
    displayName: "Luogu MCP Server | 洛谷 MCP Server",
    repositoryName: "luogu-mcp-server",
    packageName: "@ketherworks/luogu-oj-mcp",
    mcpName: "io.github.ketherworks/luogu-oj-mcp",
    binaryName: "luogu-mcp-server",
    description: "Search and read public Luogu problems through MCP.",
    descriptionZh: "通过 MCP 搜索并读取洛谷公开题目。",
    examplePrompt: "在洛谷搜索五道适合入门的动态规划题。",
    examplePromptZh: "在洛谷搜索五道适合入门的动态规划题。",
    remoteUrl: "https://api.ksrnyx.top/oj-mcp/luogu/mcp",
    tools: ["oj_capabilities", "oj_health", "oj_search_problems", "oj_fetch_problem"],
    toolDescriptions: {
      oj_capabilities: "Report the available anonymous Luogu read operations.",
      oj_health: "Report process readiness and the latest upstream read.",
      oj_search_problems: "Search public Luogu problems with bounded pagination.",
      oj_fetch_problem: "Fetch one public problem statement and its samples."
    },
    toolDescriptionsZh: {
      oj_capabilities: "报告当前可用的洛谷匿名读取能力。",
      oj_health: "报告进程状态和最近一次上游读取结果。",
      oj_search_problems: "分页搜索洛谷公开题目。",
      oj_fetch_problem: "读取一道公开题目的题面和样例。"
    },
    worker: true,
    localizedReadme: "README.zh-CN.md",
    policy: "This project is unofficial and is not affiliated with or endorsed by Luogu.",
    policyZh: "本项目是社区实现，与洛谷无隶属或背书关系。"
  },
  nowcoder: {
    displayName: "NowCoder MCP Server | 牛客 MCP Server",
    repositoryName: "nowcoder-mcp-server",
    packageName: "@ketherworks/nowcoder-oj-mcp",
    mcpName: "io.github.ketherworks/nowcoder-mcp-server",
    binaryName: "nowcoder-mcp-server",
    description: "牛客题库搜索、导题、运行与提交的本地 MCP Server | NowCoder MCP for AI coding agents.",
    examplePrompt: "在牛客搜索数组入门题，并获取第一道题的题面和样例。",
    tools: [
      "oj_capabilities", "oj_health", "oj_search_problems", "oj_fetch_problem",
      "oj_open_import_window", "oj_complete_import", "oj_fetch_profile", "oj_list_submissions",
      "oj_platform_run", "oj_poll_run", "oj_prepare_submission", "oj_commit_submission", "oj_poll_submission",
      "nowcoder_auth_status"
    ],
    worker: false,
    acceptsSessionCookie: true,
    supportsJudgeActions: true,
    localizedReadme: "README.zh-CN.md",
    policy: `This project is unofficial and is not affiliated with or endorsed by NowCoder.
It runs locally over stdio, keeps judge credentials inside the process, and requires a fresh user
confirmation for every real submission.`
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
      ...(config.supportsJudgeActions ? ["competitive-programming-tools"] : ["read-only"])
    ];
    await writeJson(providerManifestPath, providerManifest);
    await mkdir(join(destination, ".github", "workflows"), { recursive: true });
    const sourceProviderReadme = await readFile(join(destination, "packages", platform, "README.md"), "utf8");
    const standaloneProviderReadme = platform === "nowcoder"
      ? sourceProviderReadme.replaceAll("@kaiserunix/nowcoder-mcp-server", config.packageName)
      : sourceProviderReadme;
    const releaseReadme = platform === "nowcoder"
      ? standaloneProviderReadme
      : readme(platform, config, sourceCommit);
    const packageReleaseReadme = platform === "nowcoder"
      ? releaseReadme
      : readme(platform, config, sourceCommit, "../../");
    const implementationReadme = sourceProviderReadme
      .replace(/^# .+\r?\n/, "")
      .trim();
    const sourceLocalizedReadme = platform === "nowcoder" && config.localizedReadme
      ? await readFile(join(destination, "packages", platform, config.localizedReadme), "utf8")
      : undefined;
    const copiedLocalizedReadme = platform === "nowcoder"
      ? sourceLocalizedReadme?.replaceAll("@kaiserunix/nowcoder-mcp-server", config.packageName)
      : sourceLocalizedReadme;
    const releaseLocalizedReadme = config.localizedReadme === undefined
      ? undefined
      : platform === "nowcoder"
        ? copiedLocalizedReadme
        : readmeZh(platform, config, sourceCommit);
    const packageLocalizedReadme = config.localizedReadme === undefined
      ? undefined
      : platform === "nowcoder"
        ? releaseLocalizedReadme
        : readmeZh(platform, config, sourceCommit, "../../");

    await Promise.all([
      writeJson(join(destination, "package.json"), rootManifest(platform, config, providerManifest.version)),
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
        platform === "nowcoder"
          ? releaseReadme
          : `${packageReleaseReadme}\n\n## Provider Implementation Details\n\n${implementationReadme}\n`,
        "utf8"
      ),
      writeFile(join(destination, "PROVENANCE.md"), provenance(platform, sourceCommit), "utf8"),
      writeFile(join(destination, "SECURITY.md"), securityPolicy(config), "utf8"),
      ...(releaseLocalizedReadme === undefined
        ? []
        : [
            writeFile(join(destination, config.localizedReadme), releaseLocalizedReadme, "utf8"),
            writeFile(
              join(destination, "packages", platform, config.localizedReadme),
              packageLocalizedReadme,
              "utf8"
            )
          ]),
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

function rootManifest(platform, config, providerVersion) {
  const packCheck =
    platform === "codeforces"
      ? `npm run test:pack --workspace ${config.packageName}`
      : platform === "nowcoder"
        ? `npm run pack:check --workspace ${config.packageName}`
        : `npm pack --dry-run --workspace ${config.packageName}`;
  return {
    name: `${platform}-mcp-server-workspace`,
    version: providerVersion,
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

function readme(platform, config, sourceCommit, linkPrefix = "") {
  const remote = config.remoteUrl
    ? `## Quick Start

Add the hosted server to your MCP configuration:

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

The endpoint accepts anonymous read requests. It does not need an API key, Cookie, or judge account.

`
    : "";
  const credentialPolicy = config.acceptsSessionCookie
    ? `The server accepts an optional NowCoder Cookie only from \`NOWCODER_SESSION_COOKIE\` at local
stdio process startup. Inject it from a trusted secret manager; never put it in tool arguments,
MCP configuration files, command-line arguments, logs, or committed files.`
    : "It accepts no judge account credentials.";
  const localizedNavigation = config.localizedReadme
    ? `[简体中文](${config.localizedReadme})\n\n`
    : "";
  return `# ${config.displayName}

${localizedNavigation}${config.description}

${remote}Then ask:

\`\`\`text
${config.examplePrompt}
\`\`\`

## What It Can Do

| Tool | Purpose |
| --- | --- |
${config.tools.map((tool) => `| \`${tool}\` | ${config.toolDescriptions[tool]} |`).join("\n")}

## Run Locally

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

Tagged GitHub releases attach a standalone npm tarball.

## Availability

- Hosted MCP: \`${config.remoteUrl}\`
- Official MCP Registry: \`${config.mcpName}\`, described by [\`server.json\`](${linkPrefix}server.json)
- Health status: see the repository homepage or call \`oj_health\`

## Source and Safety

This standalone release is generated from the reviewed
[Competitive Programming MCP source](${sourceRepository}/tree/${sourceCommit}/packages/${platform}).
The release package bundles the shared OJ contract implementation, so its runtime does not depend
on unpublished workspace packages.

## Platform Rules

${config.policy}

The server exposes no run or submit tool. ${credentialPolicy} See
[SECURITY.md](${linkPrefix}SECURITY.md) for the security boundary and [PROVENANCE.md](${linkPrefix}PROVENANCE.md) for the
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

function readmeZh(platform, config, sourceCommit, linkPrefix = "") {
  return `# ${config.displayName}

[English](README.md)

${config.descriptionZh}

## 快速开始

把公共服务加入 MCP 配置：

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

配置后可以直接说：

\`\`\`text
${config.examplePromptZh}
\`\`\`

该地址只处理匿名读取，不需要 API Key、Cookie 或 OJ 账号。

## 能做什么

| 工具 | 用途 |
| --- | --- |
${config.tools.map((tool) => `| \`${tool}\` | ${config.toolDescriptionsZh[tool]} |`).join("\n")}

## 本地运行

需要 Node.js 22 或更新版本。

\`\`\`bash
npm ci
npm run check
npm run build
node packages/${platform}/dist/index.js
\`\`\`

从源码目录启动时的 MCP 配置：

\`\`\`json
{
  "servers": {
    "${platform}": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/替换为实际路径/packages/${platform}/dist/index.js"]
    }
  }
}
\`\`\`

带版本号的 GitHub Release 会附带独立 npm 压缩包。

## 服务地址

- 公共 MCP：\`${config.remoteUrl}\`
- 官方 MCP Registry：\`${config.mcpName}\`，定义见 [\`server.json\`](${linkPrefix}server.json)
- 健康状态：查看仓库主页，或调用 \`oj_health\`

## 来源与安全

该独立仓库由经过审阅的
[Competitive Programming MCP 源码](${sourceRepository}/tree/${sourceCommit}/packages/${platform})
生成。发布包内含统一 OJ 契约的运行代码，不依赖未发布的工作区包。

服务不提供运行或提交工具，也不接收 OJ 登录凭据。安全边界见
[\`SECURITY.md\`](${linkPrefix}SECURITY.md)，对应的源代码版本见 [\`PROVENANCE.md\`](${linkPrefix}PROVENANCE.md)。

## 平台规则

${config.policyZh}

## 开发

\`\`\`bash
npm ci
npm run check
npm run pack:check
${config.worker ? "npm run deploy:dry\n" : ""}\`\`\`

## 许可证

适配器源码使用 MIT 许可证。题目内容和平台商标不因本仓库重新授权。
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
  if (config.supportsJudgeActions) {
    return `# Security Policy

Report vulnerabilities through the private GitHub Security Advisory form for
\`ketherworks/${config.repositoryName}\`. Do not include judge cookies, account tokens, source code,
or other secrets in a public issue.

The server runs as a local stdio process. It reads the complete Cookie from
\`NOWCODER_SESSION_COOKIE\` at startup. The full Cookie is sent only to validated
\`ac.nowcoder.com\` pages; the access-token host receives only \`csrf_token\` and \`NOWCODER*\`
cookies, and question/judge hosts receive no Cookie. Cookie, CSRF token, judge token, and source code
never enter MCP process logs, MCP errors, capability output, or submission previews.

Problem search, browser import, profile reads, and submission history are bounded and schema checked.
The short-lived Competitive Companion receiver binds loopback only, rejects ordinary web origins,
and closes slow connections; the standard protocol has no sender nonce, so another local process can
still post during an explicitly opened import window.
Judge actions bind the official problem page to a saved local \`file:\` URI, re-read the file before
upload, and show the canonical problem, submitter, contest, path, language, byte count, and SHA-256.
Platform self-test confirms before uploading source. Real submission uses a two-minute immutable
preview plus MCP form elicitation; one acceptance authorizes exactly one POST. Every unprovable
post-dispatch result returns \`outcome_unknown\` and is never retried automatically.

The server does not extract browser cookies or bypass anti-bot challenges. Keep it on local stdio;
do not expose authenticated tools through a shared HTTP deployment.
`;
  }
  const credentialBoundary = config.acceptsSessionCookie
    ? `Its only credential-forwarding path is an optional Cookie read from
\`NOWCODER_SESSION_COOKIE\` at local process startup and sent to an allowlisted
\`https://ac.nowcoder.com\` request. The Cookie must never enter tool arguments, output, logs,
files, cross-origin redirects, or a remotely hosted transport. The server must not gain automatic
browser-cookie extraction, submission, code execution, or challenge-bypass behavior without a
separate threat model and explicit security review.`
    : `It must not gain submission, code-execution, credential-forwarding, or challenge-bypass
behavior without a separate threat model and explicit security review.`;
  return `# Security Policy

Report vulnerabilities through the private GitHub Security Advisory form for
\`ketherworks/${config.repositoryName}\`. Do not include judge cookies, account tokens, source code,
or other secrets in a public issue.

This server is read-only. ${credentialBoundary}
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
      - uses: ${checkoutAction} # v7
      - uses: ${setupNodeAction} # v7
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
      - uses: ${checkoutAction} # v7
      - uses: ${setupNodeAction} # v7
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
