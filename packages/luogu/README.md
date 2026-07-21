# Luogu MCP Server | 洛谷 MCP Server

Search and read public Luogu problems from an MCP client. The server returns normalized titles, statements, samples, limits, tags, and source metadata.

## Quick Start

```json
{
  "servers": {
    "luogu": {
      "type": "http",
      "url": "https://api.ksrnyx.top/oj-mcp/luogu/mcp"
    }
  }
}
```

Then ask:

```text
在洛谷搜索五道适合入门的动态规划题。
获取洛谷 P1001 的题面和样例。
```

## Tools

| Tool | Output | Upstream access |
| --- | --- | --- |
| `oj_capabilities` | `oj.capabilities/v1` | None |
| `oj_health` | `oj.provider-health/v1` | None; reports the process's last read observation |
| `oj_search_problems` | `oj.search-result/v1` | One anonymous problem-list GET |
| `oj_fetch_problem` | `oj.problem-document/v1` | One anonymous problem-page GET |

Every tool is annotated read-only, non-destructive, idempotent, and with the
appropriate open-world hint. Search inputs use the shared request shape with
narrower provider bounds: query 1-200 characters, limit 1-50, and a validated
opaque cursor. Problem ids, content, pages, item arrays, response bytes, and
network duration are bounded. Returned objects are validated against the
shared schemas. Response bytes are counted from the Web response stream before
text decoding or buffering; oversized chunked or runtime-decompressed bodies
cancel the reader immediately.

## Security Policy

The adapter constructs URLs only under `https://www.luogu.com.cn`, rejects
cross-origin responses, sends GET requests with `credentials: "omit"`, and
never accepts or forwards cookies or authorization data. It exposes no profile,
private-data, run, or submit tool. There is no browser automation or challenge
bypass. Challenges, source-policy violations, schema drift, rate limits,
timeouts, missing resources, and invalid requests map to shared `oj.error/v1`
results. Tool discovery publishes strict JSON Schemas while low-level call
dispatch performs strict handler validation so invalid calls still return shared
structured errors.

The content-only pages are an unofficial page adapter, not a formal Luogu API.
`oj_capabilities` marks that compliance and all excluded operations explicitly.
Account-bound operations remain `disabled_by_policy` while truthfully reporting
their upstream `session_cookie` authentication requirement.

## Transports

Local stdio:

```json
{
  "mcpServers": {
    "luogu": {
      "command": "node",
      "args": ["/absolute/path/to/packages/luogu/dist/index.js"]
    }
  }
}
```

The package also includes a Cloudflare Worker entrypoint at `/mcp`, with
`/healthz` for transport metadata. The MCP transport is stateless and bounded:
each server instance is request-local, while one bounded process-level health
observation persists across requests. Each upstream tool makes exactly one
fixed-origin anonymous GET with no retries, no secrets or cookies exist, and
there are no private or write tools. Browser origins are
denied unless explicitly listed in `LUOGU_MCP_ALLOWED_ORIGINS`. No live deploy
is part of package tests. The shipped Wrangler configuration runs the compiled
`dist/worker.js` artifact included in the npm package.

Cancellation is request-scoped on the Worker. Aborting the same HTTP request
combines that transport signal with the SDK call signal, stops the anonymous
upstream read, and does not alter provider health. The
[MCP 2025-11-25 cancellation specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation)
defines `notifications/cancelled` for a request believed to remain in progress
and previously issued in the same direction. Because this anonymous Worker is
sessionless and creates a request-local server for every POST, cross-POST
`notifications/cancelled` messages are intentionally ignored. It keeps no
global JSON-RPC-id correlation table, avoiding cross-client ID collisions.
When a runtime cannot surface a disconnect, bounded timeout and admission
controls remain active.

## Development

```powershell
npm run build
npm test
```

Fixture tests do not contact Luogu. They cover the current content-only shapes,
shared normalization, bounds, source confinement, drift and challenge errors,
MCP calls, and the Worker transport.

## Read-Only Upstream Audit

The audit source was
[`Kaiserunix/luogu-mcp-server`](https://github.com/Kaiserunix/luogu-mcp-server)
at revision `9d3f5bc47647620ea2f8566e2be65bdf5cc2ca3b`. It was inspected read-only.

| Area | Audited result |
| --- | --- |
| Revision | Package `0.2.1`, commit `9d3f5bc47647620ea2f8566e2be65bdf5cc2ca3b`, no tag at HEAD |
| License | MIT, Copyright (c) 2026 Kaiserunix |
| Runtime pins | Package requires Node `>=20`; lock resolves MCP `1.29.0` and Zod `4.3.6` |
| Tools | `luogu_search_problems`, `luogu_fetch_problem`, `luogu_resolve_problem`, `luogu_find_related_problems`, `luogu_list_algorithm_topics`, `luogu_find_topic_problems`, `luogu_search_problem_sets`, `luogu_fetch_problem_set`, `luogu_recommend_problems`, `luogu_get_user_profile`, `luogu_get_capabilities` |
| Transports | Local stdio and stateless Web Standard Streamable HTTP Worker at `/mcp` |
| Authentication | Problem/training/profile reads are anonymous; Worker may optionally require its own bearer token; recent submissions, solution pages, and discussions are reported auth-required; submit/run are not implemented |
| Tests | 33 declared cases across seven files, covering client, normalizers, tools, topics, server tool listing, and Worker origin/token behavior |

### Exact Reuse vs. Replace

| Audited behavior | Decision in this package |
| --- | --- |
| `/problem/list?type=P&keyword=...` and `/problem/{pid}` | Reused with attribution; page and identifier bounds added |
| `x-lentille-request: content-only`, JSON accept, Luogu referer | Reused with attribution; credentials omitted and redirects rejected |
| `title` or `name`; `content` or `contenu`; direct-field fallbacks | Reused with attribution and encoded as bounded Zod compatibility schemas |
| Tuple and object sample shapes | Reused with attribution and converted to shared ordinal samples |
| Stateless `WebStandardStreamableHTTPServerTransport` and origin allowlist | Reused with attribution; token handling removed because this remote surface is anonymous |
| Bespoke `ProblemRecord`/`ProblemSummary` outputs | Replaced by shared OJ schemas, source references, truncation metadata, and SHA-256 blocks |
| Cast-based payload parsing and silently dropped malformed list items | Replaced by bounded runtime validation and `upstream.schema_changed` errors |
| Generic HTTP/JSON errors and automatic transient retries | Replaced by shared actionable errors, a timeout/body cap, `Retry-After`, and no automatic replay |
| Eleven tools including profile/training/recommendation routes | Replaced by exactly four approved tools; profile/private/run/submit paths are absent |
| Partial MCP annotations and no output schemas | Replaced by all four annotations plus shared output schemas and structured content |
| Capability-only route report | Replaced by full shared capabilities and process-local health documents |

See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for attribution and the
upstream license notice.
