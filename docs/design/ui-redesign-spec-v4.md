# UI/UX 升级规范 v4 — "Multi-Agent Command Center"（2026-11-22）

> 落地文件：`apps/web/public/styles.css`（末尾 `UI v4` 权威层）、`apps/web/src/{ExecutionGraphPanel,TaskDetailView,CrewPanel,format,focus}.tsx|ts`、`apps/web/src/{live-refresh,live-event-gate,execution-graph-view}.ts`、`apps/server/src/{live-events,execution-graph,crew-overview,crew-planner}.ts` + `http.ts`、`packages/contracts/src/index.ts`。
> 方法组合：UI UX Pro Max（视觉体系不变、只扩组件配方）+ Impeccable（改版前审查、改版后收敛）+ Emil Kowalski（真实事件驱动动效与极端数据）+ Vercel（工程/无障碍/响应式核对）。
> 基线：v3 `Calm Control Plane`（`docs/design/ui-redesign-spec-2026-11-21.md`）。**v4 不推翻视觉方向**，只把"有多个 Agent 管理功能的控制台"升级为"可实时观察/理解/指挥的指挥中心"。

## 1. 视觉体系（沿用 v3，未改令牌）
- 深色左 rail + 浅灰画布 + 白色卡片 + 靛蓝 `#4f46e5` 单一强调色；没有新增颜色、没有新的渐变/光斑。
- `apps/web/public/styles.css` 现有**唯一** `:root` 令牌层（v4 删除了 3 个被完全覆盖的历史 `:root`；经静态核对 38 个 `var()` 引用全部仍有定义或 fallback）。
- 新组件只使用既有令牌：`--surface*`、`--line*`、`--ink/muted`、`--brand*`、状态色 `--ok/warn/bad`、`--radius-*`、`--shadow*`、`--dur-*`、`--ease*`。

## 2. 新组件配方

### 2.1 统一执行图（任务详情抽屉内）
- 四列阅读顺序：**目标与编排 → Agent / 执行器 → 动作与产物 → 验收与交付**；≤1080 两列、≤720 单列（连接线在窄屏隐藏）。
- 节点：`goal / orchestrator / planner / crew plan / handoff / agent / model / tool / artifact / review / delivery`；每张卡 = 名称 + 角色/步骤 + 状态（颜色 + 文案）+ Runtime + 供应商/模型 + 步骤/次数 + 真实用量或"未接入" + 最近动作 + 错误。
- **模型请求节点**：按（供应商, 模型）聚合；只有网关按 `X-Daming-Task-Id` 归属到本任务的请求才计入。多个步骤共用同一模型时，合计只放在模型节点（标注"N 个步骤共用"），Agent 卡保持"token / 费用未接入"——不把整份用量重复记到每个步骤。
- **动作可追溯**：执行器动作节点写入持久化的 `effectId`（outbox 效果 id），可与治理审计对账；工具名/入参仍未持久化 → 仍标 `tool_name / tool_input` 未接入。
- **时间线**：`task:*` 为 Host 事件流（`workflow_assign/review` 因事件不含 stepId 不定位节点）；`assignment:<id>:started/ended` 与 `review:<id>` 由已持久化的 assignment 时间与评审结论派生，直接定位到 Agent / 验收节点；`crew:*` 为派发回执。
- 证据条：`运行时绑定 / 模型请求 / 工具调用 / Token·费用` 四枚 chip，取值 `已持久化 / 部分记录 / 未接入`；`未接入` 用虚线边框，不用绿色冒充完成。
- 任务抽屉桌面宽度提高到 `min(1080px, 94vw)`，让四列成立；移动端保持 92vw。

### 2.2 编队（Crew）工作区
- 两栏：左「历史编队」（持久化方案列表，`aria-current` 标记当前）+ 右「方案详情」；≤1080 单列且详情优先。
- 方案详情 = 头部（分派方式/时间/派发按钮）+ 6 枚进度 KPI + 交付进度条 + **父子任务树**（方案节点 → 子任务节点）+ 「尚未派发的子目标」+ 「跳过与失败」。
- 子任务节点显示：Agent、模型、绑定状态、派发时间、taskId、真实步骤进度、阻塞原因，以及**计划前置未完成**（`waitingOn`，橙色「等待前置交付」）；可一键打开该任务的执行图。
- **顺序依赖是建议型**：新建方案可勾选「记录顺序依赖（建议型）」→ 方案持久化 `dependsOn`，页面据此提示"等待前置"，但 Host **不强制串行**（引擎没有第二套调度），文案明写这一点。
- 树形连接线用 CSS 绘制（`::before/::after`），不依赖 box-drawing 字形。

### 2.3 通用
- 任务详情簇（`FlowCanvas` 旧视觉、`AgentLanes` 死代码）移除，替换为真实执行图；`ProcessTimeline / ActivityFeed / ReconcilePanel / RealCodexPanel / TaskDetail` 抽到 `TaskDetailView.tsx`，`money/shortId/STATUS_LABELS/WORKER_LABELS` 抽到 `format.ts`。

