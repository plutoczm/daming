# REA + 移植记录：Magpie codexrelay → Daming 自持

> 目标：把 Magpie 的 Codex 订阅中继移植进 Daming，摆脱对 Magpie 的运行时依赖。
> 源码：`internal/codexrelay/relay.go`（外壳）+ `internal/gateway/codex_socket.go`（核心 WS 中继）。

## Magpie 架构
- `codexrelay` 只在 Magpie 退出时临时占端口，把 Codex 已开的 WS 连接转给 `gateway.CodexRelay`；**真正的协议在 `gateway/codex_socket.go`**。
- ChatGPT/Codex 的 Responses 请求不是普通 HTTP，而是 **WebSocket**：
  - URL：`wss://chatgpt.com/backend-api/codex/responses`
  - 握手头：`Authorization: Bearer <access>`、`chatgpt-account-id`、`originator: codex_cli_rs`、`version`、`user-agent: codex_cli_rs/<ver>`、`OpenAI-Beta: responses_websockets=2026-02-06`
  - 客户端发**一条文本帧**：`{"type":"response.create", ...Responses 请求体...}`（`codexCreate`）
  - 服务端回**多条文本帧**，每条是 Responses 事件 JSON：`response.created` / `response.output_text.delta` / `response.completed`(含 usage)…；`responsesapi.websocket_timing` 丢弃；`response.completed/failed/error` 结束。

## Daming 移植（已完成，零第三方依赖）
- 实现：`examples/plugins/codex-provider/index.mjs`
  - 手写 WebSocket **over HTTP CONNECT 代理**（`net`+`tls`+`crypto`），经 `127.0.0.1:7890` 隧道到 `chatgpt.com:443`，完成 RFC6455 握手（客户端帧加掩码、处理 ping/pong/close），发送 `response.create`，解析事件帧累计 `output_text.delta`，遇 `response.completed` 结束并取 usage。
  - token/account 来自 `env CODEX_ACCESS/CODEX_ACCOUNT_ID`（回退 `~/.config/magpie/logins.json`）；**不再引用 Magpie/3425**。
- 实测：握手 `101` → `response.output_text.delta:"OK"` → `response.completed`，**2275ms**；`gpt-6.2-sol` 后端直接接受（无需别名映射）。
- 矩阵：**10/10**，其中 `gpt-6.2-sol × codex/dsh` 走 **Daming 自持 WS**（非 Magpie relay）。
- 证据：`docs/verification/s13-m7-codexrelay-port-2026-11-20.json`；探针 `scripts/codex-ws-probe.mjs`。

## 仍需移植的 Magpie 能力（后续）
1. 其他订阅 relay：Kiro(AWS EventStream 二进制帧)、ZCode(Anthropic 兼容)、Antigravity。
2. 账号扫描/登录态读取、额度刷新。
3. 插件市场/安装更新。
4. Web UI（Magpie GUI 的能力界面）。
5. 说明：网关/路由/用量/签到/插件框架 Daming 已有自持实现（本会话早前完成）。
