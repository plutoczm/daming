# 参考对照：T3 Code 与 HiFox（用于大铭对齐）

> 目的：弄清 T3 Code 与 HiFox 各自的形态与机制，映射到大铭（Windows 本地、多 Agent 治理与协作平台）应借鉴什么、怎么落地。
> 来源：T3 Code README / 公开文档（github.com/pingdotgg/t3code，MIT）；HiFox 官网与帮助文档（hifox.com / help.hifox.com）。2026-11-19 整理。

## 一、T3 Code = 「Coding Agent 的开源控制面（control plane）」

一句话：**把 Agent 跑在你自己的机器上，给它们一个统一界面；桌面发起、手机批准。**

关键事实/机制：
- **不卖 token**：驱动你已登录的 Claude Code / Codex / Cursor / OpenCode / ACP 等 Agent，用自己的订阅。
- **一个 server + 多客户端**：桌面/Web/手机看到同一批 **threads**（对话线程）；远程可用（LAN / Tailscale / T3 Connect）。
- **一个线程里可换模型、可交接**：Claude 可以把任务交给 Codex（thread 内切换 provider/model）。
- **Git 内建**：每个 thread 可跑在**独立 worktree**，看 diff，一键 commit / push / PR。
- **架构（pnpm workspace）**：`apps/server(t3)` = 核心执行运行时 + CLI（编排、provider 驱动、VCS、auth、HTTP/WS 面）；`apps/web` = React+Vite UI；`packages/contracts` = **Effect Schema 定义的事件溯源编排模型**（project / thread / message / turn / providerSession）。协议无 wire spec，由 contracts 的 schema 定义。
- **关键设计**：T3 本身**没有自己的 Agent 循环**——它负责“起线程/跑 turn/调度/审批”，给 Agent 工具去“再开子线程（delegate_task）”；子任务完成会唤醒父级（subagent tree）。授权体系是 **permission modes**（如 full-access / 逐命令批准），可从手机批准下一条命令。

## 二、HiFox = 「多人与多 Agent 的协作空间（AI 时代的 Jira/Linear）」

一句话：**任务即中心；像把活派给同事一样，把任务直接派给 Agent；人和多个 Agent 在同一块看板上协作。**

关键事实/机制：
- **任务为中心**：需求、验收标准、评论、附件、状态、处理人、Agent 执行记录都围绕任务保存。
- **指派给 Agent**：处理人入口人/Agent/小队共用；执行中团队从看板看进展/阻塞/结果，需补充信息或人工审阅时任务回到人。
- **Agent 是一等对象**：持久保存的团队配置（指令 + 绑定技能 Skills + Runtime），全员可反复指派、共同打磨、沉淀为组织资产。
- **并行调度**：多任务同时派，各 Agent 在**独立 worktree** 并行、互不覆盖；侧栏+看板实时状态；**收件箱**只推需要你拍板的事（完成待验收/阻塞提问/异常）。
- **项目管理**：需求池/Sprint/Epic/View/Triage；自定义任务类型/字段/状态；Jira/TAPD/禅道 20+ 平台迁移或双向同步。
- **BYOA & BYOK**：接入 20+ Runtime（Claude Code/Codex/Cursor/Gemini CLI…），用你自己的 API Key / Coding Plan，无平台差价；可随时切换 Runtime。
- **BYOC**：把本地/团队/云机器纳管成 7×24 Agent 工位（Win/Mac/Linux/Docker），代码与命令都在你受控机器内跑。
- **自动化**：定时 + 事件触发唤醒 Agent/小队；每次运行留执行留痕。
- **Crew 小队**：队长 Agent + 专长 Agent + 真人按 SOP 分工接力，关键卡点自动 @ 真人。
- **通知进 IM**：飞书 / 钉钉 / 企业微信。

## 三、对照表：大铭 vs T3 Code vs HiFox

| 维度 | T3 Code（控制面） | HiFox（协作面） | 大铭现状 | 差距/可借鉴 |
|---|---|---|---|---|
| 核心实体 | project / **thread / turn** / message / providerSession | **任务**（含验收/评论/处理人/执行记录）/ Agent / 小队 | Task / Plan / Decision / Assignment（Engine 事件溯源） | 引入**线程/轮次(thread/turn)** 与**Agent 一等对象** |
| 执行器 | provider drivers + ACP | 20+ Runtime（BYOA） | DSH / Codex / Claude Adapter（S6） | 已对齐；可补 ACP |
| 模型供给 | 用你的订阅，可 thread 内换模型/交接 | BYOK/BYOA，可切 Runtime | 模型目录 + 绑定 + 注入（S5） | 已有；补“任务内换模型/交接” |
| 隔离 | 每 thread 独立 worktree | 每任务独立 worktree | 每次尝试 Docker 容器 + /work tmpfs | 可加**每任务 git worktree** 提升 diff/PR 体验 |
| 审批/人机 | permission modes，手机批准 | 收件箱，需拍板才打扰 | 一次性 capability + 治理工具轮次 + **飞书决策卡**（S10） | 飞书卡≈收件箱；补“聚合收件箱” |
| 通知 | 手机推送 | 飞书/钉钉/企微 | 飞书长连接（S10 已真跑） | 已有；扩成任务级通知 |
| 多端/远程 | 桌面/Web/手机/远程 | 桌面/移动 | 本机 Web（S8）+ 未来 Electron（S12） | 手机/远程不在 spec 首批 |
| 自动化 | 无自有循环，给工具起子线程 | 定时/事件触发 | 治理工具轮次内核（S10） | 可补“定时/事件唤醒” |
| 协作多 Agent | subagent tree / delegate | Crew 小队 / SOP | 单项目单 Agent 指派 | 可补 Agent 小队/接力 |

