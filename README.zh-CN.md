# 算法刷题 MCP | Competitive Programming MCP

[English](README.md)

把 Codeforces、AtCoder、洛谷和牛客接入支持 MCP 的编辑器或 Agent。查题和读题面可以直接连接公共服务；牛客的浏览器导题、个人资料、运行和确认提交在本地进程中完成。

## 选择平台

| 平台 | 适合做什么 | 使用方式 |
| --- | --- | --- |
| [Codeforces](https://github.com/ketherworks/codeforces-mcp-server) | 按标题、题号、难度和标签搜索官方题目元数据 | 公共 HTTP |
| [AtCoder](https://github.com/ketherworks/atcoder-mcp-server) | 按题号或 URL 读取历史题目的题面、样例和限制 | 公共 HTTP |
| [洛谷](https://github.com/Kaiserunix/luogu-mcp-server) | 搜题、读取题面和题单、寻找相关练习 | 公共 HTTP 或本地 npm |
| [牛客](https://github.com/ketherworks/nowcoder-mcp-server) | 搜题、浏览器导题、资料、运行、提交预览和确认提交 | 本地 stdio |
| LeetCode 国服/国际服 | 通过统一 OJ 契约接入经过审阅的成熟上游实现 | [本地接入说明](docs/providers/leetcode.md) |

只需要一个平台时，直接进入对应的独立仓库即可。本仓库主要保存统一契约、平台适配器、测试和发布工具。

## 快速开始

### 公共查题服务

在 MCP 配置中保留自己需要的平台：

```json
{
  "servers": {
    "codeforces": {
      "type": "http",
      "url": "https://codeforces-oj-mcp.lantangtang54.workers.dev/mcp"
    },
    "atcoder": {
      "type": "http",
      "url": "https://api.ksrnyx.top/oj-mcp/atcoder/mcp"
    },
    "luogu": {
      "type": "http",
      "url": "https://luogu-mcp-server.lantangtang54.workers.dev/mcp"
    }
  }
}
```

这些地址只处理匿名读取，不需要 API Key 或 OJ 账号。

### 牛客账号操作

按 [牛客 MCP Server 快速开始](https://github.com/ketherworks/nowcoder-mcp-server#快速开始) 在本机运行服务。登录态和源码只进入本地 stdio 进程；每次真实提交都要重新确认。

## 可以直接这样问

```text
在 Codeforces 找五道适合入门的 implementation 题。
获取 AtCoder abc086_a 的题面和样例。
在洛谷搜索动态规划练习题。
导入牛客 NC218144，并为已保存的 main.cpp 生成提交预览。
```

## 统一契约

仓库内的平台使用同一套类型化 OJ v1 契约报告能力和健康状态。题目、搜索结果、错误、运行预览和提交证据都会保留平台来源与时间。

公共 HTTP 服务只开放匿名读取。登录态、源码、平台运行和提交留在本地进程中。

## 仓库结构

- `packages/contracts`：统一 OJ v1 类型、编解码器和 JSON Schema。
- `packages/server-common`：通用 MCP 结果与错误处理。
- `packages/codeforces`、`packages/atcoder`、`packages/luogu`、`packages/nowcoder`：平台实现。
- `packages/node-http-host`：公共只读适配器使用的 HTTP 宿主。
- `scripts/export-standalone.mjs`：生成各平台的独立仓库。

## 开发

需要 Node.js 22 或更新版本。

```powershell
npm ci
npm run check
```

当前部署地址和验证记录见 [生产端点](docs/deployment/production-endpoints.md)。

## 许可证

适配器源码使用 MIT 许可证。题面、平台名称和商标仍遵循各平台自己的条款。
