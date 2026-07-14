# NowCoder MCP Server

[简体中文](README.zh-CN.md)

Bring NowCoder ACM problems and login-aware workflows directly into VS Code agents through a typed local MCP server.

## Quick Start

```bash
git clone https://github.com/ketherworks/nowcoder-oj-mcp.git
cd nowcoder-oj-mcp
npm ci
npm run build
```

Open **MCP: Open User Configuration** in VS Code and add:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "nowcoder-cookie",
      "description": "NowCoder Cookie request-header value",
      "password": true
    }
  ],
  "servers": {
    "nowcoder": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/path/to/nowcoder-oj-mcp/packages/nowcoder/dist/index.js"],
      "env": {
        "NOWCODER_SESSION_COOKIE": "${input:nowcoder-cookie}",
        "COMPETITIVE_COMPANION_PORT": "10043"
      }
    }
  }
}
```

Start the server from **MCP: List Servers**. VS Code prompts for the Cookie once and stores the input securely. For public reads, remove the Cookie input and `NOWCODER_SESSION_COOKIE`; the browser-import port can stay.

Try these prompts:

```text
Search NowCoder for "binary graph" and return the first 10 problems.
Import NowCoder problem NC218144.
Open a NowCoder browser-import window.
Read my NowCoder competition profile and latest 20 submissions.
Run the first sample for main.cpp on NowCoder.
Prepare main.cpp for submission.
```

For browser import, install [Competitive Companion](https://github.com/jmerle/competitive-companion), set its custom port to `10043`, call `oj_open_import_window`, click the green plus on the problem page, then call `oj_complete_import`. The listener closes after one problem.

## Tools

- `oj_capabilities`: discovers the active transport, authentication mode, operation risk, and language support.
- `oj_health`: reports transport and parser health from real adapter activity.
- `oj_fetch_problem`: converts an official problem page into a typed `OjProblemDocument` with statement, limits, samples, tags, provenance, and hashes.
- `oj_search_problems`: searches the official ACM catalog by keyword with bounded cursor pagination.
- `oj_open_import_window`: opens a one-shot Competitive Companion receiver on loopback for up to 60 seconds.
- `oj_complete_import`: receives the browser task, samples, and limits as a typed import preview.
- `oj_fetch_profile`: reads a compact competition profile by numeric ID, or resolves the signed-in account.
- `oj_list_submissions`: pages through verdict, problem, language, time, memory, code length, and submission time without reading source code.
- `oj_platform_run`: uploads an immutable code artifact after confirmation and runs one sample on NowCoder.
- `oj_prepare_submission`: validates account, problem, language, file hash, and code size, then creates a two-minute preview without submitting.
- `oj_commit_submission`: shows an MCP-native confirmation form, obtains a fresh short-lived token, and submits exactly once after acceptance.
- `oj_poll_submission`: polls a submission created by this process and never resubmits it.
- `nowcoder_auth_status`: validates the local session and returns a redacted login state.

## Submission Flow

1. Call `oj_prepare_submission` and inspect the platform, account, problem, language, file, byte count, and SHA-256.
2. Call `oj_commit_submission`; VS Code displays the confirmation form.
3. Accept to create one real submission, then call `oj_poll_submission` for the verdict.

Declining or cancelling creates no submission. An ambiguous network timeout returns `outcome_unknown` and is never retried automatically.

## Problem IDs

Use a URL or one of the compact IDs below:

```text
NC218144       -> https://ac.nowcoder.com/acm/problem/218144
11244/A        -> https://ac.nowcoder.com/acm/contest/11244/A
```

## Login

Sign in to NowCoder in a browser, inspect a request to `ac.nowcoder.com`, and use its complete `Cookie` request-header value when VS Code prompts. Restart the MCP server after rotating the session.

The Cookie is read once at process startup, attached only to validated NowCoder destinations, and never returned through MCP output. Redirect targets are checked before a follow-up request receives authentication.

## Security

- Local stdio transport only.
- Exact HTTPS host and path allowlists, public-IP DNS validation, and TLS address pinning.
- Shared 10-second request deadline, 2 MiB response limit, 16 KiB Cookie limit, and bounded redirects.
- Strict tool schemas with no Cookie field; redacted errors and authentication status.
- Cookie, CSRF token, and short-lived judge token never enter tool output, logs, or submission previews.
- Every real submission requires a fresh confirmation; platform self-test also confirms before uploading code.
- Anti-bot challenges are surfaced as `challenge.required` for the user to complete in a browser.

## Development

```bash
npm run typecheck:test --workspace @kaiserunix/nowcoder-mcp-server
npm test --workspace @kaiserunix/nowcoder-mcp-server
npm run pack:check --workspace @kaiserunix/nowcoder-mcp-server
```

Tests use synthetic sessions, static fixtures, and loopback-only TLS servers.
