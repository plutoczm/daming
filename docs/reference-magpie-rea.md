# Magpie REA 分析（Reverse-Engineering Analysis）

> 对象：`D:\Projects\magpie`（Go，MIT，vendored 亦见 `services/damingd`）。运行实例：`magpie.exe`（端口 3425 网关 / `adminPort` Web）。配置目录：**`~/.config/magpie`**（`C:\Users\<user>\.config\magpie`，见 `internal/appdir/appdir.go`：`Config()=home/.config/magpie`）；日志在 `%LOCALAPPDATA%\magpie\logs`。
> 目的：彻底理解 Magpie，为「把它的功能（尤其签到）移植进 Daming、逐步剥离 Magpie」提供依据。

## 1. 它是什么（一句话）
Magpie 不是 Agent，而是 **模型供给 / 网关 / 路由 / 用量与缓存分析 / 账号·额度·签到 / 插件 / Agent 接入** 的**控制面**：一个本机 Go 程序，前面给各家 Agent 提供 OpenAI/Anthropic 兼容网关，后面管理你登录的订阅账号（Codex/Kiro/ZCode/WorkBuddy…）与额度，并做路由、缓存优化、用量统计、每日签到、插件扩展。

## 2. 代码结构（`internal/` 60+ 包，关键）
- **gateway**：OpenAI/Anthropic 兼容代理（`chat.go`/`anthropic.go`/streaming/`body_cap`/`middleware`/`billing_line`/`browser_tools`…）。
- **routes**：模型路由策略（`fastest.go`/`round.go`/`strategies.go`）。
- **catalog**：模型目录/家族/价格（`catalog.go`/`family.go`/`live.go`/`public.go`）。
- **provider**：最大包（~400 文件），各供应商账号/额度/模型/**签到**（见 §5）。
- **plugin / pluginrt**：插件运行时与插件市场（插件可自带 provider 与 `auth.checkin`）。
- **settings**：`settings.json` 与账号存储（`accounts.go`）。
- **usage / usageapi / stats**：逐请求 token/缓存记账（`usage.jsonl` → Usage 页的缓存命中、上下文构成分析）。
- **budget / gwbudget / gwmw**：预算/限流中间件。
- **agent / agentplug / agentenv**：把各 Agent 的配置写成“用 magpie 当 provider”（截图3 的“打开接入”）。
- **gui / tui / cli**：Web UI + `/api/*`、终端界面、`magpie <cmd>`。
- **davsync / backup / update / lastgood**：同步、备份、更新、坏文件自愈。

## 3. 数据文件（`~/.config/magpie`）
| 文件 | 作用 |
|---|---|
| `logins.json` | 内置登录（如 `codex`，含 `auth.tokens.{access,refresh,id}`）；插件账号只留 `plugin:<id>` 占位 |
| `plugin-auth.json` | **插件账号的 OAuth 凭据**（workbuddy / kiro / zcode…；键为 `provider` 或 `provider#suffix`，字段 `type/accountId/uid/access/refresh/expires…`） |
| `plugin-checkin.json` | 插件每日签到结果，键 `provider|signin`（`claimed/done/ineligible/inactive/failed/captcha/own-app`） |
| `workbuddy-checkin.json` | 内置 WorkBuddy 签到结果（键 `site|uid`） |
| `providers.json` | 供应商与模型清单（id/models/pickedFrom/contexts…） |
| `settings.json` | 开关（`WorkBuddyCheckin/PluginCheckins/CheckinOff…`）等 |
| `usage.jsonl` `quota-history.json` `credits-daily.json` `affinity.json` `routing/` | 用量明细、额度历史、每日积分、亲和路由等 |

## 4. 账号与鉴权
- **内置账号**：`logins.json`，带 oauth tokens（Codex = ChatGPT Team）。
- **插件账号**：`plugin-auth.json`，`type=oauth`，含 `access/refresh`（WorkBuddy 两个：小白 / `#tnpqwu` 小新；Kiro=Google social；ZCode=oauth）。
- 每账号有稳定 `uid`/`accountId`；插件账号在 `logins.json` 里只是占位（无秘密），真正凭据在 `plugin-auth.json`。

## 5. 签到机制（重点，供移植）
- **内置 WorkBuddy**（`internal/provider/workbuddy_checkin.go`）：
  1. `POST {site.api()}/v2/billing/meter/checkin-activity-status` → `{active, today_checked_in, streak_days, daily_credit, today_credit}`
  2. 若 `active && !today_checked_in` → `POST {site.api()}/v2/billing/meter/daily-checkin` → `{credit, streak_days, is_streak_day, message}`
  3. 按**北京日**（UTC+8）计一次；错误码 `1001`=已签 / `1002`=不合格 / `1003`=活动结束；**401 = 需 WorkBuddy 官方 App 的设备令牌（own-app）→ 转人工**。
- **插件签到**（`plugin_checkin.go`）：插件 `auth.checkin` 自签（WorkBuddy/Trae/MiniMax/Qoder 已迁插件），结果写 `plugin-checkin.json`（键 `provider|signin`）；开关 `PluginCheckinOn`（`settings.PluginCheckins`，未设则跟随内置开关）。
- **循环**（`KeepWorkBuddyCheckedIn`/`KeepPluginsCheckedIn`）：启动 2 分钟后首次，之后每 30 分钟、以及北京日切换时检查；失败按 `wbCheckinRetry(30m)`/离线指数退避重试（同一天内）。
- **原则（与大铭一致）**：每天一次、结果留痕、**验证码/官方 App 一律转人工不绕过**（`CheckinCaptcha`/`CheckinOwnApp`）、失败有退避、不重复签。

## 6. 网关 / 路由 / 用量（能力借鉴）
- **gateway**：同时暴露 OpenAI(`/v1/chat/completions`、`/v1/responses`)与 Anthropic(`/v1/messages`)兼容面；流式、请求体上限、middleware、计费行、工具注入。
- **routes**：按策略选模型/账号（最快/轮询/加权）。
- **catalog**：统一模型目录、家族、价格。
- **usage/usageapi**：逐请求记录 token 与缓存命中（`usage.jsonl`），生成截图里的“上下文构成 / 缓存命中率 / 每轮增长”分析。

## 7. Agent 接入（截图3）
`agent` 包 + 插件市场：把 Claude Code / Codex / DSH 等 Agent 的配置改成“用 magpie 作为 provider（`/v1/messages` 或 `/v1/responses`）”，并把模型列表作为 `magpie` 供应商暴露给 Agent。这跟我们 S10 的“统一 driver（DSH=ACP、Codex/Claude=CLI→Magpie）”是对齐的。

## 8. 对大铭的可复用点 & 剥离路线
1. **账号**：从 `logins.json + plugin-auth.json` 导入 Daming 自持加密库（**已实现**：`services/checkin-agent/src/magpie-import.ts`、`scripts/checkin-import-magpie.mjs`）。
2. **签到**：在 Daming 的 `platform.ts` 里为每个平台实现原生适配器。**WorkBuddy 先做**：用导入账号的 oauth token 打上面两个端点（`checkin-activity-status` → `daily-checkin`）；遇 401/设备令牌 → 转人工；`zcode/kiro` 依插件源码逐个移植。
3. **路由/目录/用量**：Daming 的 `agent-catalog`/`model-binding` 已有骨架，可借鉴 catalog/usage 的数据结构增强。
4. **注意**：插件 fetch 可能带签名/设备令牌，纯 token 不一定能签（尤其 WorkBuddy 401 场景）；**必须用真实账号验证**，验证码/own-app 一律转人工。

## 9. 你的实例现状（REA 观测）- 账号：`codex`(Team)、`plugin:kiro`(Google)、`plugin:workbuddy`×2(小白/小新)、`plugin:zcode`。
- `plugin-checkin.json`：2026-11-20 workbuddy 两个账号均已 `claimed`（credit 100，streak 12/11）；zcode 2026-11-19 `inactive`（无 gift plan）。
- 说明：**Magpie 已在正常做每日签到**；Daming 要做的是“用同一批账号自己签”。

## 10. 订阅账号供给边界（实证 2026-11-20）
- WorkBuddy `checkin-activity-status` 裸 Bearer → 200（可读 active/checked）；但 `get-user-resource-summary`(额度) 与聊天 → **403 `{code:10085 请求不合法}`**，需**官方 App 设备签名（X-Device-Token）**；Magpie 对 WorkBuddy 也走官方 App 那套（own-app），无法绕过。
- 结论：workbuddy/codex/kiro/zcode 这类**订阅账号的 chat/额度非纯 token 可自持**。Daming 自持供给的现实范围 = **官方 API（DeepSeek/OpenAI…）+ 本地（Ollama）**；订阅 chat/额度保持“可选（经 Magpie 或官方 App）”，不计入 M7 移除的硬阻塞（需在 spec 写明）。

## 11. 订阅自持更正（2026-11-20 实测，推翻 §10 结论）
- §10 的“非纯 token 可自持”是**用错主机 + 缺客户端头**所致。**正确做法（Magpie 插件 `opencode-workbuddy-auth` 的 `sign()`/`call()`）**：打 **`https://copilot.tencent.com`**，带 WorkBuddy 客户端头：`User-Agent: WorkBuddy/5.9.3`、`X-Product: SaaS`、`X-User-Id`、`X-Domain`、`X-IDE-Type/Name/Version`、`X-Agent-Intent/Purpose`、`X-Requested-With: XMLHttpRequest`（聊天再加 `X-Agent-Type: main`、`X-Agent-Runtime: local-agent`）。
- **实测（Win11，你的 workbuddy 账号）**：`checkin-activity-status` 200（active/checked/streak12）、`get-user-resource-summary` 200（额度 ≈441 credits）、`POST /v2/chat/completions` 200 SSE（内容 `OK`，usage 14/1）。→ **WorkBuddy 订阅账号 chat/额度/签到均可由 Daming 自持**。
- Daming 已实现：`services/checkin-agent/src/workbuddy.ts`（status/checkin/配额）、`workbuddy-plugin.ts`（订阅账号→网关 ProviderPlugin）、守护脚本同套头；证据 `docs/verification/s13-m2-wb-selfsupply-2026-11-20.json`。
- **环境注意**：学校 Linux(gdwyy70) 出口防火墙拒 `copilot.tencent.com`/`www.workbuddy.cn`（ECONNREFUSED/AggregateError）→ 该机网络受限，换可达网络或走代理隧道即可。Codex/Kiro/ZCode 各有私有 API，按同法逐个移植。
