---
name: emil-kowalski-skills
description: 微交互、动画与极端数据测试（本项目加工版）。用于给页面加克制的动效、按压/悬停物理、抽屉与列表编排，并验证 0/1/很多/超长文本/大数字等边界。
---

# Emil Kowalski Skills — 微交互 / 动画 / 极端数据（项目加工版）

> 定位：动效是“因果”的语言，不是装饰。快、准、可预期；边界数据不破版。

## 动效原则
- 只动 `transform` / `opacity`，避免触发布局抖动。
- 时长：交互反馈 120–180ms，面板/抽屉 220–300ms；缓动 `cubic-bezier(.22,.61,.36,1)`，物理回弹用轻 spring。
- 按压反馈：`scale(.97)`；悬停抬升 ≤ 2px；离开立即回落。
- 列表入场 stagger 30–50ms，仅首屏；重复滚动不重复播。
- 全局 `@media (prefers-reduced-motion: reduce)` 降级为“瞬时/静态”。
- 不引入运行时动画库；用本地 CSS + `apps/web/src/motion.ts`。

## 微交互清单
- 按钮：hover 变亮 + 阴影、active 内缩；disabled 保持可读但明显失效。
- 卡片/行：hover 抬升 1px + 边框加深；选中用 3px 主色 ring。
- 抽屉：从右侧 spring 滑入 + 背景淡入模糊；Esc/背景/× 关闭。
- Toast：右下角滑入，3.8s 自动消失，`aria-live="polite"`。
- 切页：View Transition 交叉淡入（root），不超过 220ms。

## 极端数据测试（必须逐条过）
1. 空：0 条 → 空态插画 + 一句下一步。
2. 单条：1 条 → 不塌陷、不居中失衡。
3. 很多：1000 条 → 虚拟滚动/分页/`max-height` 滚动，不卡顿。
4. 超长：标题 120 字、模型名超长 → `min-width:0` + 省略号 + `title`。
5. 大数字：¥999,999.99、10 万 token → `font-variant-numeric: tabular-nums`，不换行破位。
6. 异常：失败/超时/未知 → 有明确文案与颜色（颜色 + 文字双编码）。

## 验收
- 上述 6 类数据在桌面与 390px 宽度都不横向溢出。
- reduced-motion 下内容完整、无动画残留。