## 四、结论：大铭 = T3 的执行控制面 + HiFox 的协作看板（我们已具备大半骨架）

大铭的定位与两家高度重合，且我们已有更硬的“治理”底座（现金硬限额、一次性授权、单一 Engine 写入、Docker 隔离、飞书本人决策）。要“按他们那样搞”，建议按下面顺序补齐**形态层**（不动 spec 的硬约束）：

### 立即可做（不改 spec 验收，纯增强）
1. **Agent 一等对象**：新增 `AgentProfile { id, name, instructions, skills[], runtime(DSH/Codex/Claude), modelBinding }`，持久化、可复用、可共享。→ 对应 HiFox 的“Agent 是团队资产”、T3 的 provider+model 绑定。
2. **thread / turn 模型**：把每个 Task 的 Agent 会话落成 `thread`（多轮 `turn`，事件溯源）。→ 对应 T3。
3. **收件箱（Inbox）**：把 Decision/阻塞/待验收聚合成一个“只推需要拍板的事”的列表；飞书卡即其外发通道。→ 对应 HiFox 收件箱。
4. **任务级独立 git worktree**：每次尝试在独立 worktree 里执行，产出可 diff、可一键 PR。→ 对应 T3/HiFox。

### 需要 spec 变更（必须你批准，我不能自行改 spec）
5. **Agent 小队 / Crew + SOP 接力**（队长→开发→测试，关键卡点 @ 真人）。
6. **定时/事件触发自动值守**（7×24）。
7. **移动/远程访问**（T3 的手机批准、远程控制）。
8. **Jira/TAPD/禅道 迁移或双向同步**。

> 注：上述 5–8 会改变 `docs/spec.md` 的范围与验收，属需求变更，须用户批准后我再改 spec/plan 并实现。1–4 可在现有 spec 内作为 S8/S10 的增强推进。

## 五、与当前进度的衔接
- S10 已打通：三 Agent 真实模型轮、飞书本人决策（批准/暂停/验收）、DSH/Claude 真实写交付、现金核销（DeepSeek 余额差额）。Codex 真实写已达成（workspace-write 经 Magpie 中继），shell 命令受 Windows/镜像限制尚未干净通过。
- 下一步若采纳本方案：优先做 1–4（尤其 1 Agent 一等对象 + 3 收件箱），把 S8 的任务板升级成“HiFox 式看板 + T3 式线程”，再评估 5–8 的 spec 变更。

## 六、Agent 接入方式（关键：都是 CLI / 协议层，不是桌面端）

**结论：T3 Code 和 HiFox 都不“集成桌面端 App”，而是"一个 Agent 一个 driver，起它的 CLI / 走协议"。桌面、Web、手机只是控制它们的 UI 客户端。**

### T3 Code 的三种传输（一 Agent 一 driver）
| 类型 | 做法 | 例子 |
|---|---|---|
| CLI stream-json | 启动用户 CLI，说它的行分隔 JSON | `claude -p --input-format stream-json --output-format stream-json` |
| 私有 JSON 协议 | 各厂商自己的 JSON/HTTP 模式，各写一个 driver | `codex app-server`（stdio）、`pi --mode rpc`、`opencode serve`（HTTP） |
| ACP（Agent Client Protocol） | 通用协议，v2 预览 / v1 兼容；Registry 或本地命令 | `claude-agent-acp`、**`dsh --profile acp`**（T3 文档原文示例） |

- T3 明确**不是 harness**，它驱动 harness（Claude Code = TUI + Anthropic Agent SDK；Codex = app + App Server）。官方比喻：**T3 是餐厅，让你自带厨房(harness)**。
- ACP Registry 的 Agent 装在 `tools/<agent-id>/<version>/`，**跑在 T3 server 所在机器**；签名走 Agent 自己的 store；模型/权限来自 ACP。
- 所以 T3 的“接入”= 在本机起这些 CLI/ACP 进程并翻译事件，不依赖任何桌面 App 常驻。

