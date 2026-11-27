# REA：DSH / HiFox / T3 Code / Magpie 的 UI 前端学习与 Daming 落地

> 目的：用 REA（Reverse-Engineering Analysis，逆向/参考提取分析）拆解四个参照产品的 **UI 形态、信息架构、设计令牌与交互**，再把可复用部分落到 `apps/web`。
> 来源：本机 DSH 安装包（`@deepseek-ai/dsh-web-frontend/dist` 的 CSS/HTML）、本仓库 vendored Magpie GUI（`services/damingd/internal/gui/assets/app.css|index.html`）、T3 Code 公开仓库/发布说明、HiFox 官网与帮助中心/更新日志。2026-11-20 整理。
> 注意：只提取设计模式与 CSS 令牌，不复制其产品文案、账号体系或后端协议。

## 1. 参照产品各自“强”的地方

| 产品 | 形态 | UI 上值得学的点 |
|---|---|---|
| **DSH** | 本地 Agent Harness（Electron + Web 前端） | 深色底 `#0f1115`；会话侧栏 + 中央对话流 + 底部 composer；工具调用/终端/文件 diff 以“卡片”折叠；状态用 `--dsw-alias-*` 语义令牌；启动/失败/更新都是独立轻量页面 |
| **Magpie** | 桌面端模型网关/账号/插件控制台 | 左侧分组导航（Work / Models / Insights / Extend）+ 顶部 segmented tabs；卡片/列表 + 状态点（成功/失败/漂移）；浅色 `#f4f4f6` + 靛蓝 `#4f46e5`；等宽字体展示 token/费用；开箱即用的 Settings 深链 |
| **T3 Code** | Coding Agent 控制面 | **thread 是一等对象**：侧栏一行一个 thread（分支/worktree 状态）；中间是 turn 时间线；右侧 worktree/diff/审批；provider/model 是行内徽标；一 server 多客户端（桌面/手机同一批 threads） |
| **HiFox** | 多人 + 多 Agent 协作空间 | **任务为中心 + 收件箱**：按任务归组动态，一条任务一行、额外事件用数量表示；分区「主要 / 其他 / 稍后 / 已清除」；看板列可排序/隐藏；Agent 是团队资产（指令+Skill+Runtime）；桌面关闭=隐藏托盘 |

