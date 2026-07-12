# OJ MCP Node HTTP Host

Private deployment wrapper for the audited AtCoder and Luogu Web workers. It
exists for hosts whose outbound network can reach a judge that rejects shared
Cloudflare Worker egress. It does not add tools, credentials, retries, browser
automation, or challenge bypasses.

The host accepts only `atcoder` or `luogu`, preserves Streamable HTTP response
streaming, propagates client disconnects to the worker request, and strips the
optional `X-OJ-MCP-Key` header before the request reaches MCP code.

```bash
docker build -f packages/node-http-host/Dockerfile -t oj-mcp-node-http-host .
docker run --rm -p 127.0.0.1:39101:8787 \
  -e OJ_MCP_HOST=0.0.0.0 \
  -e OJ_MCP_PORT=8787 \
  oj-mcp-node-http-host atcoder
```

For a backend that must cross an untrusted network, set an independently
generated value of at least 24 characters in `OJ_MCP_INTERNAL_KEY`, and have
the trusted reverse proxy send it as `X-OJ-MCP-Key`. The backend returns 401
without that exact value. This is deployment authentication for the private
origin only; it is not an end-user MCP credential.

| Name | Default | Purpose |
| --- | --- | --- |
| `OJ_MCP_HOST` | `127.0.0.1` | Listen address |
| `OJ_MCP_PORT` | `8787` | Listen port |
| `OJ_MCP_INTERNAL_KEY` | unset | Optional private-origin key |
| `ATCODER_MCP_ALLOWED_ORIGINS` | unset | Browser origin allowlist for AtCoder |
| `LUOGU_MCP_ALLOWED_ORIGINS` | unset | Browser origin allowlist for Luogu |

Do not set account cookies, authorization headers, or judge credentials. The
underlying providers intentionally reject them.
