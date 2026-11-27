---
name: garden-web-design
description: 高星 garden-skills / Magic UI 风格配方（本项目加工版）。用于把“AI 味”页面改成有人味的页面：暖色画布、柔和层次、留白、克制动效与组件节奏。
---

# Garden Web Design（项目加工版）

> 来源与致谢：[garden-skills](https://cloud.tencent.cn/developer/article/2676247)（6.2k★，25 种风格配方）、[Magic UI](https://adminlte.io/blog/shadcn-ui-block-libraries/)（22k★）、[uselayouts](https://hysenlabs.com/projects/iurvish-uselayouts)。本文件是加工后的可执行规则。

## 大铭采用的配方
- 画布 `#f6f5f2` / 卡片 `#ffffff` / 细边 `#eae7e1` / 主色 `#4f46e5`。
- 卡片圆角 16px，列表行 44–56px；头像/首字母色块代替图标墙。
- 标题 22px/600，正文 12–13px，辅助 10.5–11.5px；留白 ≥ 16px。
- 动效：入场 0.35–0.55s、hover ≤2px、panel 0.22s；不做弹跳过度。

## 反 AI 味清单
1. 不堆渐变和发光；一页最多一个视觉焦点。
2. 不写满解释文字；空态用插画 + 一句话。
3. 不用“离线演示 / 示例数据”做首屏主路径。
4. 每张卡只回答一个问题；数字用等宽字体。
5. 多用真实内容（真实供应商、真实目录、真实状态），少用占位符。

## 页面骨架
- 列表页：页头 → 筛选/动作 → 行列表/卡片网格 → 空态。
- 详情页：右侧抽屉，头部标题 + ID + 关闭，正文分区。
- 设置/供应商：分组标题 + 行式条目 + 状态 pill + 开关/动作。

## 验收
- 截图第一眼看不出“Tailwind 模板味”。
- 颜色不超过 1 主色 + 3 状态色。
- `prefers-reduced-motion` 下内容完整。
- 真实数据为空时，空态仍能指导下一步。
