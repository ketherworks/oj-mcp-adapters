# LeetCode Provider

LeetCode is an external, local-only provider. This public repository does not ship LeetCode source code, an npm package, a Worker, or a hosted MCP endpoint.

## Upstream

- Project: [`jinzcdev/leetcode-mcp-server`](https://github.com/jinzcdev/leetcode-mcp-server)
- Audited release: [`v1.3.0`](https://github.com/jinzcdev/leetcode-mcp-server/releases/tag/v1.3.0)
- License: [MIT](https://github.com/jinzcdev/leetcode-mcp-server/blob/v1.3.0/LICENSE)
- Transport: local stdio

The Student Autocomplete Lab integration uses a separately maintained local adapter. That adapter preserves the upstream copyright and license, pins the audited release, and maps the provider into the shared `OjCapabilities`, `OjProblemDocument`, `OjSearchResult`, `OjProviderHealth`, and `OjError` contracts.

## Public Boundary

- No public or shared LeetCode Worker is deployed.
- No LeetCode session, CSRF token, source code, private profile, submission, editorial, or Premium content is accepted by a public Kether Works endpoint.
- Authentication, code execution, and submission tools are disabled by default.
- The extension exposes only an allowlisted local tool surface and requires explicit confirmation before any real submission if that capability is enabled later.
- Credentials belong in VS Code SecretStorage. They must not appear in MCP arguments, logs, prompts, Webviews, or repository configuration.

## Upstream Installation

Users who do not have access to the separately maintained adapter can inspect or run the audited upstream release directly:

```text
npx -y @jinzcdev/leetcode-mcp-server@1.3.0 --site global
```

The upstream tool names and response shapes are not the public OJ contract. Consumers must place a typed adapter between the upstream server and learning-workbench domain code.

## Platform Terms

LeetCode's terms restrict crawling and scraping. Keep this integration local, user initiated, low volume, and free of background catalog mirroring. This document describes an interoperability boundary, not endorsement or authorization by LeetCode.
