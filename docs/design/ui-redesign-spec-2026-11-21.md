# UI/UX 重设计规范 v3 — "Calm Control Plane"（2026-11-21）

> 落地文件：`apps/web/public/styles.css`（末尾 `REDESIGN v3` 权威层）、`apps/web/src/App.tsx`（面包屑 / skip-link / 导航 aria / 快捷入口）。
> 方法组合：UI UX Pro Max（令牌与版式）+ Impeccable（审查收敛）+ Emil Kowalski（微交互/极端数据）+ Vercel（工程/无障碍/响应式）。

## 1. 设计令牌（v3 `:root`，最终生效）
| 类别 | 取值 |
| --- | --- |
| 画布/表面 | `--canvas #f5f6f8` `--surface #fff` `--surface-2 #f7f8fa` `--surface-3 #eef1f5` |
| 描边 | `--line #e6e9ef` `--line-2 #eef1f5` `--line-strong #d8dce5` |
| 文字 | `--ink #16181d` `--ink-2 #343841` `--muted #646b78` `--muted-2 #8b919d`（正文对比 ≥ 4.5:1） |
| 主色 | `--brand #4f46e5` `--brand-2 #4338ca` `--brand-soft #eef0ff` `--brand-line #d9dbfb` |
| 状态 | `--ok #157f43` `--warn #b45309` `--bad #c23a3a` `--info #0e7490`（各配 soft 底） |
| Dark rail | `--rail #0f1116` `--rail-2 #14161d` `--rail-fg #c7cad4` `--rail-muted #7d8493` |
| 圆角 | `--radius-xs 8` `--radius-sm 10` `--radius 14` `--radius-lg 18` |
| 阴影 | `--shadow` 双层软阴影、`--shadow-hover`、`--shadow-lg`、`--ring` 焦点环 |
| 字体 | `--font-sans`（Inter→Segoe UI→Microsoft YaHei UI/YaHei→PingFang/Noto Sans SC），`--font-mono` |
| 动效 | `--ease` `.22,.61,.36,1`、`--ease-spring`、`--dur-1/2/3` 120/180/260ms |

## 2. 版式与间距
- 内容最大宽 1360，左右留白 32（移动 14–18）；间距阶梯 4/8/12/16/24/32。
- 页面标题 22/650 `-.028em`；区块标题 13.5/650；正文 13.5；辅助 11–11.5（`--muted`）。
- 数字全部 `font-variant-numeric: tabular-nums`。

## 3. 布局（shell）
- 左侧 248px 深色 rail（分组导航 + 底部设置/帮助 + 实时状态）+ 顶部 54px 吸顶面包屑条 + 内容区。
- 顶部条：`大铭 / {页面}` 面包屑 + 命令按钮（⌘K）+ live dot + 角色徽标；页面 `h2` 为唯一大标题（消除重复）。
- 总览：4 KPI → 收件箱 + 运行面 两栏 → 8 宫格快捷入口（收件箱/任务/项目/供应商/Agent/编队/通知/网关观测）。

## 4. 组件配方
- 卡片：`--radius 14` + `--line` 1px + `--shadow`，内距 16–18；hover 抬升 1px + `--shadow-hover`。
- 按钮：primary=主色填充；ghost/指令=白底细边；文字链接=主色。按压 `scale(.975)`，禁用保持可读。
- 输入/选择/文本域：`--radius-sm`，focus 用 `--ring`。
- 状态 pill / chip：`background soft + 深色文字 + 圆点`，颜色配文案。
- 任务看板：6 状态列（草稿+已规划→待规划、排队+执行中→执行中…），列头可拖拽排序/隐藏（本机视图）。

## 5. 微交互（Emil Kowalski）
- 只动 transform/opacity；交互 120–180ms、面板/抽屉 220–300ms；抽屉 spring 滑入。
- hover 抬升 ≤1–2px；active `scale(.975)`；KPI 首屏 stagger 42ms。
- 全局 `prefers-reduced-motion: reduce` 降级为静态。
- 关闭 aurora / 旋转 logo 光环 / 渐变标题等炫技。

## 6. 极端数据（Emil）
- 0/1/很多：空态插画+一句话；列表 `max-height` 滚动；看板列自身横滚。
- 超长：`min-width:0` + 省略号 + nowrap；大数字 tabular-nums 不换行破位。
- 异常：失败/超时/未知有明确文案 + 颜色。

## 7. 无障碍与响应式（Vercel）
- `:focus-visible` 全局 2px 主色环；`aria-current="page"`；`aria-live`（toast 已有）；skip-link「跳到主要内容」。
- 断点：≤1240（KPI 2 列 / 快捷 3 列）、≤1080（rail→横向滚动命令条、两栏→单列）、≤720（KPI 1 列、快捷 2 列、面板单列）、≤460（快捷 1 列、隐藏命令按钮）。
- 任何宽度无横向溢出（看板列自身横滚除外）。
- 静态资源带版本 `styles.css?v=20261121-redesign`。

## 8. 变更文件
- `apps/web/public/styles.css`：新增 `REDESIGN v3 · Calm Control Plane` 权威层（令牌 + shell + 组件 + 动效 + 响应式）。
- `apps/web/src/App.tsx`：顶部面包屑 + 命令按钮；导航 `aria-current`；skip-link；`#main-content`；总览快捷入口网格。
- `apps/web/index.html`：样式版本参数。
- `skills/{impeccable,emil-kowalski-skills,vercel-web-design-guidelines}/SKILL.md`：把四个技能中的三个落为项目可用技能（`ui-ux-pro-max` 已存在）。
