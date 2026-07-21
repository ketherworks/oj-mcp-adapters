# Competitive Programming MCP | Algorithm Practice MCP

[简体中文](README.zh-CN.md)

Connect an MCP client to Codeforces, AtCoder, Luogu, or NowCoder. Use a hosted read-only server for problem lookup, or run the NowCoder server locally for browser import, profile, run, and confirmed submission workflows.

## Choose a Platform

| Platform | Best for | Start here |
| --- | --- | --- |
| [Codeforces](https://github.com/ketherworks/codeforces-mcp-server) | Search official problem metadata by title, id, rating, and tag | Hosted HTTP |
| [AtCoder](https://github.com/ketherworks/atcoder-mcp-server) | Fetch past-problem statements, samples, and limits by task id or URL | Hosted HTTP |
| [Luogu / 洛谷](https://github.com/Kaiserunix/luogu-mcp-server) | Search problems and training sets, read statements, and find related practice | Hosted HTTP or local npm |
| [NowCoder / 牛客](https://github.com/ketherworks/nowcoder-mcp-server) | Search, browser import, profile, run, submission preview, and confirmed submission | Local stdio |
| LeetCode Global/CN | Use an established upstream MCP through the shared OJ contract | [Local setup guide](docs/providers/leetcode.md) |

Each linked platform repository can be installed on its own. This repository contains the shared contracts, adapters, tests, and release tooling.

## Quick Start

### Hosted problem lookup

Keep only the servers you need:

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
      "url": "https://luogu-mcp-server.lantangtang54.workers.dev/mcp"
    }
  }
}
```

These endpoints accept anonymous read requests. No API key or judge account is needed.

### NowCoder account actions

Clone and run [NowCoder MCP Server](https://github.com/ketherworks/nowcoder-mcp-server#quick-start) locally. Login state and source code stay in the local stdio process, and every real submission requires a fresh confirmation.

## Try It

```text
Find five Codeforces implementation problems for beginners.
Fetch AtCoder problem abc086_a and show its samples.
Search Luogu for dynamic-programming practice problems.
Import NowCoder problem NC218144 and prepare my saved main.cpp for submission.
```

## Shared Contract

All bundled providers report capabilities and health through the same typed OJ v1 contract. Problem documents, search results, errors, run previews, and submission evidence keep their platform source and timestamps.

Public HTTP servers expose anonymous reads only. Login state, source code, platform runs, and submissions stay in local processes.

## Repository Layout

- `packages/contracts`: shared OJ v1 types, codecs, and JSON Schemas.
- `packages/server-common`: shared MCP result and error helpers.
- `packages/codeforces`, `packages/atcoder`, `packages/luogu`, `packages/nowcoder`: platform providers.
- `packages/node-http-host`: HTTP host used by the hosted read-only adapters.
- `scripts/export-standalone.mjs`: produces the standalone platform repositories.

## Development

Requires Node.js 22 or newer.

```powershell
npm ci
npm run check
```

Current deployments and verification notes are recorded in [production endpoints](docs/deployment/production-endpoints.md).

## License

Adapter source code is MIT licensed. Problem statements, platform names, and trademarks remain subject to their respective owners' terms.
