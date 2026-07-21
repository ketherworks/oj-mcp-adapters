# Codeforces MCP Server

[简体中文](README.zh-CN.md)

Search official Codeforces problem metadata from an MCP client. It is useful for finding practice problems by title, id, or tag.

## Quick Start

```json
{
  "servers": {
    "codeforces": {
      "type": "http",
      "url": "https://codeforces-oj-mcp.lantangtang54.workers.dev/mcp"
    }
  }
}
```

Then ask:

```text
Find five beginner Codeforces problems tagged implementation.
Get the metadata for Codeforces problem 71/A.
```

## What It Can Do

| Tool | Purpose |
| --- | --- |
| `oj_capabilities` | Report the available Codeforces read operations and transport. |
| `oj_health` | Report service health and the latest official API observation. |
| `oj_search_problems` | Search the official problemset by title, id, rating, or tag. |
| `codeforces_get_problem_metadata` | Fetch one problem's official metadata by native id. |

The adapter exposes official problem metadata only. It does not authenticate, fetch problem statements, run code, or submit solutions. Search accepts the shared `oj.search-request/v1` fields `requestId`, `platform: "codeforces"`, `query`, and `limit`; cursors and locale selection are not supported by this full-problemset API.

Problems use `contestId/index` as their native identity when a contest id is present, and `problemsetName/index` for official custom problemsets. Official API payloads are validated before normalization or caching, including the documented `PROGRAMMING` and `QUESTION` problem types.

The Cloudflare Worker serves stateless Streamable HTTP at `/mcp`. `/healthz` is liveness-only, while `oj_health` reads the last persisted upstream observation from the Durable Object. The Worker rejects request bodies above 256 KiB and rejects every JSON-RPC batch because MCP 2025-11-25 Streamable HTTP accepts one message per POST. Worker and Durable Object queues are bounded and return HTTP 429 on saturation. Browser origins are denied unless listed in `CODEFORCES_MCP_ALLOWED_ORIGINS`; `*` explicitly enables wildcard CORS.

Validated problemset responses are published as generation-scoped Durable Object chunks. Metadata is written only after every bounded chunk succeeds, then chunks from prior or interrupted generations are deleted. API `FAILED` responses, invalid JSON, and schema drift are never cached.

## Commands

```text
npm run build
npm test
npm run typecheck
npm run test:pack
npm run deploy:cf:dry-run
npm start
```

Build, prepack, deploy, and dry-run use the compiled `dist/worker.js` entrypoint. The package requires Node.js 22 or newer.

Release packages are published only from Linux CI so the CLI executable mode is preserved in the npm tarball. Windows remains supported for local build, test, and pack smoke workflows, but `npm publish` is rejected there by `prepublishOnly`.
