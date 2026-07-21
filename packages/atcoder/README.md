# AtCoder MCP Server

[简体中文](README.zh-CN.md)

Find and read past AtCoder problems from an MCP client. The server returns the statement, samples, limits, sanitized HTML, and source metadata for an exact task URL or contest/task id.

## Quick Start

Use the hosted endpoint without an API key:

```json
{
  "servers": {
    "atcoder": {
      "type": "http",
      "url": "https://api.ksrnyx.top/oj-mcp/atcoder/mcp"
    }
  }
}
```

Then ask:

```text
Fetch AtCoder problem abc086_a and show its samples.
```

For local stdio, build the workspace with Node.js 22 or newer and run `npm start` from this package.

## What It Can Do

- `oj_capabilities`: describes the available AtCoder read operations.
- `oj_health`: reports local readiness and the latest upstream read.
- `oj_fetch_problem`: fetches one canonical task URL or exact contest/task pair.
- `oj_search_problems`: resolves an exact task URL or contest/task identifier.

`oj_fetch_problem` accepts either:

```json
{ "url": "https://atcoder.jp/contests/abc086/tasks/abc086_a?lang=ja" }
```

or:

```json
{ "contestId": "abc086", "taskId": "abc086_a", "locale": "en" }
```

## Practice Use

This project is intended for past-problem practice. Do not use this server during ongoing ABC, ARC, or AGC contests; AtCoder's current [generative-AI rules](https://info.atcoder.jp/entry/llm-rules-en) generally prohibit that use apart from narrowly defined translation.

The adapter is community maintained, unofficial and is not affiliated with or endorsed by AtCoder Inc. Its MIT license covers the adapter source; AtCoder content remains subject to the [AtCoder Terms of Use](https://atcoder.jp/tos?lang=en).

## Implementation

Under the hood, this is an anonymous read-only adapter. The server reads canonical HTTPS task pages on `atcoder.jp`, applies bounded HTML parsing, removes executable markup, and returns structured MCP output. No authentication, code execution, or submission tools are exposed.

The package also includes a stateless Streamable HTTP Worker entrypoint at `/mcp`. Browser origins are denied unless listed in `ATCODER_MCP_ALLOWED_ORIGINS`.

## Security Bounds

- Requests are limited to canonical HTTPS task pages on `atcoder.jp`.
- Redirects stay on the same task and locale and are capped at two.
- Upstream reads have an 8-second timeout and a 2,000,000-byte response limit.
- Worker requests reject JSON-RPC batches and bodies above 65,536 bytes.
- HTML parsing and returned text are bounded; executable markup and unsafe content URLs are removed.
- Unknown page structures fail with `upstream.schema_changed` instead of returning partial statements.

## Development

```sh
npm test
npm run build
npm pack --dry-run --json
wrangler deploy --dry-run
```

Fixture tests do not contact AtCoder or deploy a Worker.

## License

MIT. See `LICENSE`.
