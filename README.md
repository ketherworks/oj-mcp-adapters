# OJ MCP Adapters

Independent Model Context Protocol adapters for online judges used by Student Autocomplete Lab.

The source is organized as an npm workspace, while every platform builds and deploys as an isolated process or Worker. Public remote entrypoints expose only anonymous read operations. Browser state, account credentials, code execution, and submissions remain local.

## Packages

- `@kaiserunix/oj-mcp-contracts`: generated OJ contract v1 codecs and JSON Schemas.
- `@kaiserunix/oj-mcp-server-common`: shared MCP server plumbing without platform behavior.
- `@kaiserunix/codeforces-mcp-server`: Codeforces official API read provider.
