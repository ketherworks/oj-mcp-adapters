# Production Endpoints

The public deployments expose anonymous, read-only MCP tools. End users do not
send `X-OJ-MCP-Key`; that header is private-origin authentication between the
HTTPS reverse proxy and a non-public backend.

| Platform | MCP endpoint | Health endpoint | Deployment |
| --- | --- | --- | --- |
| Codeforces | `https://codeforces-oj-mcp.lantangtang54.workers.dev/mcp` | `https://codeforces-oj-mcp.lantangtang54.workers.dev/healthz` | Cloudflare Worker |
| AtCoder | `https://api.ksrnyx.top/oj-mcp/atcoder/mcp` | `https://api.ksrnyx.top/oj-mcp/atcoder/healthz` | Node 22 container behind HTTPS |
| Luogu | `https://api.ksrnyx.top/oj-mcp/luogu/mcp` | `https://api.ksrnyx.top/oj-mcp/luogu/healthz` | Node 22 container behind HTTPS and a private tunnel |

NowCoder and LeetCode have no public endpoint. NowCoder remains local stdio;
the separately audited LeetCode provider remains private local stdio.

Release smoke tests must call `tools/list` and one representative anonymous
read, not only `/healthz`. AtCoder and Luogu shared Cloudflare Workers were
removed after real reads showed upstream egress blocking despite successful
MCP handshakes.
