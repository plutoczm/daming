# REA：Autoloop / HiFox / T3 Code 如何让用户参与项目

> 2026-11-21 调研。切入点：多 Agent 系统里「人在哪、什么时候拍板、怎么被打扰、怎么接手产物」。
> 来源：Autoloop 参考文档（claw-orchestrator）、HiFox 帮助中心/博客（小队、收件箱、交接）、T3 Code 用户文档（permission modes）与 orchestration-v2 README。文末附链接。

## 一句话总结
- **Autoloop**：一个 **Planner** 当你的唯一对话人，只在「该你拍板 / 出问题」时通过 IM 找你；Coder / Reviewer 从不直接找你。
- **HiFox**：**任务为中心 + 个人收件箱**；把「需要你处理的事」按任务聚合成一个队列，交接停在「待验收」审阅门上等你。
- **T3 Code**：**permission modes 逐线程**控制「Agent 何时停下来问你」，批准可来自手机；thread / run / approval 全进执行图。

---

## 1. Autoloop（claw-orchestrator）
三角色：**Planner**（对话/策略，写 plan.md / goal.json）· **Coder**（改代码/跑 eval）· **Reviewer**（沙箱里独立审计，advance / hold / rollback）。
**关键：Coder、Reviewer 从不直接和用户说话**，观察到的一切都经 Planner 转述——Planner 决定什么值得上报、什么自己消化。

用户参与点：
- **设计期（和 Planner 一起定方案）**：`autoloop_chat` 和 Planner 对话读工作区、定 plan；你说「go」才 `spawn_subagents`（**只有明确批准后才启动子 Agent**）。
- **运行期（少打扰，例外才推）**：默认 push policy —— `on_iter_done_ok` **静默**；只有 `target_hit` / 指标回退×2 / Reviewer 驳回×2 / `phase_error` / 卡住 30min / `decision_needed` 才推。5 分钟去重防重复。
- **通道链**：wechat → whatsapp → email。`on_phase_error` 与 `on_decision_needed` **不允许被静默**（操作者生命线，试图静默会被记录）。
- **控制**：`pause_loop` / `resume_loop` / `terminate` / `reset_agent` / `update_push_policy`（你说「每轮都告诉我」即可改推送策略）。
- **审计**：`decisions.jsonl`（spawn/reset/compact/policy/terminate）+ `push_log.jsonl`（每次推送与所用渠道）。
- **局限**：单向推送（IM 回不进 Planner），要在 webchat / `autoloop_chat` 里回。

## 2. HiFox
以**任务**为协作中心：需求、验收标准、评论、附件、状态、处理人、Agent 执行记录都挂在任务上。

用户参与点：
- **收件箱（Inbox）**：个人通知中心，**按任务聚合**（一条任务一行，多事件用数量表示），分区 **全部 / 重要 / 其他 / 稍后 / 已清理**。「重要」= 执行异常、直接 @ 你、被指派。**只有人有人收件箱**。Agent 在任务对话里的「等你回复 / 等你审阅」不进收件箱，而在主侧栏「对话」；飞书 / Slack / 桌面横幅照常发。
- **评论 / @ / 对话**：在任务评论里 @ Agent、和 Agent 对话推进；讨论与执行留在同一条任务上下文里。
- **小队（Crews）**：任务派给小队后**先启动队长 Agent**，队长读任务 + 小队指令，决定自己干还是 @ 成员 Agent 分工，结果写回**同一个任务**；成员可含人类（多为表达团队组成与协作关系）。**人定方向、授权、验收**。
- **交接 / 审阅门**：Agent→人 的交接**停在「待验收 / 等审阅」**，任务状态改（待办 / 进行中 / 待验收 / 已完成）；人验收后再决定合并 / 发布 / 完成。**状态承接，不靠终端消息**。
- 自动化 / 分拣台：定时或事件触发唤醒、triage 分拣责任通知。

## 3. T3 Code
控制面；一个 server + 多客户端（桌面 / Web / 手机 / 远程）。

