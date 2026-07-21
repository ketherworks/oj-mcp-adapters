# 算法刷题 MCP | Competitive Programming MCP

[English](README.md)

一组用于搜索和读取算法题目的 MCP Server，目前覆盖 Codeforces、AtCoder、洛谷和牛客。各平台可以独立使用，也可以通过同一套 OJ 数据结构接入学习工具。

## 直接使用

下面三个公共地址只提供匿名读取，不需要 API Key：

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
      "url": "https://api.ksrnyx.top/oj-mcp/luogu/mcp"
    }
  }
}
```

配置后可以直接说：

```text
在 Codeforces 找五道适合入门的 implementation 题。
获取 AtCoder abc086_a 的题面和样例。
在洛谷搜索动态规划练习题。
```

## 平台

| 平台 | 主要能力 | 运行方式 |
| --- | --- | --- |
| Codeforces | 使用官方 API 搜索题目与读取元数据 | 公共 HTTP 或本地 stdio |
| AtCoder | 精确查找历史题目并读取完整题面 | 公共 HTTP 或本地 stdio |
| 洛谷 | 搜索公开题目并读取题面 | 公共 HTTP 或本地 stdio |
| 牛客 / NowCoder | 搜题、题面、浏览器导入、资料、运行、提交与判题 | 本地 stdio |
| LeetCode Global/CN | 成熟上游 MCP 的本地接入说明 | 外部本地 stdio |

牛客的完整本地版本发布在 [牛客 MCP Server](https://github.com/ketherworks/nowcoder-mcp-server)。LeetCode 只提供经过审阅的上游接入说明，不在本仓库重新分发修改版源码，详见 [LeetCode 接入说明](docs/providers/leetcode.md)。

## 仓库结构

- `packages/contracts`：统一 OJ v1 类型、编解码器与 JSON Schema。
- `packages/server-common`：通用 MCP 结果和错误处理。
- `packages/codeforces`：Codeforces 官方 API 适配器。
- `packages/atcoder`：AtCoder 公开题面适配器。
- `packages/luogu`：洛谷公开搜索与题面适配器。
- `packages/nowcoder`：带登录态工作流的本地牛客适配器。
- `packages/node-http-host`：AtCoder 与洛谷公共服务使用的私有源站包装器。

每个平台都会如实报告自己的能力和健康状态。公共 HTTP 服务只处理匿名读取；登录态、源代码、平台运行与提交留在本地进程中。

## 本地开发

需要 Node.js 22 或更新版本。

```powershell
npm ci
npm run check
```

每个可部署包都有夹具测试、打包冒烟和部署检查。当前在线地址见 [生产端点](docs/deployment/production-endpoints.md)。

## 许可证

适配器源码使用 MIT 许可证。题面、平台名称和商标仍遵循各平台自己的条款。
