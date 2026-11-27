# REA：Magpie 最新版「供应商 / Agent / LLM 切换」→ Daming 平台化；附 HiFox/T3/Autoloop 是否纯 CLI

> 2026-11-21 调研。目标：把「添加供应商 / 添加 Agent / 切换 LLM」做成 **Daming 平台功能**（网页/桌面可操作，不依赖 Magpie 桌面 App），并确认 Daming 是否应放弃“桌面端 Agent”。

## 一、Magpie 最新版怎么做（官方文档 2026-10/11 + GitHub yetone/magpie）
一句话：**“所有 Agent 的模型，集中一处”**——本机网关（`127.0.0.1:3425`，同时兼容 OpenAI/Anthropic/Gemini 三协议互转）+ 菜单栏 App + **完整 CLI/TUI**。核心对象四件：
1. **供应商（Provider）**：登录订阅 / 粘贴 API Key / 填任意兼容 URL。每个模型记作 `provider/model`。
2. **Agent**：Claude Code / Codex / Gemini CLI / OpenCode… 一个一行，显示它当前用的模型。
3. **网关**：Agent 指向的本地地址；请求转给持有该模型的供应商，配额耗尽自动换账号/供应商。
4. **路由组（group）**：把多个模型/账号合成 `group/<id>`，一个额度用完换下一个；另有 **Profiles**（把全部 Agent 配置存成一个名字，一键整体切换）。

关键操作（均可在 App 或 CLI）：
- **添加供应商**：App「供应商」页 `＋添加供应商` → 选卡片/登录订阅/填兼容 URL。CLI：`magpie provider add ...`。
- **给每个 Agent 选模型（切换 LLM）**：点 Agent 的模型，选一个 → **magpie 原子地改写该 Agent 自己的配置文件**（保留注释/顺序/格式）。CLI：`magpie <agent> <provider/model>`、`magpie <agent> group/<id>`、`magpie group add "<name>" models=... routing=order`。
- **Profile 批量切换**：`Budget`/`Focus` 一键切换全部 Agent 的模型。
- **隐私脱敏**：请求出本机前把密钥/token 掩码，回复再还原。

**本质**：供应商 = 兼容 Base + Key + Model（或订阅登录）；切换 = 改写对应 Agent 的配置指向；Daming 侧已有同构底座（见三）。

## 二、HiFox / T3 Code / Autoloop 是不是“只用 CLI 干活”？（结论：是）
- **T3 Code**：定位就是**“屏幕/控制面”，不是 harness**。它把 Codex/Claude/Cursor/OpenCode 等 **CLI 当子进程**起，事件溯源编排；桌面端只是 **Electron shell**，手机是 RN 客户端。官方 FAQ：Claude Code = 屏幕(终端/桌面 Code 页) + 底层 harness(Anthropic Agent SDK)；T3 **只做屏幕**。
- **HiFox**：四个角色 Task/Agent/Computer/Runtime，其中 Runtime = 机器上装的具体 **CLI 工具**（Claude Code/Codex…）。「电脑」是执行宿主，机器上一个**本地服务**连出、探测 Runtime、拉起所选 **CLI**、进度流回任务；模型用量走工具里已配的订阅/API Key（BYOK）。个人机用桌面客户端连、远程用 HiFox CLI——**桌面只是客户端/宿主入口，真正干活是 CLI Runtime**。
- **Autoloop**：后端迭代循环（Planner/Coder/Reviewer），**每个角色都是 spawn 的 claude CLI 子会话**；Reviewer 在沙箱目录跑，Planner 通过 IM 推你。**没有桌面 Agent，纯 CLI 子进程 + 通知**。