用户参与点：
- **Permission modes（逐线程）**：`Supervised`（命令和改文件都要你批）/ `Auto-accept edits`（自动批编辑，其他仍问）/ `Auto`（例行自动，其余问）/ `Full access`（不问）。消息框切换、按线程生效、可设默认、项目可覆盖；**可从手机批准下一条命令**。
- **执行图**：`thread` / `run`（用户可见的「轮」）/ `ExecutionNode`（tool、**approval**、subagent 都是节点）；**root run 完成才算这一轮完成**，子 Agent 完成不关父级。
- **subagent tree / delegate_task**：侧栏 thread 行显示 provider / model / branch / 状态；子 Agent 完成后唤醒父级。
- **Git 内建**：每个 thread 独立 worktree，看 diff、一键 commit / push / PR——用户在**产物层**参与审阅。
- fork / 换供应商 = 显式上下文交接（不是隐藏 prompt hack）。

---

## 横向对比

| 维度 | Autoloop | HiFox | T3 Code |
|---|---|---|---|
| 用户在哪参与 | 和 **Planner** 单点对话 | **任务** + **收件箱** | **thread** 里下指令 / 批权限 |
| 何时拍板 | 明确批准才 spawn；例外推送 | 收件箱「重要」+ 待验收审阅门 | permission mode 触发 approval / 手机批 |
| 打扰策略 | 例外才推、5min 去重、生命线不可静默 | 按任务聚合、重要/其他/稍后分区 | 按 mode 决定停不停 |
| 谁代表 Agent 找你 | **只有 Planner** | 队长 Agent / 任务评论 | 线程本身 |
| 审计 | decisions.jsonl + push_log | 任务活动 / 评论 / 状态 | 执行图事件溯源 + 原始 provider 帧 |
| 移动端 | IM 推送（单向） | 飞书/Slack/桌面横幅 | 手机批准 |
| 产物层参与 | git 每轮 commit + diff | 任务附件/评论 + diff | worktree diff / PR |

## 共性（三条可复用规律）
1. **单一对话人**：多 Agent 系统里，用户只和「一个入口」说话（Autoloop 的 Planner、HiFox 的队长/任务、T3 的 thread）；子 Agent 不直接骚扰用户。
2. **例外打扰**：默认静默，只有「阻塞 / 待拍板 / 失败 / 完成待验收」才找人；关键生命线（决策、错误）**禁止静默**，且去重。
3. **状态/审阅门承接交接**：把「轮到你」落成状态（待验收 / 待拍板）与结构化卡片，而不是终端消息；拍板结果可审计、幂等。

## 对大铭（Daming）的映射
**已有（已对齐）**：飞书决策卡（批准/暂停/验收，本人 open_id 校验、单次不可变、经唯一 Engine 写入、审计）≈ Autoloop 的 notify+Approve / HiFox 的待验收门 / T3 的 approval 节点；一次性 capability + 治理工具轮次；project 四件套；单一 Engine 写入。

**差距 / 可补（多数不改 spec，可作为 S8/S10 增强）**：
- **聚合收件箱**：把 Decision / 阻塞 / 待验收聚合成「只推需拍板」的列表（飞书卡是其外发通道）——对齐 HiFox 收件箱 + Autoloop push policy。
- **打扰策略可配**：默认静默、按事件级别推、5min 去重、「决策/错误不可静默」——直接照 Autoloop push policy。
- **单一对话人 / 队长**：主 Agent 作为用户唯一入口，子 Agent 不直连用户（对齐三家共性）。
- **permission modes**：把审批粒度做成「监督 / 自动批编辑 / 自动 / 全权」逐任务可调（对齐 T3）。
- **产物层审阅**：每任务 git worktree + diff / PR（对齐 T3 / HiFox）。

**需 spec 变更（须用户批准）**：小队 / Crew + SOP 接力、定时值守、移动/远程、Jira/TAPD/禅道迁移。

## 链接
- Autoloop：<https://raw.githubusercontent.com/Enderfga/claw-orchestrator/7fdab221ea89973b6ccbdc2059b6b6b41d56d9c6/skills/references/autoloop.md>
- HiFox 小队：<https://help.hifox.com/docs/agent-and-computer/crews>
- HiFox 收件箱：<https://help.hifox.com/docs/agent-and-computer/inbox>
- HiFox 收件箱 blog：<https://hifox.com/blog/ai-agent-inbox/>
- HiFox 交接（Agent↔人）：<https://hifox.com/blog/ai-agent-handoffs-agent-to-agent-and-agent-to-human-patterns/>
- T3 permission modes：<https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md>
- T3 orchestration-v2：<https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/README.md>
