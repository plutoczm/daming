# 执行链参考：T3 Code / HiFox / LoopForge / Autoloop（Daming 借鉴纪要）

> 目的：真实研读四个参考项目的执行链机制，落点到 Daming 的「执行链」模块（指挥官分派 → 子 Agent 执行 → 评审员按评测集审核 → 返工直到通过/额度耗尽 → 协作群讨论回传 → 关键节点通知）。仅概念级借鉴，不引入其整套平台，不把 SOP 当第二调度器。

## 1. T3 Code（Coding Agent 控制面）
- 不是 harness，而是控制面：把已安装 CLI（Claude Code / Codex / OpenCode / ACP）当子进程驱动；一 server 多客户端。
- 核心实体 project / thread / turn / message / providerSession（Effect Schema 事件溯源）；thread 内可切 provider/model 并交接；每 thread 独立 git worktree。
- 无自有 Agent 循环——起线程、跑 turn、调度、审批；给 Agent 工具 `delegate_task` 开子线程（subagent tree：root turn 完成才算完成，子完成后唤醒父级，父级需显式完成）。
- permission modes 可手机批准；供应商注入 = 一实例一 env（base_url + token）+ 隔离 config dir（CLAUDE_CONFIG_DIR / CODEX_HOME）+ model。

## 2. HiFox（任务为中心的多人多 Agent 协作空间）
- AI 时代 Jira/Linear：任务存需求/验收/评论/附件/状态/处理人/执行记录；可把任务直接派给 Agent（人 / Agent / 小队共用处理人）。
- Agent 是一等持久团队资产（指令 + 绑定 Skills + Runtime）；并行调度每任务独立 worktree。
- 收件箱只推需人拍板：完成待验收 / 阻塞提问 / 异常。
- Crew 小队 = 队长 Agent + 专长 Agent + 真人按 SOP 接力，关键卡点自动 @ 真人；通知飞书/钉钉/企微；BYOK/BYOA。

## 3. LoopForge（腾讯，MIT，self-hosted 交付工作台）与 Super-agent 编队
- LoopForge：Main Bot 聊天 → 开 Docker 沙箱 checkout 仓库 → 委派项目角色 → 开 PR；可把打法固化为 **LOOP**（agents + scripts + human gates 的可复用交付工作流）。
- LOOP = **有向依赖节点图**：节点类型 Agent / Script / Human gate / Sub-LOOP / Preview build；节点声明 artifacts + dependencies，依赖完成才启动。
- 人机门控：approve，或把工作 **send-back 到指定上游步骤**、retry、**rerun from any node**；单「Needs review」收件箱聚合所有等你审批的门。
- 角色分离：规划 / 实现 / 评审 / 测试各自独立 prompt + executor + model + rules + Skills + MCP；10+ CLI executor；token/cost 按公开价核算。
- Super-agent 编队：Router/Worker 双层；按能力标签/成本档/上下文/工具/绑定/回退六元组选子 Agent/模型；执行图 Planner→TaskFetcher→并行 Executor；子目标 DAG 依赖、阶段串行阶段内并行；**选择理由（能力/成本/绑定）必须展示且可一键改派**；验收三账本（事实/进度/报告）+ 独立验证不信任子 Agent 自报。

## 4. Autoloop（vendored 内核 packages/autoloop）
- 事件→规则→run→卡片→tick 闭环。`Rules{sources,agents,channels,rules,elsewhere,timezone,askFirst}`；`Rule{name,when:{source,types}|{cron},to,group,parallel?,emits?,channels?,tell:'always'|'needed'|'never'}`；`Agent{name,worker,use,model?,effort?,access:'read'|'edit'|'full'}`；`askFirst` 默认拦截敏感动作（删数据/停服/花钱/对外发消息/改产品方向/新建或轮换密钥/修改权限）。
- `kernel/decide.ts` 纯函数 `decide(view,input,now,env)→{facts,value}`：`ingest`（事件按 source+type 命中规则→每 (rule,lane=subject) 入队一个 run）→`claimNext`（按 worker/group parallel 限流）→`finish`/`applyReceipt`（done/failed/cancelled；failed→指数退避 `min(5min*2^(n-1),60min)`，MAX_ATTEMPTS=10）→`cards`（tell always/needed/never，fyi 静默）→`deliveries` 重发（RESEND_AT=[0,1,3,7,15,25,35,45,55]）→`answer`（卡片回答记 `card.answered` 续跑规则）→`tick`（cron + timers + sweep 掉线 worker）；MAX_HOPS=8 防事件循环。
- 借鉴：执行链沿用「事件闭环 + 卡片即人机接口 + 少打扰 tell + askFirst 敏感门 + 指数退避重试」；关键节点（reject×2 / blocked / budget_exhausted / passed）才推送，过程中间静默。

