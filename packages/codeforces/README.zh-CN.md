# Codeforces MCP Server

[English](README.md)

把 Codeforces 官方公开的题目元数据接入 MCP 客户端。可以按题名、题号、难度和标签搜索练习题，也可以读取指定题目的完整元数据。

## 快速开始

```json
{
  "servers": {
    "codeforces": {
      "type": "http",
      "url": "https://codeforces-oj-mcp.lantangtang54.workers.dev/mcp"
    }
  }
}
```

配置后可以直接说：

```text
在 Codeforces 找五道适合入门、标签为 implementation 的题。
读取 Codeforces 71/A 的官方元数据。
```

## 能做什么

| 工具 | 用途 |
| --- | --- |
| `oj_capabilities` | 报告当前可用的 Codeforces 读取能力和传输方式。 |
| `oj_health` | 报告服务状态和最近一次官方 API 读取结果。 |
| `oj_search_problems` | 按题名、题号、难度或标签搜索官方题库。 |
| `codeforces_get_problem_metadata` | 按平台题号读取一道题的官方元数据。 |

搜索使用统一的 `oj.search-request/v1` 请求结构，支持 `requestId`、`platform: "codeforces"`、`query` 和 `limit`。题目标识通常写成 `contestId/index`，例如 `71/A`。

## 服务实现

数据来自 Codeforces 官方 API。响应会先经过结构校验，再做规范化和缓存；API 返回 `FAILED`、无效 JSON 或结构漂移时不会写入缓存。

Cloudflare Worker 在 `/mcp` 提供无状态 Streamable HTTP，`/healthz` 用于存活检查。请求体、队列和缓存分片都有上限；服务过载时返回 HTTP 429。浏览器来源默认拒绝，只有 `CODEFORCES_MCP_ALLOWED_ORIGINS` 中列出的来源可以访问。

该适配器不读取登录态，不运行代码，也不提交答案。

## 开发

需要 Node.js 22 或更新版本。

```text
npm run build
npm test
npm run typecheck
npm run test:pack
npm run deploy:cf:dry-run
npm start
```

发布包由 Linux CI 构建，以保留 CLI 可执行权限。Windows 可用于本地构建、测试和打包冒烟。
