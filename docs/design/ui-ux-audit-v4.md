# UI/UX 审查报告 v4（Impeccable）— 2026-11-22

> 范围：`apps/web` 全部页面 + 任务详情（执行图）+ 编队页 + 全局实时层与对话框。
> 方法：Impeccable 结构化审查（改版前）→ 修复（落到令牌/组件）→ 改版后复验（Vercel 工程与无障碍清单）。
> 证据：改版前 `.cache/ui-v3-*.png`（v3 基线）与 `.cache/ui-v4/*.png`（13 张，含 `desktop-execution-graph-attributed.png`）；机器可读结果 `docs/verification/ui-redesign-v4.json`（48 项检查）。

## 结论摘要
v3 解决了"模板味"，v4 解决"真实感与可操作性"：任务详情过去只有一条"执行者 → 主控 → 结果"的示意图（且首次加载会把历史 Assignment 全部补播一遍动画），编队页则是"生成方案 + 派发按钮"，派发结果只存在 React 状态里、刷新即丢。v4 把两者都换成 Host 持久化记录的只读投影，并把 8 个业务面板接进同一条事件失效链。

## 改版前问题（含证据）
| id | 位置 | 现象 | 严重度 |
| --- | --- | --- | --- |
| A1 | `App.tsx` FlowCanvas | 执行视图只映射"步骤/Worker/产物"，没有供应商/模型/工具/验收/编队上下文；`light.emit` 对首屏历史 Assignment 也 emit（打开抽屉会重播历史动画） | P0 |
| A2 | `CrewPanel.tsx` | 派发结果只存 `useState`，刷新即丢；历史方案无法还原父任务→子任务树；没有进度/阻塞/失败/重试展示 | P0 |
| A3 | 全局 SSE | 只有 6 个 scope；供应商/Agent/路由/网关/平台/通知/组合页改动后不刷新（要等 30–120s 轮询或手动刷新）；事件无序号，重连会重复应用 | P0 |
| A4 | `App.tsx` 骨架 | 任务页内嵌第二个 `<main>`（`main` 嵌套地标） | P1 |
| A5 | 任务抽屉/命令面板 | 没有焦点移入/循环/复原；Esc 依赖全局处理器；背景仍可滚动 | P1 |
| A6 | `motion.ts` | KPI 递增动画不尊重 `prefers-reduced-motion` | P1 |
| A7 | 移动端 ≤460 | 命令面板入口被 `display:none` 隐藏，手机上只能靠 rail 找页面 | P1 |
| A8 | 供应商/Agent/路由/网关面板 | 都各自 `useEffect(load)` 一次性拉取，无可见性感知、无失效、无并发保护 | P1 |
| A9 | `styles.css` | 4 个 `:root` 叠加（v3 权威层之前还有 3 层历史令牌），最终生效值靠层叠顺序猜测 | P2 |
| A10 | 执行图卡 | 超长 Worker 名/模型名/步骤 ID 直接撑破列宽或整段省略到不可读 | P2 |

## 修复（逐条对应）
- **A1 / A10**：新增 `GET /api/tasks/:id/execution-graph`（`apps/server/src/execution-graph.ts` 纯函数）+ `ExecutionGraphPanel`。四列、十类节点、证据 chip、真实用量/未接入双态；标签两行截断、meta 值换行而非硬省略；只在**新事件 ID**上 emit 飞行，首次快照标记历史为已播。
- **A2**：`CrewPlanStore.recordDispatch` 持久化派发回执（append-only，含 skipped 原因），`GET /api/crew/overview` 把回执 + 任务库合成父子树；`CrewPanel` 改为"历史方案 + 方案详情（6 KPI / 进度 / 子树 / 跳过）"，子任务可跳到执行图。
- **A3**：`BoardLiveEvents` 扩到 14 scope + 单调 `seq` + 每 scope `revision`；HTTP 只在写库成功后 publish（含网关用量回写、编队派发、组合决策、通知保存）；前端 `live-event-gate` 去重 + 重连锚定 + 全量重校验。
- **A4**：`#main-content` 改为唯一 `<main>`，任务页容器改为 `<section aria-label="任务工作区">`。
- **A5**：`focus.ts` 的 `useFocusTrap` 接管 Tab/Esc/背景滚动/焦点复原。
- **A6**：`useCountUp` reduced-motion 直接落值。
- **A7**：≤460 保留紧凑命令按钮（隐藏 `kbd` 提示）。
- **A8**：8 个面板统一 `useAdaptiveResource`（单在途请求 + 可见性 + 失效 + 轮询兜底）。
- **A9**：删除 3 个历史 `:root`（保留唯一权威层 + dark-mode `color-scheme` 兜底），静态核对 38 个 `var()` 引用无悬空。