## 5. 落点映射（Daming 当前实现，2026-11-26）
| 能力 | 参考来源 | Daming 实现文件 |
| --- | --- | --- |
| 指挥官按能力/绑定/成本分配 | Super-agent 六元组 + HiFox Crew + 本仓 crew-planner | `apps/server/src/crew-planner.ts`（`costTierOf`/`chooseModel().costTier`/rationale 能力·绑定·成本） |
| 按评测集评审→返工直到通过/额度耗尽 | LoopForge human gate + Autoloop tell | `apps/server/src/pipeline.ts`（`reviewArtifacts`/`runPipeline`） |
| 从任一阶段换 Agent/模型重跑 | LoopForge rerun-from-any-node | `apps/server/src/pipeline.ts`（`runPipelineFrom`/`reassignPipelineStep`）+ `apps/server/src/pipeline-runs.ts`（`PipelineRunStore`/`reassignAndRerun`/`rerunPipelineStage`） |
| 协作群讨论回传 | T3 thread 内交接 + HiFox 小队 | `apps/server/src/pipeline-runs.ts`（`syncPipelineRoom`/`attachRoomDiscussions`）+ `apps/server/src/agent-room.ts` |
| 关键节点少打扰通知 + 审批收件箱 | HiFox 收件箱 + Autoloop tell/askFirst | `apps/server/src/http.ts`（pipeline 路由）+ `apps/web/src/UnifiedInbox.tsx` |
| 前端留存运行/换人重跑/成本·讨论展示 | LoopForge 节点抽象 + HiFox 任务卡 | `apps/web/src/PipelinePanel.tsx` |

## 6. 边界（诚实声明）
- 默认执行链运行在**离线 `demoExecutor`** 上：不注入真实 Agent 执行器、不做真实供应商计费、不改写任何 Agent 配置文件；真实效果须待 REQ-011/治理门放开后经 `gateway.executor` 落地。
- Host 仍是唯一任务状态写者；执行链运行记录（pipeline-runs.json）是执行链自有存档，不构成第二套调度状态机。不改 spec。

## 7. 真实模式（2026-11-26 追加，用户 m00471 批准）
- **评审 + 讨论接真实模型**：新增 `apps/server/src/pipeline-real.ts`。`gatewayTextPort({baseUrl,model})` 通过 Daming 自托管 gateway `POST /v1/chat/completions`（OpenAI 兼容）取真实文本；`makeModelExecutor` 用真实模型产出该步交付正文；`makeModelReviewer` 先校验交付物存在，再让模型只回 PASS/FAIL（异常→`review_model_error`），**不再依赖离线 json_equals 假对象**；`makeModelDiscussion` 让各角色真实发言（失败回退 fixture，不丢消息）；`createRealPipelineRuntime(port,goal)` 组合成 `{executor,review,discussion}`。
- **步骤可接真实执行器**：内核 `pipeline.ts` 的 `PipelineExecutor`/`PipelineReviewFn` 支持返回 `Promise`，`runPipeline`/`runPipelineFrom`/`simulatePipeline` 改 async；`pipeline-runs.ts` 的 `createAndRunPipeline`/`reassignAndRerun`/`rerunPipelineStage`/`syncPipelineRoom` 改 async 并接受可选 `runtime`（缺省仍 `demoExecutor`）。真实执行器接入点仍是既有 `TaskCoordinator`（`auto` 审批 + `workflow.real` tool + ledger 限额兜底），经治理门。
- **fail-closed**：`apps/server/src/http.ts` 的 `pipelineRealRuntime(goal)` 在 gateway 未 running → `409 pipeline_real_gateway_not_running`、无可用模型 → `409 pipeline_real_model_not_configured`；`/api/pipeline/run` 接受 `runtime:'real'`，重跑按记录 `executorKind` 复用真实 runtime；**绝不静默降级**。
- 契约：`PipelineRunView` 增 `executor?:'offline'|'real'`、`reviewerKind?:'contract'|'model'`（与既有 `reviewer:{agent,checks}` 区分）。前端 `PipelinePanel` 增「执行模式」下拉与「真实模型/模型评审」Pill。
- **诚实边界**：本机未在「供应商」配置并启动 gateway 时真实模式返回 409 而非假装成功；真实模型仍经 Daming 自托管 gateway，不改任何 Agent 配置文件、不直接改供应商计费/OS 权限，Host 仍唯一写者、无第二调度状态机，符合 REQ-011 治理门，不改 spec。
