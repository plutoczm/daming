---
name: vercel-web-design-guidelines
description: Web 工程规范、无障碍与响应式审查（本项目加工版）。用于交付前按工程与可用性清单逐项核对焦点、语义、对比度、响应式、性能与 reduced-motion。
---

# Vercel Web Design Guidelines — 工程 / 无障碍 / 响应式（项目加工版）

> 参考 Vercel Web Interface Guidelines 的公开原则，加工为可执行的交付前核对表。

## 交互与可访问性
- 每个交互元素可键盘到达；`:focus-visible` 有可见 ring（≥2px，主色）。
- 用语义 HTML：`nav` / `main` / `header` / `section[aria-label]` / `button`。
- 当前导航项 `aria-current="page"`；动态区域 `aria-live="polite"`。
- 图标按钮要有 `aria-label`；纯装饰用 `aria-hidden`。
- 表单输入有 `<label>` 或 `aria-label`；错误用 `role="alert"`。
- 对比度：正文 ≥ 4.5:1，大字/图形 ≥ 3:1；状态同时用颜色 + 文案/形状。
- 触控目标 ≥ 40×40；提供“跳到主要内容” skip-link。

## 响应式
- 断点：≤1240 / ≤1080（rail 转横向滚动条）/ ≤720（单列）/ ≤460（隐藏次要动作）。
- 任何宽度下不出现横向滚动（看板列允许自身横滚）。
- 网格用 `minmax(0,1fr)` 防内容撑破；长文本 `min-width:0`。

## 工程 / 性能
- 静态资源带版本参数（`styles.css?v=...`）避免旧缓存；`no-cache` 校验。
- 无运行时动画/UI 依赖；动效纯 CSS。
- 避免布局位移（字体/尺寸稳定）；数字用 tabular-nums。
- 全局 `prefers-reduced-motion` 降级。
- 构建：`pnpm build:web` + `tsc -p apps/web/tsconfig.json` 通过；截图存 `.cache/`，结论写 `docs/verification/`。

## 交付前核对
- [ ] 焦点可见、键盘可达、skip-link 可用
- [ ] 无横向溢出（1440 / 1080 / 390）
- [ ] 对比度达标、状态双编码
- [ ] reduced-motion 完整
- [ ] 构建与类型检查通过
