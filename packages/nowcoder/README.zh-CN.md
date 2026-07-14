# NowCoder MCP Server

[English](README.md)

把牛客 ACM 题库与登录态工作流直接接进 VS Code Agent：本地运行、类型化输出、开箱即用。

## 快速开始

```bash
git clone https://github.com/ketherworks/nowcoder-oj-mcp.git
cd nowcoder-oj-mcp
npm ci
npm run build
```

在 VS Code 中运行 **MCP: Open User Configuration**，加入以下配置：

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "nowcoder-cookie",
      "description": "牛客 Cookie 请求头的完整值",
      "password": true
    }
  ],
  "servers": {
    "nowcoder": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/替换为实际路径/nowcoder-oj-mcp/packages/nowcoder/dist/index.js"],
      "env": {
        "NOWCODER_SESSION_COOKIE": "${input:nowcoder-cookie}",
        "COMPETITIVE_COMPANION_PORT": "10043"
      }
    }
  }
}
```

运行 **MCP: List Servers** 启动服务。VS Code 只会询问一次 Cookie，并安全保存输入。只读取公开题目时，可以删掉 Cookie 输入与 `NOWCODER_SESSION_COOKIE`；浏览器导题端口可以继续保留。

直接对 Agent 说：

```text
在牛客搜索「二分图」，返回前 10 题。
导入牛客题目 NC218144。
打开牛客浏览器导题窗口。
读取我的牛客竞赛资料和最近 20 次提交。
用 main.cpp 在牛客运行第一个样例。
为 main.cpp 生成提交预览。
```

浏览器导题：安装 [Competitive Companion](https://github.com/jmerle/competitive-companion)，把自定义端口设为 `10043`；调用 `oj_open_import_window` 后点击题目页左上角绿色加号，再调用 `oj_complete_import`。接收到一题后监听器立即关闭。

## 现有工具

- `oj_capabilities`：发现当前传输方式、认证模式、操作风险与语言支持。
- `oj_health`：根据适配器真实活动报告传输层和解析器健康状态。
- `oj_fetch_problem`：把官方题目页转换为类型化 `OjProblemDocument`，包含题面、限制、样例、标签、来源和哈希。
- `oj_search_problems`：按关键词搜索官方 ACM 题库，支持游标分页和每页数量限制。
- `oj_open_import_window`：在本机打开最长 60 秒的一次性 Competitive Companion 接收窗口。
- `oj_complete_import`：收取浏览器发送的题目、样例与限制，返回类型化导题预览。
- `oj_fetch_profile`：按数字 ID 读取紧凑竞赛画像；配置登录态后可直接读取当前账号。
- `oj_list_submissions`：分页读取判定、题目、语言、耗时、内存、代码长度和提交时间，不读取代码正文。
- `oj_platform_run`：经确认后把不可变代码快照上传到牛客，对一个样例执行平台自测。
- `oj_prepare_submission`：校验账号、题目、语言、文件哈希和代码大小，生成两分钟有效的提交预览，不产生提交。
- `oj_commit_submission`：展示 MCP 原生确认框；用户接受后获取短期 token，并且只提交一次。
- `oj_poll_submission`：轮询本进程创建的提交，返回判题状态和标准化 verdict，不会重新提交。
- `nowcoder_auth_status`：验证本地登录态，只返回脱敏状态。

## 提交流程

1. 调用 `oj_prepare_submission`，检查平台、账号、题号、语言、文件、字节数与 SHA-256。
2. 调用 `oj_commit_submission`，VS Code 会显示确认框。
3. 接受后产生一次真实提交；用 `oj_poll_submission` 查看判题结果。

确认被拒绝或取消时提交数为零。提交请求发生网络超时且结果无法确定时返回 `outcome_unknown`，不会自动重试。

## 题目 ID

可以传完整地址，也可以用短 ID：

```text
NC218144       -> https://ac.nowcoder.com/acm/problem/218144
11244/A        -> https://ac.nowcoder.com/acm/contest/11244/A
```

## 登录

先在浏览器登录牛客，打开开发者工具，找到一条发往 `ac.nowcoder.com` 的请求，把 Request Headers 中 `Cookie` 的完整值填入 VS Code 提示框。会话轮换后重启 MCP 服务即可。

Cookie 只在进程启动时读取，只会附加到通过校验的牛客目标，并且不会出现在 MCP 输出中。遇到重定向时，目标必须先通过白名单检查，才会收到后续认证请求。

## 安全边界

- 只使用本地 stdio 传输。
- 精确 HTTPS 主机与路径白名单、DNS 公网地址校验、TLS 地址固定。
- 请求共享 10 秒截止时间；响应上限 2 MiB；Cookie 上限 16 KiB；重定向次数受限。
- 工具契约中没有 Cookie 字段；错误和登录状态均脱敏。
- Cookie、CSRF token 与短期 judge token 不进入工具输出、日志或提交预览。
- 每次真实提交都需要单独确认；平台自测也会在上传源码前确认。
- 遇到反爬挑战时返回 `challenge.required`，由用户在浏览器完成验证。

## 开发

```bash
npm run typecheck:test --workspace @kaiserunix/nowcoder-mcp-server
npm test --workspace @kaiserunix/nowcoder-mcp-server
npm run pack:check --workspace @kaiserunix/nowcoder-mcp-server
```

测试只使用合成会话、静态页面夹具和本机回环 TLS 服务。
