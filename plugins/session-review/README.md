# Paseo 会话复盘（session-review）

装在任意一台 Paseo daemon 上的原生插件。它始终复盘本机的 Claude Code / Codex 会话；如果这台机器配置了 `paseo-nodes-use` 的节点清单和配对链接，就同时复盘清单里的其他节点，被采集的节点不需要安装任何东西。按节点、项目和日期查看会话时间线、确定性决策点和消息详情，始终包含全部分支；默认全部节点、今天。

本实现接续 PR #1，修复解析、脱敏、缓存并发问题并扩展跨节点采集。范围与实现见 [全节点 PRD](../../.atectix/product-features/session-review-all-nodes/01-prd.md)、[实现方案](../../.atectix/product-features/session-review-all-nodes/02-implementation-plan.md)。原始 [单节点 PRD](../../.atectix/product-features/session-review/01-prd.md) 保留为上游设计记录。

## 安装与更新

要求：Paseo 0.9.2+、Node 22+、已启用 Plugins。只复盘本机不需要任何配置。

```bash
cd <本仓库目录>
npm ci
npm run typecheck
npm test --workspace=session-review
npm run build:collector --workspace=session-review   # 可选：采集其他节点的程序比源码旧时会自动重建
paseo plugin install "$PWD/plugins/session-review" --json
```

装到远端节点时把最后一行换成 `.agents/skills/paseo-nodes-use/scripts/node.sh <节点> plugin install ...`。更新代码后执行 `paseo plugin reload session-review --json`（远端同样经 `node.sh`），重载不会重启 agent。拉取新代码后也只需重载：采集其他节点用的 `dist/collector.cjs` 不入库，比源码旧时会在下一次采集前自动重建。

## 设置

Paseo 设置页「复盘」里的三项都可以留空：

| 设置 | 留空时 | 填写后 |
|---|---|---|
| 节点清单目录 | 使用环境变量或默认清单；找不到清单时只复盘本机 | 读取其中的 `relay-allowed-hosts.json` 和 `.private/` 配对链接，同时复盘清单里的节点。中控上这就是 `paseo-nodes-use` 使用的部署目录 |
| control-center 仓库目录 | `~/control-center` | 本机仓库检出位置，采集其他节点时使用其中的 `paseo-nodes-use` 脚本和 `dist/collector.cjs` |
| 时区 | daemon 本机时区 | 日期范围和时间轴使用的 IANA 时区；跨节点复盘时各节点建议填同一个值 |

对应的环境变量 `PASEO_DEPLOY_DIR`、`SR_CONTROL_CENTER`、`SR_TIMEZONE` 在没有设置值时生效，`scripts/scan.ts` 只认环境变量。中控沿用 `node.sh` 的默认目录 `/home/ubuntu/paseo-deployment`，无需改设置；清单指向的目录不存在时页面会说明，并继续复盘本机。改时区会清空快照重新采集，改目录只触发一次刷新。

## 使用

1. 侧栏「复盘」打开页面；工作区中也可通过命令中心「打开会话复盘」进入当前项目。
2. 页面直接读取本地快照；节点、项目筛选在本机完成，不重新连接节点。后台每 5 分钟采集一次，页面显示采集时间和各节点状态，本机标注「（本机）」。只有一个节点时不显示节点选择和节点标签。
3. 项目选项只显示项目名称；节点来源显示在会话行和详情中。同名项目和相同会话 ID 仍保留独立归属。没有分支筛选，始终展示范围内全部分支的会话。
4. 每个会话按发起方式归为一类：有人发过消息的是「由人发起」（自己开的，或插话进定时任务、agent 委派会话的）；Paseo 定时任务发起且没人说话的是「定时任务」；两者都不是的归「其他」（agent 委派而没人插话的会话、没人发言的空会话）。页面默认只看「由人发起」，切换控件带各档数量并按定时任务名分列；范围内没有可隐藏的会话时不显示。汇总和决策点跟随当前视图，被隐藏的会话不占每节点 200 个的名额。展开行和详情用「定时 · 任务名」「agent 委派」「无人发言」标出来源。
5. 时间线每行一个会话，点击展开，再点「查看消息」。较长消息流通过「更多消息」分页读取。
6. 远端节点有唯一运维工作区或只有一个工作区时自动使用；否则页面让用户选择一个已有工作区。不会新建项目或工作区。

插件启动时恢复磁盘快照，并在后台更新「今天」「昨天」「最近 7 天」；每 5 分钟再更新一次。扫描较慢时复用当前任务，不叠加扫描；更新期间继续展示已有数据。「立即更新」可提前触发后台采集。

自定义日期范围首次使用时会后台补采，之后从快照读取；最近使用的 8 个自定义范围也会定时更新。日期按设置的时区切换，跨天不会把昨天的快照当成今天。节点离线时保留相同日期范围内的上次成功结果，并标明时间；没有旧快照的节点不计入统计。节点清单读取失败时本机结果照常返回，原因显示在页面上。

## 数据与传输

- 原始会话保留在来源节点，解析与脱敏在节点本机完成。只读取当前 daemon 用户的会话目录。
- 来源分类在采集节点上完成，只读该节点自己的 Paseo agent 记录标签（`paseo.schedule-id`、`paseo.parent-agent-id`）和 `schedules/` 里的任务名，不读会话正文；没有 Paseo 记录的会话按是否有人发言归类。视图切换只在读取快照时过滤，不触发采集。
- 快照和已选工作区保存在 `~/.paseo/session-review/snapshots.json`（或 `$PASEO_HOME/session-review/snapshots.json`），位于仓库外，不提交 Git。文件权限为 `0600`，使用原子替换；最多保留 32 个日期范围快照，重载或重启插件后恢复，另一时区下生成的快照不会被复用。
- 脱敏后的抽取缓存位于各节点 `~/.paseo/session-review/extracts/`，文件名带解析版本号（`*.v5.json`），支持 `PASEO_HOME`、`CLAUDE_CONFIG_DIR`、`CODEX_HOME`。一台机器同时被中控采集又自己装了插件时，不同版本的缓存互不覆盖；启动时保留其他版本和无版本文件，供仍在运行的旧版读取；仅在当前版本文件不存在时，为内容版本一致的旧文件建立缓存，不覆盖已有结果。
- 采集程序按内容摘要保存到远端节点的 `session-review/collectors/`，使用现有 Paseo 上传通道并校验摘要；临时上传分片在拼接后删除。
- 大结果通过压缩、分块读取绕开终端滚动缓冲限制。临时结果放在 `session-review/transfers/`，读取后删除；传输中断留下的结果在后续大结果采集时清理超过一天的文件。
- 后台快照采集全部项目。页面按节点、项目筛选后，每个节点最多展示 200 个可见会话；超限提示收窄范围，不截断快照。
- 没有 AI 归纳、自动分类、会话干预或外部发送。

## 验证

```bash
npm test --workspace=session-review
npm run typecheck --workspace=session-review
npm run build:collector --workspace=session-review
node plugins/session-review/scripts/scan.ts today
node plugins/session-review/scripts/scan.ts last7
```

`scan.ts` 走与插件相同的采集路径：先打印本机身份、清单状态和时区，再输出每个节点的状态、计数、各来源的数量和一条消息详情的条数，不输出会话正文。测试包括原解析用例、8 类修复回归、无清单时只复盘本机、清单缺失或读取失败的降级、清单去重本机、跨节点 ID 隔离与部分失败、设置与环境变量的优先级、多时区日期边界与夏令时、缓存文件版本迁移，以及定时采集、磁盘恢复、筛选复用、离线保留、跨天切换、时区切换和任务清理。
