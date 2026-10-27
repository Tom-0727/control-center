# control-center

供 Claude Code 与 Codex 使用的节点控制 skills，实体在本仓库 `skills/`，入口服务器通过软链接全局加载，在任意目录启动 agent 都可用。节点全局 skills 由 `nodes-skills-manage` 从登记的上游来源拉取并分发。

用途是给 coding agent 赋能：

- **Paseo 节点控制**：按名称定位已连接的节点，在其上启动、观察和管理 agent 任务。
- **节点全局 skills 管理**：`nodes-skills-manage` 统一盘点和分发公共 skills，保留节点专属技能，支持目录迁移、链接检查和变更预览。
- **Paseo 公共 Skills 界面**：[独立插件](plugins/nodes-skills-manage/README.md) 提供节点状态、仓库更新差异、快照更新和确认分发，与 agent 共用管理入口。
- **Paseo 会话复盘**：[复盘插件](plugins/session-review/README.md) 装在任意节点上复盘本机的 Claude / Codex 会话；配置了节点清单的机器同时汇总清单里的节点，查看时间线、决策点与消息详情。
- **研发上下文连通**：打通飞书、Linear、GitHub 等上下文，读写文档、issue 与消息，并关联到研发任务。

## 目录设计

```
skills/<skill名>/SKILL.md             # 唯一源
AGENTS.md                             # 仓库约定
CLAUDE.md                             # 指向 AGENTS.md
plugins/nodes-skills-manage/          # Paseo 原生插件，独立于 Paseo 源码
```

- 仓库不设项目级 skills 目录。入口服务器为每个技能建两条软链接，Codex 读前者，Claude 读后者：
  - `~/.agents/skills/<skill名> -> <仓库>/skills/<skill名>`
  - `~/.claude/skills/<skill名> -> ../../.agents/skills/<skill名>`
- 只在 `skills/` 里增删改；新增技能后补上述两条链接。这些技能用于控制其他节点，只装在入口服务器，不进公共分发集合。
- `SKILL.md` 的 frontmatter 只写两边通用的 `name` 和 `description`，目录名与 `name` 一致。
- 公开仓库，不存放节点地址、serverId、配对链接、token 等敏感信息，运行时从本机读取。

## 飞书

飞书使用官方 `lark-cli` 执行操作。全局技能 `lark-suite` 直接登记为官方来源（[发现索引](https://open.feishu.cn/lark-cli/skills/isolated/.well-known/agent-skills/index.json)），保持官方原版，由 `nodes-skills-manage` 检查更新、校验 SHA-256 并分发到所有节点；本仓库不保存副本。

每台需要使用飞书的节点单独安装 CLI 并授权，安装依赖 Node.js/npm：

```bash
npm install -g @larksuite/cli@latest
lark-cli config init
lark-cli auth login
lark-cli auth status
```

按 CLI 提示创建或配置企业自建应用，申请实际需要的权限并完成用户授权；管理员审批后可能需要重新登录授予新增权限。日常调用显式使用 `--as user`，凭证由本机 CLI 管理。分发技能不会复制 CLI 或登录态；已配置的机器无需重新创建应用。

节点升级 CLI 用包管理器（如上面的 `npm install -g`）。`lark-cli update` 和 `npx skills add larksuite/cli` 会同时改写节点全局 skills；统一分发的 `lark-suite` 被改动后，下次同步会停在冲突，不会被静默覆盖。
