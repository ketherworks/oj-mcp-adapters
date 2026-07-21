# AtCoder MCP Server

[English](README.md)

把 AtCoder 历史题目接入 MCP 客户端。按规范题目 URL 或比赛号/题号读取题面、样例、限制、清理后的 HTML 和来源信息。

## 快速开始

公共服务不需要 API Key：

```json
{
  "servers": {
    "atcoder": {
      "type": "http",
      "url": "https://api.ksrnyx.top/oj-mcp/atcoder/mcp"
    }
  }
}
```

配置后可以直接说：

```text
获取 AtCoder abc086_a 的题面、样例和限制。
```

## 能做什么

| 工具 | 用途 |
| --- | --- |
| `oj_capabilities` | 报告当前可用的 AtCoder 读取能力和传输方式。 |
| `oj_health` | 报告进程状态和最近一次上游读取结果。 |
| `oj_fetch_problem` | 按规范 URL 或比赛号/题号读取一道历史题目。 |
| `oj_search_problems` | 解析准确的题目 URL 或比赛号/题号。 |

`oj_fetch_problem` 支持 URL：

```json
{ "url": "https://atcoder.jp/contests/abc086/tasks/abc086_a?lang=ja" }
```

也支持结构化题号：

```json
{ "contestId": "abc086", "taskId": "abc086_a", "locale": "en" }
```

这里的“搜索”用于解析准确题号或 URL，不是模糊关键词检索。

## 使用范围

本项目用于历史题目练习。请勿在正在进行的 ABC、ARC 或 AGC 比赛中使用；AtCoder 当前的[生成式 AI 规则](https://info.atcoder.jp/entry/llm-rules)通常禁止这类使用。

适配器匿名读取 `atcoder.jp` 的规范 HTTPS 题目页，不接收账号凭据，不运行代码，也不提交答案。HTML、响应体、重定向和请求时间都有上限；遇到未知页面结构时返回 `upstream.schema_changed`，不会拼出不完整题面。

## 本地运行与开发

需要 Node.js 22 或更新版本。在本包目录运行：

```sh
npm start
npm test
npm run build
npm pack --dry-run --json
wrangler deploy --dry-run
```

夹具测试不会访问 AtCoder，也不会部署 Worker。

## 许可证

适配器源码使用 MIT 许可证。AtCoder 题目内容遵循 [AtCoder 使用条款](https://atcoder.jp/tos)。
