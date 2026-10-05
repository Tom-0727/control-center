# 实现方案

2026-10-05 Jack 确认后实施，同日完成并在本机生效；实施记录见文末。前提是 [01-prd.md](01-prd.md) 的三分类与默认视图。

## 思路

分类在采集端算、过滤在读取端做，和现有的节点、项目筛选同一层：

- 每个节点的采集程序在生成会话卡片时，用该节点自己的 Paseo 记录判断「谁发起」，把来源写进卡片。原始会话和抽取缓存不变，不需要升抽取版本。
- 中控只读快照。页面带视图参数读取时，在本机按来源过滤，并返回过滤前的各类数量，页面用它渲染带数量的切换。

判断只有一条规则，写成一个纯函数：自动发起（定时任务或 agent 委派）的会话，第一条用户消息是启动提示，不算人说话；减掉它之后还有人发过消息就是「由人发起」；没有人说话时，定时任务发起的是「定时任务」，其余是「其他」。

依据已在本机验证：67 次 feishu-autocook run 的 agent 记录都带 `paseo.schedule-id` 标签且恰好 1 条用户消息；同目录 Jack 自己的 3 个会话没有标签。Paseo 协议另有 `paseo.parent-agent-id` 标签表示 agent 委派（`isDelegatedAgent`）。Claude 的 jsonl 本身区分不出，Paseo 发起的一律是 sdk 入口。

## 改动点

**shared/model.ts**

- 新增 `originSchema = enum(human | scheduled | other)` 和 `launcherSchema`：`{ kind: "schedule", id, name } | { kind: "agent", id } | null`。
- `sessionCardSchema` 新增必填 `origin` 与 `launcher`；`scopeSchema` 新增可选 `origin`，缺省即全部；`reviewResultSchema` 新增可选 `origins: { human, scheduled, other, schedules: [{ id, name, sessions }] }`，只由读取时的过滤填入。

**server/catalog.ts**

- `loadCatalog` 读取 agent 记录的 `labels`，为 `AgentLink` 补 `launcher`；同时读 `<paseoHome>/schedules/*.json` 得到任务 id 到 `name` 的映射，找不到时 name 回落为 id。
- `attribute()` 返回值加 `launcher`。新增纯函数 `classify(launcher, userMessages): Origin`。

**server/review.ts**

- `toCards` 写入 `origin: classify(a.launcher, s.userMessages)` 和 `launcher`。Codex 子线程仍折叠；没有 Paseo 记录的会话 launcher 为 null。

**server/snapshots.ts**

- `filterSnapshot` 在节点、项目过滤之后先统计 `origins`（含按任务名分列），再按 `scope.origin` 过滤；节点会话数和每节点 200 的上限按过滤后的会话算，`overview` 照常重算。
- 磁盘快照 `version` 升到 2；旧版本文件直接忽略、不报错，由后台采集覆盖。

**client**

- `review.tsx`：新增 `origin` 状态，默认 `human`，并入 `remembered` 和 `scope`。项目筛选下方放一个 `Choice`，四档标签带数量；满足 PRD 的显示规则（有可隐藏会话，或当前不是默认视图）才渲染；有定时任务时在其下方用一行说明按任务名分列的数量。
- `format.ts`：`ORIGIN_LABELS`。`gantt.tsx` 展开行、`detail.tsx` 详情：按 `launcher` 和 `origin` 渲染「定时 · <任务名>」「agent 委派」「无人发言」三种 Pill。
- `scripts/scan.ts` 的结果行加各类数量，便于真实数据验证。

**README 与记录**：更新「使用」「数据与传输」两节，说明三分类、默认视图和识别依据只读节点自己的 Paseo 记录。

## 测试

- `tests/fixtures.ts`：`makeHomes({ automation: true })` 额外生成一个独立项目目录下的：定时任务 run（带 schedule 标签、1 条用户消息）、插过话的 run（同标签、2 条）、agent 委派会话（parent-agent 标签、1 条）、空会话（0 条），以及 `schedules/<id>.json`。现有用例的会话计数不受影响。
- `tests/review.test.ts`：四种会话的 `origin`、`launcher` 与任务名回落；`classify` 的边界（launcher 为 null 且 0 条即其他）。
- `tests/snapshots.test.ts`：`card()` 补字段；新增按来源过滤、`origins` 统计与任务分列、上限只数可见会话、不传 `origin` 即全部；版本 1 的旧快照被忽略且不出现错误。
- `tests/fleet.test.ts`：远端结果经 schema 解析后保留 `origin`、`launcher`。

## 部署与验证

1. `npm test --workspace=session-review`、`npm run typecheck`、`npm run build:collector --workspace=session-review`。
2. 本机 daemon 直接加载仓库目录：`paseo plugin reload session-review --json`，然后 `node plugins/session-review/scripts/scan.ts today` 看各类数量是否与 PRD 表一致（今天的 run 数以当时为准）。
3. 中控（Ubuntu）要同样生效需拉取仓库并重载，另行确认后再做；其他节点不用动，新采集程序按内容摘要自动上传。
4. 提交与 PR 走现有流程：fork 分支、PR 到 upstream main，确认后再推。

## 风险与假设

- 假设一次自动发起恰好贡献 1 条用户消息。本机 67/67 成立；若 Paseo 将来在同一会话里重发提示，该 run 会被算成「由人发起」，偏向多显示而不是漏显示。
- 任务名来自节点本地的 `schedules/<id>.json`，删除任务后标签显示 id。
- 升版后首次加载没有旧快照可用，本机只采本机，几秒内恢复；中控需一轮采集。
- `claude -p`、`codex exec` 这类没有 Paseo 记录的脚本化运行有提示语就会归「由人发起」；本机目前没有这类会话，不为它加规则。

## 实施记录（2026-10-05）

- 按上述改动点实现，分支 `feat/session-review-origin-filter`。与方案的一个出入：`dist/collector.cjs` 仍不入库，改为 `gateway.ensureCollector` 在源码比产物新时自动执行 `scripts/build-collector.mjs`，失败时报出手动命令。这样中控拉取仓库后只需 reload，不必记得重建采集程序；本机没有清单，不会触发构建。
- 磁盘快照 `version` 升到 2，旧版本文件静默忽略；`init` 只对当前版本的损坏文件报错。
- 验证：session-review 38 项测试通过（新增来源分类、读取过滤与数量、旧版本快照忽略、采集程序按需重建 4 项，另在 fleet 用例里断言远端卡片保留来源），全工作区类型检查通过，collector 构建通过。
- 本机 `paseo plugin reload session-review --json` 后状态 `running`，快照在 16:50 重建为版本 2。`scan.ts today`：18 个会话，由人发起 6、定时任务 12（feishu-autocook 12）、其他 0；最近 7 天快照：129 个会话，由人发起 60、定时任务 68、其他 1（一个没人发言的空会话）。用服务端 `filterSnapshot` 跑真实快照：默认视图 6 个全是 Jack 自己的会话，汇总随之重算；「定时任务」12 个全是 run；「全部」18 个。
- 一个事实：Jack 在 feishu-autocook 目录里的 3 个设计讨论会话是在 Jack-Env 工作区开的，按既有的「Paseo 记录优先」归属规则属于 Jack-Env 项目，所以项目选 feishu-autocook 时默认视图为空；PRD 验收第 2 条已照实修正。
- 中控尚未更新：拉取后 reload 即可，远端节点会在下一次采集前收到自动重建的采集程序。
