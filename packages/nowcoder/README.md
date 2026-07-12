# NowCoder MCP Server

Read-only MCP adapter for official public NowCoder/牛客 ACM problem pages. This package is an unofficial page adapter; it does not use or claim an official NowCoder API.

## Tools

- `oj_capabilities`: reports the single audited fetch capability and every unsupported operation.
- `oj_health`: reports passive health from the last fetch without making a network probe.
- `oj_fetch_problem`: returns an `OjProblemDocument` from one allowlisted public page URL or canonical native ID.

`oj_search_problems` is intentionally absent. The public problem-list page is useful to humans, but no stable anonymous search contract has been audited. Browser import, cookies, authentication, profiles, submissions, execution, and judging are also absent.

## Accepted URLs

Only HTTPS URLs on the exact host `ac.nowcoder.com` are accepted:

```text
https://ac.nowcoder.com/acm/problem/<numeric-id>
https://ac.nowcoder.com/acm/contest/<numeric-contest-id>/<problem-index>
```

Query strings and fragments are discarded. Other NowCoder products and legacy URL shapes are rejected until they can be independently audited.

The alternative `nativeId` input accepts exactly these deterministic forms:

```text
NC<positive-numeric-id>                         -> /acm/problem/<id>
<positive-numeric-contest-id>/<uppercase-index> -> /acm/contest/<contest-id>/<index>
```

Numeric contest indexes are also accepted. Bare numbers, leading zeroes, lowercase indexes, path segments, and requests containing both `url` and `nativeId` are rejected.

## Safety

- URL scheme, hostname, port, credentials, and path are allowlisted before every request and redirect.
- DNS A and AAAA queries use a cancellation-capable Node resolver under the shared deadline. Every answer must be public unicast; IANA non-global ranges and transition addresses with embedded non-global IPv4 targets are rejected. The complete validated dual-stack answer set is pinned into TLS fallback while preserving hostname verification and SNI.
- Redirects are manual and limited to two allowlisted hops.
- One 10-second deadline covers DNS, response body transfer, and every redirect hop; abort listeners and sockets are cleaned up when the operation settles. Responses are capped at 2 MiB of UTF-8 HTML.
- Anti-bot pages produce `challenge.required`; the adapter never attempts to bypass them.
- Responses are normalized from the same public ACM DOM used by Competitive Companion, with required input/output sections, source provenance, and SHA-256 hashes on text blocks. Missing required sections fail as `upstream.schema_changed`.

## Transport Choice

The package exposes stdio only. A Worker was deliberately omitted: a public HTTP deployment would become an anonymous NowCoder page-fetch relay, while the Worker runtime cannot provide the same explicit DNS resolution and TLS address pinning used by this Node adapter. Keeping the process local also avoids amplifying rate limits and challenge traffic. The implementation is stateless apart from passive last-fetch health, but that alone is not enough to make a public relay prudent.

## Development

Node.js 22, TypeScript ESM/NodeNext, MCP SDK 1.29.0, and Zod 4.3.6 are required.

```powershell
npm run build
npm run typecheck
npm run typecheck:test
npm test
npm run pack:check
npm start
```

Tests use static fixtures and loopback-only TLS servers. They do not contact NowCoder or deploy any service.
