# REA：HiFox / T3 Code 的“供应商可随时添加”模型 → Daming 落地

> 目标：解决 Daming「新增供应商（ZCode/Kiro…）要写定制代码」的障碍，做成“随时可加”。

## 两家怎么做（结论）
- **HiFox**：底层 Claude Agent SDK + 运行时 CLI；模型侧是 **BYOK**——"填你自己的 API Key、选模型（Claude/GPT/GLM/Kimi/MiniMax…随时切换）"，费用用户与厂商结算；**凭证存 Agent/机器侧**。即：供应商=**OpenAI/Anthropic 兼容端点 + key + model**。
- **T3 Code**：agent-harness 控制面，**把 CLI 当子进程**；自定义模型通过 **provider instance**（`ANTHROPIC_BASE_URL`+`ANTHROPIC_AUTH_TOKEN` / `model_providers.<id>.base_url`+`wire_api`+`env_key` + 隔离配置目录）注入。即：**兼容端点由 base URL + key 配置**，非标由 CLI 原生支持。
- 共同点：**不为每个供应商写私有实现**；“模型供应商”= **兼容 Base+Key+Model（配置）**；“Agent/CLI（Codex/Claude/Kiro…）”= **Runtime（驱动 CLI）**。

## Daming 落地（本次实现）
- 供应商层做成**配置驱动多线协议**（`services/daming-gateway`）：
  - `ProviderConfig.api`：`openai-completions` | `openai-responses` | `anthropic-messages`；
  - `baseUrl` + `apiKeyEnv`（`apiKeyHeader`: authorization(Bearer) 或 x-api-key）+ `models` + `headers` + `weight`；
  - `pluginsFromConfig` 按 `api` 选择插件：`openAICompatiblePlugin` / `openAIResponsesPlugin` / `anthropicCompatiblePlugin`（把 OpenAI 请求翻译成对应线协议，再翻译回）。
- **何时用插件而非配置**：ZCode/DeepSeek/GLM/Kimi/Qwen/OpenAI/Anthropic 等**兼容端点**→纯配置即可（ZCode 就是 `anthropic-messages`）；**Kiro(AWS EventStream 二进制)/Codex(WebSocket)** 等**非标**→写一个插件（如 `services/codex-relay` 的 WS、或 Kiro 的 eventstream 适配器）。
- 使用：
  - 配置文件 `config/providers.json`（样例 `config/providers.example.json`），`daming-gateway-serve` 用 `DAMING_GATEWAY_PROVIDERS_FILE` 指向它；
  - CLI `daming-provider add <id> --api anthropic-messages --base <url> --models a,b --key-env ENV`（随时添加/更新），`daming-provider list`。

## 结论
- 把“供应商”从“要写代码”降为“**加一条配置**”（兼容端点）或“**装一个插件**”（非标）。这就是 HiFox/T3 让供应商可随时切换的本质。
- Kiro/ZCode 的障碍随之拆解：**ZCode=配置即插（anthropic 线）**；**Kiro=非标插件**（AWS eventstream，源码在 Magpie provider 未单列、需单独适配）。