### HiFox 的接入（BYOC：本地服务 + 已装 CLI Runtime）
四概念：**Task（共享记录）/ Agent（保存的工作配置：指令+Skills+仓库+运行设置）/ Computer（执行宿主）/ Runtime（Computer 上检测到的 CLI 工具，如 Claude Code、Codex）**。
- 每台机器跑一个**轻量本地服务，主动向外连（outbound，无需入站端口）**：检测已安装 Runtime → 接收排队任务 → 准备任务目录 → **启动所选 Runtime（CLI）** → 进度流回任务。
- 个人电脑用 **HiFox 桌面客户端**（= UI + 本地服务宿主）；远程主机用 **HiFox CLI + 一次性安装令牌**。
- HiFox 不自带模型、不替代 Claude Code/Codex：**模型用量走工具里已配的订阅 / API Key**；Runtime 可一键安装在机器上。

### 对大铭的结论（我们已经是同一路子）
- 大铭的 `packages/worker-process` 已经在做“一 Agent 一 driver 起 CLI”：`native-dsh-session`（DSH）、`native-codex-session`（`codex app-server` stdio）、`native-claude-session`（claude-agent-sdk）。**这与 T3/HiFox 的接入模型一致**，方向正确。
- “按他们那样搞”的具体增量（属 S6 Adapter 增强，不改 spec）：
  1. **统一 driver 接口**：`spawn(executable,args) → 事件流 → 归一 turn/usage/approval`，抽象成「CLI-stream-json / private-protocol / ACP」三选一。
  2. **新增 ACP 驱动**：DSH 首选 `dsh --profile acp`（T3 官方示例），Codex/Claude 亦可用各自 ACP 包装（`claude-agent-acp`）；我们已有 `@deepseek-ai/dsh-acp` 包可直接用。**✅ 已完成**：`packages/worker-process/src/native-dsh-acp-session.ts`，实测 `dsh --profile acp` 文本 `OK` + 工具写 `dsh-acp-ok` 均通过（证据 `.cache/verification/s10-dsh-acp.json`）。
  3. **Computer/Runtime 抽象**：把“执行主机 + 已装 Runtime 探测 + 并发/工作目录/超时”落成一等对象（对应 HiFox Computer / T3 environment）。
  4. **本地服务 outbound 连接**（远程/多机时）：无需入站端口，符合我们“本机主控 + 受限辅助”的定位。
- 一句话：接入层不要做“桌面端自动化”，做 **“driver + CLI/ACP”**；UI 只是客户端。这样 DSH/Codex/Claude 与未来的 Pi/OpenCode 都能同一套接入。

## 七、已采用：统一 Agent driver（主机运行，不用 Docker）

按用户决策，大铭的执行接入统一为 **「一个 driver 接口 + 主机进程 + 各走原生最佳接口」**（与 T3/HiFox 一致，**不再用 Docker 跑真实 Agent**；Docker 仅保留为可选隔离模式，默认关闭）。

统一入口：`runAgent(agent, {cwd, prompt, ...})`（`packages/worker-process/src/agent-driver.ts`），命令行 `node scripts/agent-run.mjs --agent dsh|codex|claude --prompt "..."`。

| Agent | 传输（原生最佳） | 命令 | 鉴权 |
|---|---|---|---|
| DSH | **ACP** | `dsh --profile acp`（stdio JSON-RPC） | 本机 DSH profile |
| Codex | CLI stream-json | `codex exec --json` | `~/.codex`（ChatGPT 订阅） |
| Claude | CLI | `claude -p --output-format text`（`claude.exe`） | `ANTHROPIC_BASE_URL/KEY` 可指向 Magpie |

三端各跑一发“Reply OK”均 `completed`：`dsh` 走 ACP、`codex` 走 exec、`claude` 走 CLI→Magpie。证据 `docs/verification/s10-unified-agent-driver-2026-11-19.json`；tsc 0、边界 193。
- 说明：Codex/Claude 用各自 CLI 的非交互模式即 T3 所谓 “CLI stream-json” 传输；DSH 原生就是 ACP。**统一发生在 driver 接口与 thread/task 模型，而非强行单协议**——这正是 T3/HiFox 的真实做法。
- Docker 路径（`project-runtime-isolation`）仅作“需要强隔离时”的可选后端，不作为日常执行默认。

### 接线与清理（2026-11-19）
- 派工链接线：新增 `HostAgentWorker`（`WorkerSession`→`runAgent`），`board-fixture` 的 `createRealDsh/CodexCoordinator` 改走统一 host driver，并新增 `createRealClaudeCoordinator`。`TaskCoordinator` real 派工 dsh/codex/claude 三端 `completed`（`docs/verification/s10-unified-dispatch-2026-11-19.json`）。
- 清理：删除无用的 Docker 容器运行时（`project-runtime-isolation`/`-egress`/`-workspace` 及其测试）、无用 `adapters/{dsh,codex,claude-code}` 桩、被统一入口取代的一次性 smoke 脚本。回归：测试 470/468/0/2、tsc 0、边界 188。桌面端（S12）未动。
