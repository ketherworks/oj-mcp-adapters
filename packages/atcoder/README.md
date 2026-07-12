# AtCoder MCP Server

An honest, anonymous read-only MCP adapter for public problem pages on the official
`https://atcoder.jp` host. It parses AtCoder HTML rather than pretending the site
offers a problem API.

No authentication, code execution, or submission tools are exposed. The adapter
does not run solutions, read profiles, list submissions, or send code to AtCoder.

## Tools

- `oj_capabilities`: reports the audited read surface and unsupported operations.
- `oj_health`: reports local readiness and the latest observed upstream read.
- `oj_fetch_problem`: fetches one canonical task URL or exact contest/task pair.
- `oj_search_problems`: resolves only an exact task URL or contest/task identifier.

`oj_fetch_problem` accepts either:

```json
{ "url": "https://atcoder.jp/contests/abc086/tasks/abc086_a?lang=ja" }
```

or:

```json
{ "contestId": "abc086", "taskId": "abc086_a", "locale": "en" }
```

Exact URL lookup preserves `?lang=ja` unless an explicit locale overrides it.
Free-text search and catalog crawling are intentionally unsupported.

## Runtime

Node.js 22 or newer is required. After installing and building the package, start
the stdio server with:

```sh
npm start
```

The Cloudflare Worker entry is the shipped `dist/worker.js`. `wrangler.jsonc` is
included in the package and configures a stateless Streamable HTTP endpoint at
`/mcp`. Browser origins are denied unless listed in the optional
`ATCODER_MCP_ALLOWED_ORIGINS` comma-separated environment variable.

## Security Bounds

- Upstream requests allow only canonical HTTPS task paths on `atcoder.jp`.
- Redirects remain on the same task and locale and are capped at two.
- Upstream reads time out after 8 seconds and are capped at 2,000,000 bytes.
- Inbound Worker JSON is capped at 65,536 bytes; JSON-RPC batches are rejected.
- Worker admission is capped at eight concurrent MCP requests per isolate.
- A linear preflight bounds potential nodes, depth, and 1,500,000 text bytes before HTML5 DOM allocation;
  the parsed tree is checked again at 25,000 nodes, depth 256, and 1,500,000 decoded characters.
- Executable markup and unsafe content URLs are removed before content is returned.
- Ordinary tasks fail closed when audited statement sections, samples, constraints,
  or complete time and memory limits are missing.

AtCoder can change its page markup. Unknown structures and unknown special-task
notices deliberately return `upstream.schema_changed` instead of partial data.

## Development

```sh
npm test
npm run build
npm pack --dry-run --json
wrangler deploy --dry-run
```

Tests use checked-in fixtures. They do not make live AtCoder requests or deploy a
Worker.

## License

MIT. See `LICENSE`.
