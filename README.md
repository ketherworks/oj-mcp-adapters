# OJ MCP Adapters

Independent Model Context Protocol adapters for online judges used by Student Autocomplete Lab.

The source is organized as an npm workspace, while every platform builds and deploys as an isolated process or Worker. Public remote entrypoints expose only anonymous read operations. Browser state, account credentials, code execution, and submissions remain local.

## Packages

- `@kaiserunix/oj-mcp-contracts`: generated OJ contract v1 codecs and JSON Schemas.
- `@kaiserunix/oj-mcp-server-common`: shared MCP server plumbing without platform behavior.
- `@kaiserunix/codeforces-mcp-server`: Codeforces official API read provider.
- `@kaiserunix/nowcoder-mcp-server`: local stdio adapter for public NowCoder problem pages.
- `@kaiserunix/atcoder-mcp-server`: anonymous official AtCoder HTML provider.
- `@kaiserunix/luogu-mcp-server`: anonymous Luogu search and problem provider.
- `@kaiserunix/oj-mcp-node-http-host`: private-origin HTTP wrapper for AtCoder and Luogu.

## Deployment Matrix

| Platform | Public remote | Local stdio | Upstream boundary |
| --- | --- | --- | --- |
| Codeforces | Cloudflare Worker | Yes | Official public API |
| LeetCode Global/CN | No | External local provider | Audited upstream MCP; see [LeetCode provider](docs/providers/leetcode.md) |
| AtCoder | Trusted Node HTTPS origin | Yes | Official public HTML |
| Luogu | Trusted Node HTTPS origin | Yes | Anonymous public page endpoints |
| NowCoder | No | Yes | Public page adapter with DNS pinning |

AtCoder and Luogu can also run behind the private
[`node-http-host`](packages/node-http-host/README.md) wrapper when a judge
rejects shared Cloudflare Worker egress. The wrapper preserves the exact MCP
tool surface and sits behind a trusted HTTPS reverse proxy; it is not a
general-purpose fetch relay.

The Worker entrypoints remain buildable for controlled deployments, but live
upstream reads must pass from the chosen egress before publication. The
current shared Cloudflare deployment is used only for Codeforces because its
official API passed that gate. See [production endpoints](docs/deployment/production-endpoints.md).

Remote Workers expose only anonymous `R0_public_read` tools. They enforce bounded request bodies, reject JSON-RPC batches, and bound upstream concurrency, response sizes, and timeouts. Credentials, browser sessions, private profiles, code execution, and submissions are not accepted by these entrypoints. NowCoder remains local because its page and anti-bot behavior is not suitable for a shared remote service. LeetCode is intentionally excluded from this repository's source, packages, and deployments.

## External LeetCode Provider

This project does not redistribute or host a LeetCode MCP implementation. The learning-workbench integration uses an audited local provider derived from [`jinzcdev/leetcode-mcp-server` v1.3.0](https://github.com/jinzcdev/leetcode-mcp-server/releases/tag/v1.3.0), with the extension translating its responses into the public OJ contract. See [docs/providers/leetcode.md](docs/providers/leetcode.md) for the source, boundaries, and local setup.

## Development

```powershell
npm ci
npm run check
```

Each deployable package also owns fixture tests, a clean package smoke test, and a Wrangler dry run. Normal tests do not make live judge requests.