参考：[T3 Code 发布说明](https://newreleases.io/project/github/pingdotgg/t3code/release/v0.0.32#1)、[HiFox 收件箱设计](https://hifox.com/blog/ai-agent-inbox/)、[HiFox 更新日志（对话右侧面板/看板列管理/托盘）](https://help.hifox.com/changelog/2026-09-22)、[HiFox 官网](https://hifox.cn/)。

## 2. 从源码提取到的具体令牌与结构

### 2.1 DSH
- 品牌字体：Montserrat（300/400/500）；启动页品牌字距 `.08em`。
- 主题语义变量：`--dsw-alias-bg-base`、`--dsw-alias-label-primary/secondary/tertiary`、`--dsw-alias-border-l1/l2`、`--dsw-alias-brand-primary`；深色主题由 `body[data-ds-dark-theme]` 切换。
- 代码/终端变量：`--dsl-code-block-background`、`--dsl-code-block-border-radius`、`--dsl-terminal-font`、行高/间距独立。
- 布局：左侧会话列表（可折叠）+ 右侧主区；消息流宽度受限、工具结果折叠成卡；右下角固定 composer。
- 对我们的启示：**语义令牌而不是零散颜色**、**工具/终端用独立代码卡**、**主区阅读宽度上限**。

### 2.2 Magpie
- `:root` 明确定义：`--bg #f4f4f6`、`--card #fff`、`--line #e3e3e8`、`--fg #1c1c21`、`--muted #85858d`、`--accent #4f46e5`、`--accent-soft #eeedfd`、`--green/red/amber` 以及 soft 变体、`--shadow`、`--font`、`--code`。
- 布局：`aside.sidebar`（brand / 分组 `#nav` / 底部 Settings）+ `header.top`（brand、segmented nav、actions）+ `main.view`（list + detail/panel）。
- 组件语言：pill、segmented control（`--seg-track/--seg-thumb`）、状态点（失败用 x 形而非只有红点，照顾色盲）、卡片、可折叠编辑器、空态文案。
- 对我们的启示：**左侧分组导航 + 顶部分段切换 + 卡片列表 + 状态色 soft** 是最适合 Daming 的骨架。

### 2.3 T3 Code
- 侧栏 thread 行同时承载：标题、provider/model、branch/worktree、运行状态。
- 主区是 turn/消息 + 工具事件；审批是行内卡；diff/worktree 独立面板。
- 移动端做“远程批准”，桌面做“发起 + 细看”。
- 对我们的启示：**任务行要显示状态 + 执行器 + 花费**；**审批要能从列表一键进入**；**详情区与列表同屏**。

### 2.4 HiFox
- 收件箱：按任务归组，一条任务一行；主要/其他/稍后/已清除；清除不等于删除任务。
- 看板：列可拖拽排序/隐藏；任务详情右侧抽屉；工具调用折叠摘要；Agent 头像状态（工作中/离线）。
- 对我们的启示：**“待拍板”聚合**、**任务一行展示 + 状态 pill**、**抽屉式详情**、**Agent 状态可见**。

## 3. Daming 的落地（本次已实现）

### 3.1 设计令牌（`apps/web/public/styles.css` 末尾覆盖层）
- 浅色：`--canvas #f4f4f6`、`--surface #fff`、`--ink #1c1c21`、`--muted #6f6f78`、`--line #e4e4ea`。
- 强调：`--brand #4f46e5`（Magpie 靛蓝）+ `--brand-2 #2563eb`；soft `#eeedfd`。
- 状态：`--ok #189a58`、`--warn #b45309`、`--bad #d64545` + soft。
- 阴影：`--shadow` / `--shadow-lg`；圆角 12–14px；等宽字体用于 ID/费用。

### 3.2 信息架构（`apps/web/src/App.tsx`）
左侧 rail（深色，DSH 会话栏 + Magpie 分组）：
- 协作：总览 / 收件箱 / 任务
- 控制面：工作台 / 审批 / 自动化
- 模型与平台：模型与供给 / 平台状态

顶部：面包屑式 page title + `Ctrl K` 命令面板 + 实时同步 + 本机用户徽标。

### 3.3 总览（HiFox 收件箱 + T3 控制面）
- KPI：待拍板 / 任务总数 / Agent / 实时状态。
- 收件箱卡：`awaiting_approval / reviewing / blocked` 任务一行一条，点击即选中并跳到任务；Autoloop 待拍板卡附计入。
- 运行面卡：实时流、Magpie、DeepSeek、Lulu、受管 Host 状态点。

### 3.4 命令面板（DSH/T3 的快速跳转）
- `Ctrl/Cmd + K` 打开，输入过滤，Enter 跳转，Esc 关闭；点击左侧 rail 同步高亮。

### 3.5 保留的既有能力
- Codex 手动审批、CommandCenter、项目四件套、模型绑定、Magpie 管理、任务详情、预算/审批/审计全部保留；仅调整外层壳与视觉层级。

## 4. 明确没有照搬的部分

- 不复制 T3 的 thread/turn 事件模型（Daming 仍是 Task/Plan/Decision 事件溯源，单一 Engine 写入）。
- 不引入 HiFox 的 SaaS 多租户/看板拖拽后端（当前只做前端收件箱聚合，持久化仍走 Host）。
- 不引入 DSH 的聊天会话模型（Daming 不是通用聊天客户端）。
- 深色主题只参考 DSH 的层次，不改变现有浅色组件（避免大面积硬编码颜色回归）。

## 5. 后续可选增强

1. 任务详情改为 HiFox 式右侧抽屉，列表不跳页。
2. 任务看板按状态分列（草稿/排队/执行/验收/完成），支持隐藏列。
3. 将“收件箱”持久化为 Host 聚合 API（reply/review/failure/mention 四类）。
4. 详情区内嵌工具调用卡（DSH 风格）与 worktree/diff 卡（T3 风格）。

## 6. 动效 / 美术层（第二轮，2026-11-20）

### 6.1 参考的高 star 技能/组件库（只取模式，不引入运行时）
- [garden-skills](https://cloud.tencent.cn/developer/article/2676247)（6.2k★）：`web-design-engineer` 的 25 种风格配方 —— 借“渐变标题 / 柔和光斑 / 细描边卡片 / 克制的层次阴影”配方。
- [ui-ux-pro-max-skill](https://cloud.tencent.cn/developer/article/2613111)：设计知识库式检索（配色/字体/间距/WCAG），借“语义化设计令牌 + 对比度约束”。
- [Magic UI](https://adminlte.io/blog/shadcn-ui-block-libraries/)（22k★）与 [uselayouts](https://hysenlabs.com/projects/iurvish-uselayouts)（715★）：借 animated list / bento / beam / micro-interaction 的节奏，不引入其 Tailwind/Framer 依赖。
- [Awesome Claude UI Armory](https://github.com/ezra-y/awesome-claude-ui-armory)：作为技能索引，确认社区常用 UI 技能范围。

### 6.2 本次实现的动效与美术
- **入场**：KPI 卡片 4 段 stagger `fade-up`；`[data-reveal]` 区块用 IntersectionObserver 滚动显现。
- **氛围**：overview 背后 3 个低饱和光斑 `dm-float` 缓慢漂浮；rail 叠加 feTurbulence 噪点纹理；品牌 logo 内圈 conic 高光旋转。
- **状态**：live dot / 成功点脉冲；`running/queued/reviewing` 状态 pill 流光；进度条 shimmer；空态轨道插画（SVG + 轨道点旋转）。
- **交互**：卡片 hover 抬升、收件箱行横向位移、按钮按压缩放、命令面板 backdrop fade + panel spring-in、rail 激活态过渡。
- **全局**：顶部 2px 滚动进度条、渐变标题、细滚动条、`prefers-reduced-motion` 全量降级。
- 所有动效为 **本地 CSS + 3 个小型 React hook**（`apps/web/src/motion.ts`：`useCountUp` / `useScrollReveal` / `useScrollProgress`），**零新增运行时依赖**。
- 截图：`.cache/ui-motion.png`；构建证据：`docs/verification/ui-motion-2026-11-20.json`。


## 7. 第三轮：多页面 + 真实供应商/Agent（2026-11-20）

- **多页面**：一个 nav 项一个独立页面，不再长滚动。总览 / 收件箱 / 任务 / 项目 / 供应商 / Agent / 自动化 / 平台状态。
- **供应商**：真实 Magpie catalog 按 `providerId` 聚合（workbuddy / zcode / codex / kiro / ollama），模型由账号/API/本地运行时提供；页面不出现“离线演示”。
- **Agent**：DSH / Codex / Claude Code 三个 Harness，独立选择供应商 → 模型并绑定（`/api/model-binding`）。模型永远来自供应商。
- **项目**：只接收用户目录中的 `spec.md` + `plan_baseline.md`；`plan_runtime` 与 `progress` 由 Agent 维护。新增 `/api/projects/intake` 与 `/api/projects`。
- **视觉**：参考用户上传的 Magpie 截图（上下文窗口 / 用量 / 网关 / 隐私设置 / Agent 列表 / 供应商列表）——暖灰画布、16px 圆角、头像色块、状态点、充足留白、低饱和。
- **技能**：`skills/daming-ui-design`、`skills/ui-ux-pro-max` 作为项目技能；来源见第 6 节。
- 证据：`docs/verification/ui-multipage-real-2026-11-20.json`，截图 `.cache/cdp-providers.png`、`.cache/cdp-agents-bound.png`、`.cache/cdp-projects2.png`。
