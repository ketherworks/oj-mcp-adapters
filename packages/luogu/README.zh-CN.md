# 洛谷 MCP Server | Luogu MCP Server

[English](README.md)

把洛谷公开题目接入统一 OJ MCP 契约。可以搜索题目并读取题面、样例、限制、标签和来源信息。

## 快速开始

```json
{
  "servers": {
    "luogu": {
      "type": "http",
      "url": "https://api.ksrnyx.top/oj-mcp/luogu/mcp"
    }
  }
}
```

配置后可以直接说：

```text
在洛谷搜索五道适合入门的动态规划题。
获取洛谷 P1001 的题面和样例。
```

## 能做什么

| 工具 | 输出 | 上游访问 |
| --- | --- | --- |
| `oj_capabilities` | `oj.capabilities/v1` | 不访问上游 |
| `oj_health` | `oj.provider-health/v1` | 不访问上游；报告最近一次读取状态 |
| `oj_search_problems` | `oj.search-result/v1` | 一次匿名题目列表 GET |
| `oj_fetch_problem` | `oj.problem-document/v1` | 一次匿名题目页 GET |

全部工具都标注为只读、非破坏性和幂等。查询长度、分页、题号、响应体、数组数量和网络时间都有上限；返回结果会再次按统一 Schema 校验。

## 安全边界

适配器只构造 `https://www.luogu.com.cn` 下的地址，拒绝跨域响应，并使用 `credentials: "omit"` 发起 GET。它不接收或转发 Cookie、Authorization，也不提供资料、私有数据、运行或提交工具。

页面挑战、来源策略错误、结构漂移、限流、超时和不存在的题目都会映射为统一的 `oj.error/v1`。服务不会尝试绕过页面挑战。

## 运行方式

本地 stdio：

```json
{
  "mcpServers": {
    "luogu": {
      "command": "node",
      "args": ["C:/替换为实际路径/packages/luogu/dist/index.js"]
    }
  }
}
```

包内也包含 Cloudflare Worker 入口：`/mcp` 提供无状态 Streamable HTTP，`/healthz` 返回传输层信息。浏览器来源默认拒绝，只有 `LUOGU_MCP_ALLOWED_ORIGINS` 中明确列出的来源可以访问。

## 开发

```powershell
npm run build
npm test
```

夹具测试不会访问洛谷。测试覆盖页面规范化、边界、来源限制、结构漂移、挑战错误、MCP 调用和 Worker 传输。

## 上游审阅与归属

页面解析路线参考并审阅了 [Kaiserunix/luogu-mcp-server](https://github.com/Kaiserunix/luogu-mcp-server) 的 MIT 源码。当前包保留匿名题目列表和题面读取路线，并替换为统一 OJ Schema、严格运行时校验、结构化错误和完整 MCP 注解。

具体归属和上游许可证见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
