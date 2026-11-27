# skills/ — 随仓库自带的跨 Agent 技能库

本目录是**唯一真源**的技能库，遵循开放的 **Agent Skills / SKILL.md** 标准（`agentskills.io`）。
放在这里 = 随 Git 仓库走，任何 Agent 接手即读，**无需从市场重新下载**。

## 目录约定

```
skills/
└── <skill-name>/
    ├── SKILL.md          # 必需：YAML frontmatter(name, description) + Markdown 正文
    └── ...               # 可选：脚本/模板/参考资料
```

`SKILL.md` frontmatter 至少包含 `name`、`description`；description 决定"何时触发"。

## 三个执行器如何发现同一批技能（路径不同、内容同源）

| 执行器 | 项目级发现路径 | 用户级发现路径 | 说明 |
| --- | --- | --- | --- |
| DeepSeek Harness (DSH) | 用户级 `~/.agents/skills` 已被加载 | `~/.agents/skills` | 按需读 `skills/<name>/SKILL.md` |
| Codex CLI | `.agents/skills/<name>/SKILL.md` | `~/.agents/skills` | 原生发现；也可 `~/.codex/config.toml` 的 `[[skills.config]] path=...` 显式登记 |
| Claude Code | `.claude/skills/<name>/SKILL.md` | `~/.claude/skills` | 原生发现；按需读 `skills/<name>/SKILL.md` |

路径不通用、SKILL.md 内容通用。`scripts/sync-agent-skills.mjs` 用 junction/软链把 `.claude/skills`、`.agents/skills` 指到本 `skills/` 目录，做到"一份内容、三端可用"。

## 常用命令

```bash
# 查看三家执行器的发现目录与技能数量
node scripts/sync-agent-skills.mjs status

# 建立项目级软链：.claude/skills、.agents/skills -> ./skills
node scripts/sync-agent-skills.mjs link

# 把本机已有的技能（例如 ~/.agents/skills 里的 dingtalk-*）一次性导入仓库、随 Git 走
node scripts/sync-agent-skills.mjs import --from "%USERPROFILE%\.agents\skills"

# 反向：把仓库技能镜像给某个 Agent 的用户级目录（不复制、用软链）
node scripts/sync-agent-skills.mjs mirror --from ./skills --to "%USERPROFILE%\.claude\skills"
```