**判定**：三家的“Agent 工作”都是 **CLI / Agent-SDK 子进程**；桌面端/手机端只是 **UI 或执行宿主客户端**，不是“桌面 Agent 在思考”。→ **Daming 不需要“桌面端 Agent”**；应保持“控制面 + 本机 CLI/ACP driver + 自持 headless 网关”，仅把 UI 作为壳。这与 Daming 现状一致（统一 driver：DSH=ACP、Codex/Claude=CLI；已弃 Docker 默认真实执行；S13 已自持网关、Magpie 降为可选）。**结论：Daming 不依赖 Magpie 桌面 App / 桌面 Agent，继续走 headless CLI。**

## 三、Daming 现状 vs 目标（三能力的差距）
| 能力 | Daming 已有 | 差距（本次要做） |
|---|---|---|
| **添加供应商** | `services/daming-gateway` 配置驱动多协议（`openai-completions`/`openai-responses`/`anthropic-messages`，`baseUrl+apiKeyEnv+models`），CLI `daming-provider add/list`，配置 `config/providers.json` | 无 **平台 UI/API** 让用户在 App 内新增/删除供应商并持久化到 Daming 自有配置 |
| **添加 Agent** | 固定 3 个 Harness（dsh/codex/claude-code）+ `model-binding` 绑定 | 无 **持久化 Agent 档案**（自定义名字/指令/runtime/模型）与增删；Agent 不是一等对象 |
| **切换 LLM** | `POST /api/model-binding/bind` 已可“改用所选模型”，AgentsPanel 有按钮 | 基本可用；补“Agent 档案级切换”和更顺的入口 |

## 四、平台化设计（本次落地）
- **供应商**：Daming 自有 `ProviderStore`（`host/platform/providers.json`，格式与 `config/providers.example.json` 一致：`{defaultModel, providers:[{id,api,baseUrl,models,apiKeyEnv,headers?,weight?}]}`）。Host API：`GET/POST/DELETE /api/platform/providers`。密钥只存 **env 变量名**（`apiKeyEnv`），不存明文；`daming-gateway-serve` 用 `DAMING_GATEWAY_PROVIDERS_FILE` 指向该文件即可加载。
- **Agent**：`AgentProfileStore`（`host/platform/agents.json`）：`{agentId,name,runtime(dsh|codex|claude-code),providerId?,modelId?,instructions?,createdAt}`。Host API：`GET/POST/DELETE /api/platform/agents`。Agent 成为一等对象，可复用。
- **切换 LLM**：`POST /api/platform/agents/model {agentId,providerId,modelId}` 更新该 Agent 当前模型；底层复用既有绑定/注入。
- **UI**：供应商页 `＋添加供应商`（id/api/baseUrl/models/apiKeyEnv）；Agent 页 `＋添加 Agent`（agentId/name/runtime/选供应商+模型）；每行“切换模型”。
- **原则**：供应商=配置（兼容端点）或插件（非标，如 Kiro/Codex WS）；Agent=CLI Runtime；模型=绑定。**不为每个供应商写私有代码**；**不用桌面 Agent**。

## 五、边界
- 供应商“订阅登录”类（需 OAuth/设备签名）不走纯 API Key：仍按 S13 结论，订阅 chat/额度“可选（经 Magpie/官方 App）”，Daming 自持范围 = 官方 API + 本地模型 + 已移植的订阅插件（WorkBuddy/Codex relay）。
- 路由组/Profile（批量切换）为后续增强；本次先做“单供应商/单 Agent/单模型切换”的平台化骨架。

## 参考
- Magpie 快速上手：<https://github.com/yetone/magpie/blob/8f0d21a009d0f0cb6d73e30898e0ed60453e1e4a/site/public/docs/zh/start.html>
- Magpie 概览：<https://landscape.jimmysong.io/zh/projects/magpie/>
- T3 Code 架构（控制面/CLI 子进程）：<https://zread.ai/pingdotgg/t3code/6-architecture-overview>
- HiFox 电脑（执行宿主+CLI Runtime）：<https://hifox.com/blog/hifox-computers/>
- Autoloop（Planner/Coder/Reviewer CLI 子会话）：`skills/references/autoloop.md`（claw-orchestrator）
