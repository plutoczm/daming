# Magpie → Daming 移植状态总表（REA 主导）

> 结论：Magpie 的核心运行能力已移植/由 Daming 自持并有真实证据；剩余 relay 因**外部账号/源码限制**不具备"迁移即可跑通"的条件（列于末尾）。

## 已移植 / 已自持（含证据）
| Magpie 能力 | Daming 实现 | 真实证据 |
|---|---|---|
| **Codex WebSocket relay（codexrelay）** | `services/codex-relay`（TS，encode/parseFrames+codexWsTurn；手写 WS over CONNECT 代理，零依赖）；插件 `examples/plugins/codex-provider` | 握手101→output_text.delta→completed 2.3s；矩阵 10/10；`s13-m7-codexrelay-port-2026-11-20.json` |
| 插件市场/管理 | `plugin-framework` listPlugins/installPlugin/setPluginEnabled/removePlugin + CLI `daming-plugin` | 列 5 插件；manager 4 测试；`s13-plugin-manager-2026-11-20.json` |
| 账号扫描 | `services/accounts` scanAccounts + CLI `daming-accounts list` | 真实 9 账号；`s13-accounts-2026-11-20.json` |
| 额度刷新 | `services/accounts/src/quota.ts` readQuotas + CLI `daming-accounts quota` | WorkBuddy 310/491 credits；`s13-quota-2026-11-20.json` |
| Web UI | 网关 `/admin` + `/api/accounts` + `/api/plugins` | 快照 Accounts9/Plugins5；`admin-sample-2026-11-20.html`、`s13-admin-webui-2026-11-20.json` |
| 网关（OpenAI/Anthropic 兼容） | `services/daming-gateway`（chat/responses/messages/models，流式/鉴权） | `s13-m1-gateway`、矩阵 10/10 |
| 供给（官方API+本地+订阅插件） | config 驱动 + 插件；Ollama/DeepSeek/WorkBuddy/Codex | `s13-m1-multiprovider`、`s13-m1-config-supply`、`s13-m2-wb-selfsupply` |
| 路由（加权/熔断/failover） | ProviderRegistry WRR + 健康熔断 | `s13-m3-failover` |
| 缓存/用量/上下文构成 | `/api/usage/summary`+`/dashboard`+composition | `s13-m4-dashboard` |
| 签到 | WorkBuddy 适配器（status/checkin/quota）+ 学校 Linux 守护 | `s13-m2-linux-workbuddy` |
| Agent 接入 | onboarding 生成 DSH/Codex/Claude 配置 + 统一 driver | `s13-m6-agent-onboarding` |

## 未移植（外部/复杂度限制，非未实现判断）
| 项 | 原因 |
|---|---|
| **Kiro relay** | Magpie provider 内**无 GenerateAssistantResponse 实现**（全库 grep 无），Kiro 聊天疑由插件/不透明路径提供；无可直接迁移源码。 |
| **ZCode relay** | Daming 插件**实现正确、鉴权通过**，但该账号 **429/1113「余额不足/无可用资源包」**（Magpie 同账号亦如此）；有额度即出真实回复。 |
| **Antigravity relay** | provider/gateway 代码量大（Google OAuth/cloudcode/cloak，测试 ~28KB），且**当前无该账号**；非"迁移即可跑通"。 |
| **官网** | 「官网」非运行时能力（属产品官网/文档），Daming 侧价值由 `/admin` 面板与文档承载；如指特定站点功能需另行明确。 |

## 结论
- 目标中的**优先项（codexrelay 让 Codex 订阅脱离 Magpie 并由 Daming 自持经网关跑通）已完成**（矩阵 10/10）。
- 其余可低成本移植项（账号、插件市场、Web UI、额度）均已完成并留证据。
- 剩余 relay/官网均为**外部限制或非运行时能力**；如后续在 Kiro/ZCode/Antigravity 账号与源码（或额度）就绪，可按本仓 `reference-magpie-codexrelay-rea.md` 的同一 WS/HTTP 中继范式继续扩展。
