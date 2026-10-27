---
name: nodes-skills-manage
description: 管理 Paseo 节点的全局 skills：盘点、公共技能分发、节点专属技能安装、旧目录迁移和链接检查。用户提到多机器的 skills、节点技能差异或全局技能同步时使用；项目内技能编写不走此流程。
---

# 节点全局 skills

公共 skills 在控制中心维护，由用户指令分发；节点可以保留专属 skills。各节点以 `~/.agents/skills/<name>` 为实体目录，Codex 直接读取，Claude 逐项软链接。同一节点两种工具默认共用一套。

## 入口

脚本路径相对本 skill。节点引擎仅依赖 Python 3.9+，支持 Linux/macOS；控制中心还需要 Git、Paseo CLI、Node 22+ 和仓库 `npm ci` 依赖。

公共来源和多节点操作优先使用 `scripts/controller.py`，Paseo“公共 Skills”页面也调用此入口。JSON 从 stdin 输入，stdout 为 NDJSON，`event=result` 是最终结果；`progress` 为当前进度。

```bash
python3 scripts/controller.py overview </dev/null
python3 scripts/controller.py refresh </dev/null
python3 scripts/controller.py check-update </dev/null
python3 scripts/controller.py sync </dev/null           # 直接分发到节点并校验，会写入节点
echo '{"source": {"id": "team", "type": "git", "url": "https://github.com/org/repo.git", "path": "skills"}}' \
  | python3 scripts/controller.py add-source          # 登记来源；remove-source 输入 {"id": "..."}
```

`overview` 返回每个节点最近一次检查或分发后的记录（`.private/nodes-skills-manage/nodes-status.json`），技能库快照变化后标为 `stale`。`refresh` / `sync` 默认作用于全部已登记节点，也可输入 `{"node_ids":["<serverId>"],"workspaces":{"<serverId>":"<workspaceId>"}}`。无明确环境工作区时会返回候选；选定现有工作区再执行。`refresh` 只读。`sync` 一步完成分发，没有预览和确认：逐节点盘点，已一致的不传输；其余节点写入后重新盘点校验，包含公共撤回、相同内容接管和链接调整。有冲突的节点整节点跳过并在结果中列出，不覆盖节点内容。将成功的 `check-update` 结果作为 `{"preview":<result>}` 输入 `apply-update`；只应用刚检查并已获授权的结果，失效时重新检查。

```bash
# 当前机器（节点目录由该进程的 HOME 决定）
python3 scripts/skills.py inventory

# 远端，先通过 paseo-nodes-use 选择已有 workspace
python3 scripts/node.py <节点> --workspace <id> -- inventory
python3 scripts/node.py <节点> --workspace <id> -- sync --source <控制中心公共目录>
python3 scripts/node.py <节点> --workspace <id> -- sync --source <控制中心公共目录> --apply
```

远端调用复用旁边的 `paseo-nodes-use/scripts/exec.sh`；节点解析、身份核对和 workspace 选择遵循 [paseo-nodes-use](../paseo-nodes-use/SKILL.md)。编排入口动态读取节点清单、逐节点执行并汇总结果；不能把部分成功说成全量完成。不要硬编码节点地址或 workspace ID。单节点的专属技能、迁移和排查可使用上述底层入口。

## 工作方式

1. **盘点**：`inventory` 列出公共母目录、Claude 和旧 Codex 目录，含内容摘要、归属和链接状态。未登记的技能按节点现有内容保留，不能自行归为公共。
2. **确定源与范围**：先读取控制中心 `.private/nodes-skills-manage/source.json`，复用已登记的来源列表（Git 仓库或 well-known 发现索引），无需每次询问来源；新增来源用 `controller.py add-source` 登记，不为单个提供方写代码。`snapshot.directory` 相对此配置文件所在目录解析；将其传给 `sync --source`。公共目录是扁平的 `<name>/SKILL.md` 完整实体快照，不要把控制中心的 `skills/` 当作公共集合。配置不存在时再对齐来源；来源更新与版本核对见 [公共来源](references/common-source.md)。
3. **预览并执行**：写操作默认只预览，加 `--apply` 才生效。在用户已授权的范围内直接执行，不重复询问许可。新发现的公共名单、归属转换或内容冲突需要先对齐；不要自行选覆盖版本。
4. **验证**：执行后重新盘点，核对公共摘要和链接。需要完整集合一致时使用 `sync --prune`；不带该参数会列出 `retained_common`，它表示保留了源中已消失的旧公共技能。

本工具只管理普通目录 skills。Codex `.system`、插件缓存、Claude `synced` 等由原工具管理，不扁平复制或自动迁移。首次公共分发前检查旧 Codex 同名技能，避免重复加载。

## 常用操作

以下参数也可放在 `node.py ... --` 之后：

| 操作 | 命令 |
|---|---|
| 接管完全相同的现有技能为公共 | `sync --source <公共目录> --adopt --apply` |
| 同步并移除已撤回的公共技能 | `sync --source <完整公共目录> --prune --apply` |
| 导入节点专属技能、迁移旧目录 | `import --source <该节点上的skill目录> --apply` |
| 为母目录全部技能补齐链接 | `link --apply` |
| 移除工具已登记的节点专属技能 | `remove <name> --apply` |

`sync --source` 在远端入口中指**控制中心路径**，脚本会传输完整内容；`import --source` 指**目标节点路径**。来源可包含 references、scripts、assets；保持可执行位和内部相对链接，拒绝引用技能目录外的链接。不要只复制 SKILL.md。

只有 Claude 配置目录已存在时才为其建链接；以后装好 Claude，执行 `link` 即可。旧 `~/.codex/skills` 中已有的同名实体，在内容完全相同时会备份并改为指向母目录的链接，不新建第二套旧目录副本。自定义 `CODEX_HOME` / `CLAUDE_CONFIG_DIR` 跟随远端 shell 环境。

所有命令输出 JSON；退出码 `0` 成功/无变更、`2` 内容冲突、`1` 执行错误。有冲突时整次文件操作不执行。已登记公共技能在节点上被修改后，更新和删除都会停在冲突；先把修改保存为专属技能或合并回控制中心，再解决冲突。没有自动强制覆盖参数。

状态和备份位于节点 `~/.local/state/nodes-skills-manage/`。需要恢复、排查中断或了解实现边界时，读 [实现与恢复](references/implementation.md)。