## 改版后复验（机器可读，见 verification JSON）
- 执行图：19 个节点、12 条时间线事件、4 枚证据 chip；等待审批任务呈现 `排队/等待` 而非"完成"；`未接入：provider / model / runtime` 明示缺口。
- 编队：2 个子任务从持久化回执恢复（刷新/重启后仍在），进度 `2/2 交付`，跳过原因 `needs_provider_model` 可见。
- 实时：供应商写入后页面在 SSE 到达时自动重取（`/api/model-binding` 计数增加，0 手动刷新）。
- 断线：屏蔽 `/api/events` 后显示"轮询兜底"且页面数据完整；恢复后自动回到"实时同步"。
- 无障碍：唯一 `main`、skip-link 可跳、Esc 关闭抽屉并复原焦点、命令面板 Tab 循环、reduced-motion 下无飞行残留。
- 响应式：1440 / 1024 / 390 三档 `scrollWidth - clientWidth = 0`（执行图、编队、总览）；移动端命令按钮可见。
- 控制台：0 error / 0 未处理异常（多次页面装载 + reload/断线/reduced-motion 切换，共 48 项检查）。
- 归属可视化：带 `X-Daming-Task-Id` 的网关行让证据条变为「模型请求 / Token·费用 已持久化」，模型节点显示合计 `token 输入 1200 · 输出 80`、`¥0.05`；同时另一个无归属行（input 999）不出现在任何节点；共享模型的两个 fixture 步骤保持"未接入"。

## 反 AI 味与克制
- 没有新增渐变/光斑/彩色图标墙；执行图状态一律"颜色 + 文案 + 形状"三编码。
- 动效只在"新事件"发生；没有循环脉冲、没有数字伪造。
- 空态保留一句话 + 一个下一步动作（无方案 → 生成方案；无回执 → 按方案派发）。

## 仍存在的缺口（不掩饰）
> 2026-11-23 补齐轮：1–6 已分别处理，剩余限制写在各条末尾。

1. **任务归属（已实现通道）**：网关读取 `X-Daming-Task-Id` / `X-Daming-Agent-Id` 并写进 `/api/usage/recent`、dashboard 与 usageFile；Host 回写 `RequestLogStore.attribution`，执行图只取 `recordsForTask()`。**剩余限制**：Codex/Claude/DSH CLI 是否转发该请求头未用真实模型验证（本轮零真实推理），所以真实请求可能仍显示"未接入"；没有该头的记录永远不计入任务，不做模型名猜测。
2. **时间线定位（已补齐）**：`assignment:<id>:started/ended` 与 `review:<id>` 从持久化 assignment 时间与评审结论派生，直接定位 Agent / 验收节点。**剩余限制**：Host 事件 `workflow_assign/receive/review` 仍不含 stepId，继续显示为不可定位；要精确到步骤需要事件负载写入 stepId。
3. **动作可追溯（已补齐一半）**：工具节点写入持久化 `effectId`，可与治理审计/预留对账。**剩余限制**：工具名与入参仍未持久化（`coverage.toolCalls = partial`）。
4. **编队依赖（已补齐"建议型"）**：新建方案可勾选「记录顺序依赖」，`dependsOn` 随方案持久化；子任务显示"等待前置交付"，执行图 handoff 节点写明"计划依赖，引擎不强制串行"。**剩余限制**：Host 仍并行创建子任务，没有串行调度（不做第二套状态机）。
5. **安装版（已重新打包）**：`Daming-Setup.exe`（105,255,320 字节）已用 v4 web 资源重新产出，位于 `apps/desktop/release/`。**未安装**到 `D:\Daming`（不改用户现有安装）；如需生效需执行安装或做 web 资源热更新。
6. **旧浏览器脚本（已改为兼容转发）**：`scripts/web-browser-smoke.mjs` 现在只转发到 `scripts/ui-v4-verify.mjs`，`pnpm test:web:browser` 不再等待多页面化之前的文案。
7. 供应商页截图中出现的账号标签（小新/小白/QQ 邮箱等）来自本机 Magpie inventory 的**只读**扫描（`/api/magpie/inventory`，不返回 token），不是验收脚本注入的 fixture；脚本只向临时数据目录写入 `ui-v4-demo` / `ui-v4-live` 两个不可达供应商。
8. **重复用量显示规则**：同一模型被多个步骤共用时，合计只放模型节点（标注"N 个步骤共用"），Agent 卡显示"token / 费用未接入"；这是刻意选择——把总用量复制到每个步骤会虚增，无法核销。