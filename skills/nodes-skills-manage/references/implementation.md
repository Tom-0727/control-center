# 实现与恢复

## 源码结论

调研基准：`runkids/skillshare` commit `529a8f2771d1052d18c4ca5485623e3a0f30e3c1`。

- [sync.go](https://github.com/runkids/skillshare/blob/529a8f2771d1052d18c4ca5485623e3a0f30e3c1/internal/sync/sync.go)：扫描源目录、逐个技能链接、区分本地目录和链接、清理旧项。
- [manifest.go](https://github.com/runkids/skillshare/blob/529a8f2771d1052d18c4ca5485623e3a0f30e3c1/internal/sync/manifest.go)：记录工具管理的条目。
- [copy.go](https://github.com/runkids/skillshare/blob/529a8f2771d1052d18c4ca5485623e3a0f30e3c1/internal/sync/copy.go)：复制、摘要和来源变化检测。
- [pull.go](https://github.com/runkids/skillshare/blob/529a8f2771d1052d18c4ca5485623e3a0f30e3c1/internal/sync/pull.go)：从已有工具目录收集技能。

本实现独立编写 Python 代码，借鉴目录/链接/受管清单的模型，没有复制上游 Go 代码。上游采用 [MIT](https://github.com/runkids/skillshare/blob/529a8f2771d1052d18c4ca5485623e3a0f30e3c1/LICENSE) 许可。无需 vendoring 整个项目或安装其二进制。

## 状态与冲突

`state.json` 保存 `managed[name] = {scope, digest}` 和受管链接。摘要包含相对文件名、内容、可执行位、空目录、内部链接目标；忽略 `.git`、`__pycache__`、`.DS_Store`。不依赖修改时间，损坏的状态文件会阻止写入。

公共目录是实际启用的集合，Codex 会直接发现它。未管理的目录不自动升级为公共；只有 `--adopt` 能接管内容完全相同的现有实体。已明确登记为 local 的技能不会因 `--adopt` 被改成 common。同名但内容不同、陌生链接、节点上修改过的受管内容都会阻止本次操作。

公共撤回需要源目录已删除对应技能，并使用完整集合 `sync --prune`。只清理曾登记为 common 的条目及其受管链接。源目录缺失或包含未展开的嵌套技能目录会直接报错，不能拿空目录或不完整集合代替一次正常同步。

专属技能直接编辑后也会产生摘要差异。需要覆盖、删除或改变归属时，先保存现有内容并明确选择保留版本；可基于实际摘要修正该单项记录，再预览操作。不要删除整个状态文件来绕过冲突。

## 备份与恢复

每次有变更的 apply 返回 `backup` 路径，其中包含：

- `state-before.json`：操作前的状态。
- `plan.json`：有序操作列表。
- `0`、`1` 等：对应操作原位置存在时的完整备份（实体目录或原软链接）；原来不存在的路径没有该编号备份。

常规 Python 异常会逆序恢复已经修改的条目与状态。机器掉电、进程被 kill 等情况下不能保证自动恢复，也不声称多节点事务原子性。

恢复前查看该次 `plan.json`、备份与当前目录，确认后续没有需要保留的新修改。按 actions 逆序逐项恢复：有编号备份则复制回原 `path`（原链接应保留其原始 link 字符串）；无备份则移走该次新建条目；最后将 `state-before.json` 恢复为 `state.json`。备份路径位于技能搜索目录之外，避免旧技能继续被加载。恢复可以复用 Python 的 `shutil.copytree(..., symlinks=True)`；不要通过链接路径递归删除它的目标。

## 传输和限制

`node.py` 每次通过 Paseo 执行临时 Python 程序，sync 携带控制中心技能快照；无常驻进程。载荷为 zlib 压缩的 JSON：编码后不超过 8000 字符时直接内联在命令中（如 inventory）；更大的载荷先经 `paseo-nodes-use` 的 `sdk-upload` 分段上传，再执行一次命令，在节点上逐段和整体核对 SHA-256，读入内存后立即删除上传文件，然后运行管理程序。未走到这一步的失败由 `node.py` 按已上传路径清理。结果按 60 字符的 base64 行封装，避免终端折行破坏 JSON。超时可能表示操作仍在进行，先重新 inventory 和检查备份再决定重试。

控制中心通过 `paseo-nodes-use/scripts/exec.sh` 调用公开的 `@getpaseo/client` 终端 API，在同一连接内发送、等待并取回结果；上传使用 SDK 声明的 `internal/daemon-client` 导出，分段机制见 [paseo-nodes-use CLI](../../paseo-nodes-use/references/cli.md#文件上传)。需要 Node 22+ 和仓库根目录的 `npm ci` 依赖；不修改 Paseo 安装文件。

`controller.py` 是 agent 与 Paseo GUI 共用的编排入口，负责来源检查、固定版本更新、多节点盘点和分发。每次盘点和分发把各节点结果写入 `nodes-status.json`，按技能库快照标记；`overview` 据此返回节点状态，快照变化后标为 `stale`。该文件只是观察记录，损坏或删除后由下一次检查重建，不作为写入依据。控制中心写任务使用 `.private/nodes-skills-manage/operation.lock`；节点 apply 在本机锁内重新计算计划，有冲突时整次不执行。外部编辑器不遵守这些锁，所以执行后仍重新盘点。

插件代码位于仓库 `plugins/nodes-skills-manage/`。后台任务和更新检查结果保留在插件进程内存中，页面关闭后任务继续；插件重启后重新检查。上游更新采用 `versions/` 中的新快照，原子更新 `source.json` 指向并保留旧目录。恢复来源时先核对旧目录摘要，再恢复对应的完整来源配置，不能仅更改 revision 标签。

首版支持 Linux/macOS、扁平技能目录和两工具共享集合；不提供 Windows、市场搜索、自动升级、双向合并、按工具启停、插件安装。已有整个母目录软链接或指向第三方目录的链接只盘点，写入前需单独整理。整个 Claude skills 目录已链接到母目录的情况可继续使用。

本机隔离测试：

```bash
python3 -B -m unittest discover -s tests -v
python3 scripts/skills.py --home /tmp/my-isolated-node inventory
```

`--home` 指定隔离节点根目录，忽略调用进程的工具目录环境变量。正式运行不要设置该参数。