## 3. 实时数据（事件驱动，不造数）
- Host 每次**持久化成功后**才 `publish(scope)`；帧格式 `id: <seq>` + `{scope, seq, revision, at, resource}`。
- scope 从 6 个扩到 14 个：`tasks autoloop magpie lulu codex missions crew providers agents routing gateway platform notifications portfolio`。
- 前端只用一个 `EventSource`（可见页面），`live-event-gate` 按 `seq` 去重、重连后以 `ready.seq` 重新锚定，再对全部 scope 一次重校验；页面隐藏关闭流、重新可见立即重校验；轮询保留为兜底。
- 各面板（供应商 / Agent / 路由图 / 网关观测 / 平台状态 / 通知 / 组合 / 编队）都改为 `useAdaptiveResource`：单资源单在途请求、可见性感知、失效即取、旧响应不覆盖新响应。

### 3.1 任务归属（X-Daming-Task-Id）
- `services/daming-gateway` 在三类推理入口（chat/completions、responses、messages）读取可选请求头 `X-Daming-Task-Id` / `X-Daming-Agent-Id`，写入 `/api/usage/recent`、`/dashboard`（task 列）与 `usageFile`。
- Host 的用量回写器把 `taskId` 原样写入 `RequestLogStore`（`attribution: 'task'`）；没有该头的记录一律 `unattributed`，**绝不按模型名猜测**。
- `GET /api/gateway/observability` 与 `POST /api/gateway/requests` 均支持该字段；执行图只取 `recordsForTask(taskId)`。
- 边界：Codex / Claude / DSH CLI 是否转发该头未在本轮用真实模型验证（未开展真实推理），因此大多数真实请求仍可能显示"未接入"。

## 4. 动效（只对新事件播放）
- 复用 `apps/web/src/light-ui/`（`light-layer.ts` / `geometry.ts` / `svg.ts`）的飞行光点：只在"本次刷新新出现的事件 ID"上 emit，`eventId` = `task:<taskId>:<sequence>` 或 `crew:<planId>:<assignmentId>`。
- 首次快照只把历史事件标记为"已播"，不重播；重复刷新不会重复播放；页面隐藏 / 卸载 / `prefers-reduced-motion: reduce` 时不 emit（light layer 本身也会在隐藏时挂起 rAF）。
- 时长 760ms、只动 `transform/opacity`；节点状态变化用边框/左侧 2px 条 + 文案，不做无限脉冲。

## 5. 无障碍与响应式
- 语义：全站唯一 `<main id="main-content">`（任务页原来的嵌套 `<main>` 改成 `<section>`）；`aside.app-rail nav` 主导航；skip-link 指向 `main`。
- 对话框（任务抽屉、命令面板）：`useFocusTrap` —— 打开即移焦（抽屉到关闭按钮、面板到输入框）、Tab 循环、Esc 关闭（capture 阶段抢占，避免被全局快捷键吞掉）、关闭后焦点回到触发元素、锁定背景滚动。
- 移动端保留命令按钮（≤460 隐藏 kbd 提示而不是隐藏按钮）。
- `useCountUp` 在 reduced-motion 下直接落值（KPI 不再递增）。
- 断点：1440 / 1024 / 390 三档 0 横向溢出（看板列自身横滚除外，实测 `scrollWidth - clientWidth = 0`）。

## 6. 边界（不改产品契约）
- `docs/spec.md` 未改；Host 仍是任务/审批/预算/成本/审计的唯一写者。
- 执行图是**只读投影**：不新增状态机、不写任务事实、不伪造模型请求/工具调用/路由。
- 没有新增第三方依赖；没有引入第二套动画运行时；没有开启任何真实付费派工或模型请求（验收脚本的供应商指向 `127.0.0.1:1`）。

## 7. 验收
- `pnpm build:web`、`tsc`（root + web）、`pnpm check` 全绿：**609 测试 / 607 通过 / 2 可选跳过 / 0 失败**、边界 231（见 `docs/progress.md` 第 3 节）。
- 单元测试：事件失效帧/去重/重连（`apps/server/tests/live-events.test.ts`、`apps/web/tests/live-event-gate.test.ts`）、执行图映射/归属/时间线/共享模型（`apps/server/tests/execution-graph.test.ts`）、派发回执与建议型依赖（`apps/server/tests/crew-plan-store.test.ts`）、图谱列/动画去重/边路径（`apps/web/tests/execution-graph-view.test.ts`）、HTTP 级"持久化后才发布 + 执行图"（`apps/server/tests/live-invalidation-http.test.ts`）、网关请求头归属（`services/daming-gateway/tests/gateway.test.ts`）、请求日志归属（`apps/server/tests/gateway-observability.test.ts`）。
- 浏览器：`node scripts/ui-v4-verify.mjs`（`pnpm verify:ui-v4`）—— 真实 Chromium/CDP，**48 项检查、13 张截图、0 控制台错误**，结果写 `docs/verification/ui-redesign-v4.json`；其中包含"按任务归属的 token 在模型节点显示、Agent 卡保持未接入、未归属行不串入"三条归属断言。
- 旧的 `pnpm test:web:browser`（`scripts/web-browser-smoke.mjs`）已改为转发到本脚本（原选择器对应多页面化之前的目标，已不可达），命令仍可用且不再等待过期文案。
- 安装版：`node scripts/build-desktop.mjs` + `node scripts/package-desktop.mjs` 重新产出 `apps/desktop/release/Daming-Setup.exe`（105,255,320 字节，内嵌 `styles.css?v=20261122-v4` 与 v4 JS）；**本轮只打包、未安装**（未触碰 `D:\Daming`）。
- 审查报告：`docs/design/ui-ux-audit-v4.md`。