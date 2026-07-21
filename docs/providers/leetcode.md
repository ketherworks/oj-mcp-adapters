# LeetCode MCP Provider

Use the established `jinzcdev/leetcode-mcp-server` as a local stdio provider for LeetCode Global or CN. This repository documents the compatibility boundary used by the shared OJ contract; credentials and any local adaptation stay on the user's machine.

## Upstream

- Project: [`jinzcdev/leetcode-mcp-server`](https://github.com/jinzcdev/leetcode-mcp-server)
- Audited release: [`v1.3.0`](https://github.com/jinzcdev/leetcode-mcp-server/releases/tag/v1.3.0)
- License: [MIT](https://github.com/jinzcdev/leetcode-mcp-server/blob/v1.3.0/LICENSE)
- Transport: local stdio

Consumers can map its responses into `OjCapabilities`, `OjProblemDocument`, `OjSearchResult`, `OjProviderHealth`, and `OjError` without publishing or hosting a modified copy.

## Local Boundary

- Run the provider through local stdio rather than a shared HTTP endpoint.
- Keep LeetCode sessions, CSRF tokens, source code, profiles, submissions, editorials, and Premium content on the local machine.
- Keep authentication, code execution, and submission disabled unless a local integration has an explicit confirmation flow.
- Credentials belong in VS Code SecretStorage. They must not appear in MCP arguments, logs, prompts, Webviews, or repository configuration.

## Upstream Installation

Run the audited upstream release directly:

```text
npx -y @jinzcdev/leetcode-mcp-server@1.3.0 --site global
```

The upstream tool names and response shapes are not the public OJ contract. Consumers must place a typed adapter between the upstream server and learning-workbench domain code.

## Platform Terms

LeetCode's terms restrict crawling and scraping. Keep this integration local, user initiated, low volume, and free of background catalog mirroring. This document describes an interoperability boundary, not endorsement or authorization by LeetCode.
