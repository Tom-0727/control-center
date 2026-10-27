# 公共来源

控制中心 `.private/nodes-skills-manage/source.json`（`version: 2`）登记公共技能的上游来源列表和当前快照。加入维护只需登记来源；支持的分发格式由 `scripts/upstreams.py` 实现，不为单个提供方写专用代码。常规同步传入快照目录，不会访问上游。

```json
{
  "version": 2,
  "sources": [
    {"id": "team-skills", "type": "git", "url": "https://github.com/org/repo.git", "ref": "main", "path": "skills", "skills": "*"},
    {"id": "vendor", "type": "well-known", "url": "https://example.com/.well-known/agent-skills/index.json", "skills": ["vendor-suite"]}
  ],
  "snapshot": {
    "directory": "versions/<revision>-<id>",
    "prepared_at": "<UTC 时间>",
    "skills": {"<name>": {"digest": "<内容摘要>", "source": "<来源 id>", "revision": "<上游版本>"}}
  }
}
```

## 来源字段

| 字段 | 说明 |
|---|---|
| `id` | 来源标识，小写字母、数字和连字符，最长 64 个字符；快照记录用它指回来源 |
| `type` | `git` 或 `well-known` |
| `url` | `git`：`https://` 仓库地址（测试可用本机绝对路径）；`well-known`：发现索引地址，只填站点前缀时自动补 `/.well-known/agent-skills/index.json` |
| `ref` | 仅 `git`，分支、标签或 commit，默认 `HEAD` |
| `path` | 仅 `git`，仓库内技能目录，默认仓库根目录 |
| `skills` | `"*"` 表示来源中的全部技能，或列出要纳入的技能名；默认 `"*"` |

- **git**：浅克隆 `ref`，读取 `path` 下的 `<name>/SKILL.md` 目录，保留全部 supporting files。`skills: "*"` 要求该目录只含技能目录，混有其他目录时须设置 `path` 或列出技能。上游版本记录为 commit。
- **well-known**：遵循 [Agent Skills discovery v0.2.0](https://specification.website/spec/agent-readiness/agent-skills-discovery/)。索引须声明 `$schema`，条目类型为 `skill-md` 或 `archive`（tar.gz、zip，`SKILL.md` 位于根目录或唯一顶层目录）。下载只走 HTTPS，内容须与条目 `sha256` digest 一致，`SKILL.md` 的 `name` 须与条目一致；拒绝路径穿越、链接和特殊文件。上游版本记录为该条目 digest。

不同来源的技能不能重名（忽略大小写），检查时直接报错，不自行选择覆盖版本。不把来源文档中提及的外部依赖自动加入公共集合。

## 登记和移除来源

`controller.py add-source` 输入 `{"source": {...}}`：校验字段、实际拉取一次来源并检查与已有技能重名，通过后写入列表，返回将纳入的技能名。`remove-source` 输入 `{"id": "..."}`，只从列表移除。两者都只改来源列表，技能在下一次更新快照时加入或移出，在下一次分发时到达或撤离节点。

## 更新快照

使用 `controller.py check-update` 拉取全部来源，得到逐技能的新增、修改、移除及文件差异；授权后将完整结果作为 `{"preview": <结果>}` 输入 `apply-update`。此入口与 GUI 共用控制中心写锁。

1. 检查前按 `snapshot.skills` 摘要核对现有快照，有未登记修改时停止，保留这些修改待处理。
2. 预览中的每个技能带 `source` 和 `revision`。应用时按这些版本重新拉取：Git 固定到预览时的 commit；well-known 条目 digest 已变化时停止，需重新检查。来源列表在两步之间变化时同样停止。
3. 新快照写入 `versions/` 下的新目录，核对摘要后原子更新 `source.json` 指向，旧目录保留；准备时间不代表已经分发。
4. 只有用户请求分发时才调用节点同步。仅登记来源或更新控制中心快照不会修改各节点。

`summary` 输出 `sources`（含各来源已纳入快照的 `installed`）、每个技能的 `source` 和 `revision`，以及整个技能库的合并版本 `revision`。

## 部署与所有权

`.private/` 已被控制中心 Git 忽略；技能内容与本机快照状态不会混入管理工具代码。控制中心重新部署时需恢复或重新登记此来源配置。

首次分发前确认这批技能的现有管理者：若 CC Switch、插件安装器、`lark-cli update` 等也管理同名技能目录，先整理所有权，避免后续更新互相覆盖。上游 README 中的其他安装方式是上游建议；本控制中心按用户已选择的 `nodes-skills-manage` 方案管理，不因此改回其他安装器。
