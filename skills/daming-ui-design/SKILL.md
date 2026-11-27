---
name: daming-ui-design
description: 大铭 Web/桌面任务板的 UI、动效与美术规范。用于新增或修改 apps/web 页面、组件、命令面板、看板、卡片、空态、状态动效时，保持与 DSH/Magpie/T3 Code/HiFox 对齐的控制面视觉与交互。
---

# 大铭 UI 设计系统（REA 对齐版）

## 何时使用
- 修改 `apps/web` 的任何页面、组件、样式、动画。
- 新增面板、看板、列表、详情、空态、命令面板、Toast。
- 需要判断“该用什么颜色/圆角/阴影/动效节奏”。

## 设计基准（来自 REA）
- 布局：左侧深色 rail（分组导航）+ 顶部 page title + 主内容区；主内容最大宽度 1560px。
- 结构：DSH 的会话侧栏层次、Magpie 的分组导航与卡片、T3 的控制面 + 详情、HiFox 的收件箱按任务归行。
- 只借鉴模式与令牌，不复制第三方文案/账号模型/后端协议。

## 设计令牌（`apps/web/public/styles.css` 末尾覆盖层）
```
--canvas:#f4f4f6; --surface:#fff; --surface-2:#fafafc;
--ink:#1c1c21; --muted:#6f6f78; --line:#e4e4ea; --line-2:#ececf1;
--brand:#4f46e5; --brand-2:#2563eb; --brand-soft:#eeedfd;
--ok:#189a58; --ok-soft:#e4f6ec;
--warn:#b45309; --warn-soft:#fbf0df;
--bad:#d64545; --bad-soft:#fbe9e9;
--shadow:0 1px 2px rgba(20,22,30,.05),0 10px 28px rgba(20,22,30,.06);
--shadow-lg:0 24px 70px rgba(15,17,21,.35);
--radius:14px; --rail:#15151a; --rail-2:#1d1d24;
```
- 字体：`Inter, "Segoe UI", "Microsoft YaHei UI", system-ui`；ID/费用/代码用 `ui-monospace, Consolas`。
- 圆角：卡片 14px、按钮 8–10px、pill 999px。
- 状态必须同时有颜色 + 文案；失败/成功不要只靠颜色（可加 x 形/图标）。

## 动效规范
- 入场：`dm-fade-up` 0.55s，KPI 四段 stagger（0.02/0.08/0.14/0.2s）。
- 滚动显现：`[data-reveal]` + `useScrollReveal`（阈值 0.06）。
- 氛围：aurora 光斑 `dm-float` 14–19s；rail 噪点仅 0.22 透明度；logo conic 6s。
- 状态：live dot `dm-pulse` 2.4s；running pill/进度条 `dm-shimmer` 1.8–2.6s。
- 交互：hover 抬升 ≤2px；按压 scale .985–.995；命令面板 `dm-palette-in` 0.22s。
- 必须支持 `prefers-reduced-motion: reduce` 全局降级。
- 不引入运行时动画库；用本地 CSS + `apps/web/src/motion.ts` 的 `useCountUp` / `useScrollReveal` / `useScrollProgress`。

## 组件配方
- KPI 卡：`.kpi`（accent 用于待拍板）。
- 收件箱：`UnifiedInbox.tsx`，按项目分组的多个 `status-card inbox-project` 小卡 + 每条升级一行（`.inbox-item`，kind/bucket 标签 + 摘要 + 批准/驳回/稍后），单列「任务待办」卡；不再用单一 `.inbox-card` 平铺。
- 任务看板：`TaskBoard.tsx`（6 状态列、列头拖拽排序/隐藏，仅本机视图，不改任务状态）。
- 任务详情：右侧抽屉 `.task-drawer` + `.drawer-backdrop`，Esc/背景/× 关闭；详情内容全部在抽屉里。
- Toast：`Toast.tsx` + `useToasts`，右下角，自动 3.8s 消失。
- 页面过渡：`withViewTransition` + `::view-transition-old/new(root)`；切页/开抽屉用 root 交叉淡入。
- 命令面板：`.palette-backdrop` / `.palette`，Ctrl/Cmd+K，Enter 跳转，Esc 关闭。
- 空态：优先用轻量 SVG 轨道/光点插画，不写大段解释文字。
- 状态 pill：`.status-pill.status-<status>`，复用 `STATUS_LABELS`。

## 信息架构
- 一个导航项 = 一个独立页面，不做整页纵向拼贴。
- 工作区：总览 / 收件箱 / 项目
  - 收件箱 = 唯一收件箱，内部**按项目分组**（每个项目一个独立小收件箱），另有「任务待办」一组；不再有独立的「组合收件箱」。
  - 项目 = 项目接入（只接收 spec.md + plan_baseline.md；plan_runtime/progress 由 Agent 维护）+ 内嵌任务看板；**任务不再单独成模块**，随项目走。
- 运行：供应商（Codex/WorkBuddy/API Key/Ollama… 提供模型） / Agent（DSH/Codex/Claude Code Harness，可绑定任意供应商模型） / 路由图 / 执行链 / 协作群
  - 执行链 = 唯一执行模块，内含**指挥官**（用户为项目选默认 Agent+模型，可随时更换）+ **编队**（指挥官读 Spec/Plan → 按能力/绑定/成本分配 Agent 与模型 → 子 Agent 执行 → 评审员按评测集审核 → 不通过返工直到通过或额度耗尽；关键节点通知飞书/微信/QQ）。「编队」不再单独成模块。
  - 协作群 = 项目专属 Agents 工作群：指挥官分派/汇总/汇报，用户可对任意阶段换 Agent/LLM、指定任意 Agent/LLM 重做已执行阶段，Coding Agent 可互讨论。
- 系统：网关观测 / 通知（飞书/企业微信/微信/QQ/Webhook + 远程接管）/ 平台状态（Magpie 真实额度）
- **不再有**独立的「任务」「组合收件箱」「编队」「自动化」模块（需决策的在执行链自动进收件箱 + 飞书/微信/QQ）。
- 应用菜单：文件（新建窗口/新聊天/新项目/打开文件夹/关闭/退出）、编辑、视图（Ctrl+1…8 页面）、窗口、帮助（帮助/设置/关于）；左下设置/帮助。
- 页面标题不写英文 eyebrow，不堆长描述；供应商/Agent 用紧凑卡片，不用字母头像。
- 禁止：离线演示、fixture 作为主路径、项目四件套长表单。

## 验收清单
1. 新组件使用令牌，不写死新颜色。
2. 动效有 reduced-motion 降级。
3. `pnpm build:web` + `tsc -p apps/web/tsconfig.json` 通过。
4. 不破坏 `Ctrl+K`、收件箱跳转、关闭到托盘、本机免登录。
5. 截图存 `.cache/`，结论写入 `docs/verification/`。
