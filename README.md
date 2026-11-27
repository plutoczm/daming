# 大铭 Daming

面向 **Windows 11 的本地多 Agent 治理与协作平台**。用户用自然语言（可附一份 **spec 大纲 + plan 文档**）提出目标；平台拆解任务、按真实能力选择 **DSH / Codex / Claude Code** 执行者、在花钱和危险操作前卡预算与授权、用独立证据验收，并把结果、费用、决策理由与审计记录给用户看。

## 当前状态（截至 2026-11-18）

- **已落地**：单一 Engine + SQLite 事务/审计/Outbox；治理内核（现金预留、一次性授权、未知结果保留与人工核对）；三类执行器 Fixture 与 Codex/DSH 真实只读受治理任务；本机认证 HTTP + React 任务板（Lancer 风格流程画布、SSE、审批/审计/费用）；内置 Magpie Go headless 网关与安全管理；Lulu Connector；Autoloop 内核；身份/租户/MFA 与 BYOA 密钥；原生 Agent Linux 容器隔离（进行中）。
- **进行中**：首版原生 Agent 真实交付（A–F：A1/B1 完成；B2/C1/C2 部分；D/E/F 未开始）。
- **未完成门槛**：权威账单核销与单请求现金硬上限未达成，**生产付费派工默认关闭**；Claude Code 生产 Adapter、DSH/Claude 协议出口、飞书真实收发、Task 7 Linux 签到、Task 8 安装包尚未完成。
- 产品形态、能力与边界以本 README 与代码为准。

## 工程校验

在项目根目录执行 `pnpm check`（test + typecheck + check:boundaries）；构建 Web 前端用 `pnpm build:web`。

## 开发环境

- Node.js **>=24.18.0 <25**
- pnpm **11.25.0**
- TypeScript **5.9.3**、@types/node **24.19.2**（锁文件固定）
- 可选 Python 工具环境：`D:/Anaconda3/envs/daming/python.exe`（3.12）；Node 主控不依赖 Conda 激活。

在项目根目录（Windows PowerShell / cmd）：

```sh
pnpm install --frozen-lockfile
pnpm check        # test + typecheck + check:boundaries
```

也可分别执行 `pnpm test`、`pnpm typecheck`、`pnpm check:boundaries`。

本地密钥放在项目根目录 `.env`（已被 `.gitignore` 忽略），参考 [`.env.example`](.env.example)：填入 `DEEPSEEK_API_KEY` 后可运行 `pnpm probe:dsh`；`DAMING_CODEX_EXE` / `DAMING_CODEX_MODEL` / `DAMING_CODEX_OFFICIAL` 控制真实 Codex Worker；`DAMING_DSH_EXE` / `DAMING_DSH_ENTRY` 控制真实 DSH Worker。离线测试不需要模型账号；Electron 安装包尚未实施。

## 运行入口（部分）

```sh
pnpm start                 # 本机 Host + 内置网关
pnpm start:web             # 本机认证任务板（打印带 token 的 127.0.0.1 链接）
pnpm build:web             # 构建 Web
pnpm test:web:browser      # 真实 Chrome 任务板/SSE 端到端（离线 fixture）
pnpm gateway:configure     # 本机窗口录入 DeepSeek key
pnpm probe:dsh / probe:magpie / probe:isolation
pnpm demo:task / demo:workflow / demo:governance / demo:model-gateway / demo:codex-protocol / demo:codex-process
```

## 工程结构

| 路径 | 职责 |
| --- | --- |
| packages/core | 无 Node 依赖的 Engine、状态迁移、领域与仓库契约 |
| packages/ports | Host 依赖的边界接口，type-only 依赖 core |
| packages/contracts | 网页可读取的公开 DTO |
| packages/source-protocol | 从 Autoloop 适配的事件/回执校验与时区 cron |
| packages/session-contracts | 从 Lancer 复用的会话、用量、运行时与交接契约 |
| packages/store-sqlite | SQLite 事务、审计查询与持久化 Outbox |
| packages/planning | DAG 就绪选择、冻结契约入口与有界历史监督 |
| packages/auditor | 独立验收公开入口与可信证据评估 |
| packages/governance | 现金预留、一次性操作授权与 Tool Gateway |
| packages/workers | Worker 注册、能力路由与离线协议解析 |
| packages/worker-process | 固定子进程 stdio/生命周期与 Codex/DSH 执行适配 |
| packages/model-gateway | 只读发现、fixture 回归与内置 Go 网关私有客户端 |
| packages/connectors-lulu | Lulu 只读健康/能力与签名授权提交客户端 |
| packages/autoloop | Autoloop 事件→规则→run→Agent→卡片→tick 内核（vendored） |
| apps/server | Host 装配、独占锁、账本、本机 HTTP/认证/路由、受治理模型与 Agent 调度 |
| apps/web | React/Vite 任务板 + Lancer light-ui 动画；只使用公开 contracts |
| services/damingd | 内置 Daming Go 网关（vendored 自 yetone/magpie 的精简 nogui 源码，仅保留供应商/账号/模型路由/网关；随大铭启动，无需外部 Magpie） |
| services/model-gateway-go | 历史单发送 Go 分支（¥5 烟测证据保留） |
| scripts | 测试发现、TypeScript AST 架构检查、演示与验收脚本 |

任务状态机只属于 core 的 Engine；source-protocol 与 session-contracts 不会独立调度任务。安装与测试不依赖 `D:/Projects/lancer` 或 `D:/Projects/agent-autoloop` 存在。

## 许可

- 第三方许可与来源：[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)、[licenses/upstream-reuse.json](licenses/upstream-reuse.json)

大铭自有代码的开源许可尚未由创建者决定；复用的第三方 MIT 源码保留各自许可证。
