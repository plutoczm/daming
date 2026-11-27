# REA：T3 Code 与 HiFox 如何把「模型/供应商」接进 Agent

> 目的：弄清两家如何让 Claude Code / Codex / DSH 用上指定模型/供应商，用以修复 Daming 矩阵里“Agent 经网关”的接线。
> 来源：T3 Code（MIT，pingdotgg/t3code）文档/社区指南、HiFox 帮助文档与官网。2026-11-20 整理。

## 结论（一句话）
两家**都不重写 Agent**，而是把**已安装的 Agent CLI / Agent SDK 当 Runtime 启动**，再通过**该 Agent 自己的 env/配置**把 base_url + key + model 注入进去；凭证按 **BYOK 每家自己的 key / 或 CLI 已登录的订阅**，用**隔离的配置目录**（`CLAUDE_CONFIG_DIR` / `CODEX_HOME` 等）避免污染用户配置。

## T3 Code（agent-harness 控制面）
- **本质**：把 Codex/Claude/Cursor/Grok/OpenCode 等 **CLI 作为子进程启动**并渲染到一处；**它自己不是 harness**；“登录用 CLI（`claude auth login` / `codex login`），不是用 T3”。
- **接自定义模型/供应商的方式 = “provider instance（供应商实例）”**：一类**替代设置**，**把某个 CLI 指向一个 base URL**，并带**自己的隔离配置目录**，不替换原有 Max/ChatGPT 订阅实例。已知做法：
  - **Claude 实例**：设 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`，并用**独立 `CLAUDE_CONFIG_DIR`**；再加一条**自定义 model**。（QCode/Continuum 指南均如此）
  - **Codex 实例**：用 provider 配置把 Codex 指向该 base URL（`model_providers.<id>.base_url` + `wire_api` + `env_key`），隔离 `CODEX_HOME`。
- T3 自身**尚无**“任意 OpenAI 兼容 base URL”的一个字段（feature #4941 未合）；它是靠**per-instance 的 env/配置覆盖** + 隔离目录实现的。
- 要点：**一 CLI 一实例；实例=env(base_url/token)+隔离 config dir+model 列表；子进程运行。**

## HiFox（多人多 Agent 协作平台）
- **Runtime/机器**：任务派给 Agent → 组合“任务上下文 + Agent 配置” → 派发到**机器** → 机器上的**本地服务启动 Runtime（Claude Code / Codex…）** → Runtime 读写文件/跑命令 → 结果写回任务。
- **底层用 Claude Agent SDK（与 Claude Code 同框架）**。
- **模型接入 = BYOK**：Agent 配置里“**填你自己的 API Key，选模型**（Claude/GPT/MiniMax/GLM/Kimi…随时切换）”；HiFox 不转售模型，费用用户与厂商结算；**凭证存在 Agent/机器侧**，启动 Runtime 时注入。
- 要点：**Agent 保存 {指令/技能/代码库/Runtime/模型(含思考深度)/key}；机器本地服务用该配置拉起 Runtime。**

## 对 Daming 的直接启示（我们矩阵卡点的修法）
我们矩阵“qwen×claude 过、其余不过”，正是**没按“一实例一隔离配置 + 正确 env/config”**接线：
1. **Claude Code**：用 `CLAUDE_CONFIG_DIR`(隔离) + `ANTHROPIC_BASE_URL` + **`ANTHROPIC_AUTH_TOKEN`**（不是只 API_KEY）+ 自定义 model。→ 修 deepseek/workbuddy 超时。
2. **Codex**：用**隔离 `CODEX_HOME` 里写 config.toml**（`model_provider=daming`，`[model_providers.daming] base_url=<网关>/v1 wire_api=responses env_key=DAMING_GW_KEY`）+ `model=<model>`，再 `codex exec`；不要只靠命令行 `-c` 拼。
3. **DSH**：用**临时 `--patch`（不落盘、不改用户 profile）**把 provider baseURL 指到网关 + `agent-default-model` 指到目标 model。
4. 每个 Agent 用**各自隔离目录**，互不污染；凭证按依赖供应商（订阅/官方 API）注入。

这四点就是 T3/HiFox 做法的 Daming 版本，也是让整张“模型×Agent”矩阵跑通的关键。
