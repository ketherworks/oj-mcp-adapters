# Competitive Programming MCP | Algorithm Practice MCP

[简体中文](README.zh-CN.md)

Small MCP servers for finding and reading programming problems from Codeforces, AtCoder, Luogu, and NowCoder. They share one typed OJ contract, but each platform can still run on its own.

## Try A Hosted Server

The public endpoints accept anonymous read requests and require no API key:

```json
{
  "servers": {
    "codeforces": {
      "type": "http",
      "url": "https://codeforces-oj-mcp.lantangtang54.workers.dev/mcp"
    },
    "atcoder": {
      "type": "http",
      "url": "https://api.ksrnyx.top/oj-mcp/atcoder/mcp"
    },
    "luogu": {
      "type": "http",
      "url": "https://api.ksrnyx.top/oj-mcp/luogu/mcp"
    }
  }
}
```

Example prompts:

```text
Find five Codeforces implementation problems for beginners.
Fetch AtCoder problem abc086_a with its samples.
Search Luogu for dynamic programming practice problems.
```

## Platforms

| Platform | What it provides | How it runs |
| --- | --- | --- |
| [Codeforces](https://github.com/ketherworks/codeforces-mcp-server) | Official API problem search and metadata | Hosted HTTP or local stdio |
| [AtCoder](https://github.com/ketherworks/atcoder-mcp-server) | Exact past-problem lookup and full statements | Hosted HTTP or local stdio |
| [Luogu](https://github.com/Kaiserunix/luogu-mcp-server) | Public problem search and statements | Hosted HTTP or local stdio |
| [NowCoder / 牛客](https://github.com/ketherworks/nowcoder-mcp-server) | Search, statements, browser import, profiles, runs, submissions, and judging | Local stdio |
| LeetCode Global/CN | Local integration guide for an established upstream MCP | External local stdio |

NowCoder's fuller local workflow is also released as [牛客 MCP Server](https://github.com/ketherworks/nowcoder-mcp-server). For LeetCode, this repository documents the audited upstream setup without redistributing a modified implementation; see the [LeetCode provider guide](docs/providers/leetcode.md).

## Repository Layout

- `packages/contracts`: shared OJ v1 types, codecs, and JSON Schemas.
- `packages/server-common`: shared MCP result and error helpers.
- `packages/codeforces`: Codeforces official API provider.
- `packages/atcoder`: AtCoder public problem-page provider.
- `packages/luogu`: Luogu public search and statement provider.
- `packages/nowcoder`: local NowCoder provider with login-aware workflows.
- `packages/node-http-host`: private-origin HTTP wrapper used by the hosted AtCoder and Luogu endpoints.

Every provider reports its own capabilities and health. Public HTTP endpoints expose anonymous reads only. Login state, source code, platform runs, and submissions stay in local processes.

## Local Development

Requires Node.js 22 or newer.

```powershell
npm ci
npm run check
```

Each deployable package owns fixture tests, package smoke tests, and deployment checks. See [production endpoints](docs/deployment/production-endpoints.md) for the currently verified hosted services.

## License

Adapter source code is MIT licensed. Problem statements, platform names, and trademarks remain subject to their respective owners' terms.
