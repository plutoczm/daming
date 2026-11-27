# REA：Super-Agent / HiFox / T3 Code / Autoloop 的编队与产品体验

> 2026-11-21 调研整理。来源：DSH superagent prototype、Anthropic、LangChain、LLMCompiler、Magentic-One、HiFox 帮助中心/blog、T3 Code orchestration-v2、Autoloop reference、Magpie 截图与本地源码。
> 本文件用于指导 Daming 的「编队」「通知/远程」「供应商/Agent」页面，不复制第三方代码。

## 1. Super-Agent：双层 Router / Worker
- DSH `dsh-superagent-prototype` 把操作系统调度思想搬进 Agent：**Router 只做交互、分派、全局记忆，Worker 隔离上下文专注执行**；Router 用轻模型、Worker 用强模型。
- 主流拓扑：Subagents（主管把子 Agent 当工具）、Handoffs、Skills、Router、自定义 Workflow（LangGraph）。Anthropic 强调：可预测任务用 workflow；只有不可预测才上自治 agent。
- 选择子 Agent/模型看六元组：**能力标签 / 成本档 / 上下文 / 工具 / 绑定 / 回退**。
- 执行图：LLMCompiler Planner→TaskFetcher(就绪集)→并行 Executor；Magentic-One 用 Task Ledger + Progress Ledger 做重规划。
- 可落地 Daming：
  1. 编队默认“主 Agent 自动分派”，平台规则作为 fallback；Router 不另建任务状态。
  2. 子目标用 DAG/依赖表达；阶段串行、阶段内并行。
  3. 选择理由（能力/成本/绑定）必须展示，用户可一键改派。
  4. 验收三账本（事实/进度/报告）+ 独立验证，不信任子 Agent 自报。
  5. UI 只推“待审批/待回答/待验收/受阻”。

参考：<https://github.com/deepseek-ai/dsh-superagent-prototype>、<https://www.anthropic.com/engineering/building-effective-agents>、<https://arxiv.org/abs/2312.04511>、<https://ar5iv.labs.arxiv.org/html/2411.04468v1>

## 2. HiFox / T3 / Autoloop 的编队交互
- **HiFox 小队**：队长 Agent 先启动，再 @ 成员分工；成员有角色标签；任务/对话同一条上下文；小队专属 Agent 不进全局选择器。
- **T3 Code**：subagent tree 事件溯源；root turn 完成才算完成；子 Agent `delegate_task` 后唤醒父级；侧栏 thread 行显示 provider/model/branch/状态。
- **Autoloop**：三栏（Planner / Coder / Reviewer）+ 顶栏 status/iter/metric + push log；通知遵循“少打扰”：on_iter_ok 静默，只在 target_hit / regression×2 / reviewer_reject×2 / phase_error / stall / decision_needed 推送。
- UI 结论：**树/泳道 + 每节点一行（Agent 徽标 · 模型 pill · 状态点）+ 点开抽屉看执行/产物**；**自动分派（推荐）/我来指定**，技术词收进 tooltip；编队级收件箱只放需人处理的事。

参考：<https://help.hifox.com/docs/agent-and-computer/crews>、<https://hifox.com/blog/hifox-crews/>、<https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/README.md>、<https://github.com/Enderfga/claw-orchestrator/blob/7fdab221ea89973b6ccbdc2059b6b6b41d56d9c6/skills/references/autoloop.md>

## 3. 本次产品化调整
- 应用菜单：文件（新建窗口、新聊天、新项目、打开文件夹、关闭、退出）/ 编辑 / 视图（页面快捷切换 Ctrl+1…8）/ 窗口 / 帮助（帮助、设置、关于）。
- 左侧移除“本机工作空间”无用块；底部加设置/帮助。
- 项目只保留两种入口：**已有目录** 与 **上传 spec/plan_baseline**；plan_runtime/progress 由 Agent 维护。
- 供应商/Agent 去掉头像字母和长描述，改为紧凑卡片、状态 pill、模型 chips。
- 编队默认“主 Agent 自动分派（推荐）”，保留“平台规则分派”；显示每个子目标的 Agent/供应商/模型/理由，并可一键派发（已实测 DSH/Codex/Claude 全部分配）。
- 通知页加入“连接”引导：飞书/企微/微信/QQ 官方页面跳转 + 粘贴 Webhook + 保存并测试；远程链接可复制/检测。
- 平台状态参考 Magpie：读取本机 `~/.config/magpie/quotas.json`，展示 Codex 5h/7d、Kiro Credits、Qoder 等真实额度；移除 Codex 真实探针。
