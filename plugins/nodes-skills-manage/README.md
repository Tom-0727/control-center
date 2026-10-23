# Paseo 公共 Skills

独立的 Paseo 原生插件，代码和管理脚本均在 control-center 仓库。通过官方插件 API 接入，不修改 Paseo 源码、安装文件或 Web bundle。插件仅安装在控制中心。

## 安装

环境：Paseo 0.9.2 及以上、Node 22+、Python 3.9+、Git，以及现有节点登记与公共来源配置。

```bash
cd <control-center 仓库目录>
npm ci
npm run typecheck
```

在 Paseo 的控制中心主机设置中开启 Plugins，再通过现有包装器安装：

```bash
.agents/skills/paseo-nodes-use/scripts/node.sh <控制中心节点> plugin install "$PWD/plugins/nodes-skills-manage" --json
```

服务端默认从 Paseo 加载本插件的仓库（`$PASEO_HOME/config.json` 中插件路径的上两级）调用管理脚本；要改用其他检出时，在 daemon 环境设置 `NSM_CONTROL_CENTER`。节点地址、工作区和来源均从现有运行配置读取。

在 Paseo Web 选择控制中心节点，打开侧栏“公共 Skills”。更新插件后运行 `node.sh <控制中心节点> plugin reload nodes-skills-manage --json`，客户端重新连接即可加载。插件要求 Paseo `>=0.9.2`；Paseo 升级后需验证公开插件 SDK 兼容性。

## 使用

1. 概览显示技能数、来源数、节点数和一致性统计。节点状态取自控制中心记录的最近一次检查，agent 或本页面执行的扫描、同步都会更新它；技能库更新后显示「待重新检查」。每个技能旁展示来源，点击技能打开详情卡片。
2. 「来源」列出登记的 Git 仓库和 well-known 发现索引。「添加来源」会实际拉取一次并检查重名后登记；「移除」只改来源列表。两者都在下一次检查并确认更新后才改变技能库。
3. 点击「检查更新」；有更新时点击「更新技能库」，在卡片中查看文件差异并确认。
4. 选择节点后点击「扫描」查看一致状态，或点击「同步」直接分发并校验，没有预览和确认。进度在节点区域原位显示，结束后可打开任务结果查看每个节点写入、移除的内容和冲突。

控制中心快照更新与节点同步是两个独立操作。同步时每个节点先盘点：已一致的不传输；不一致的传输一次、写入并重新盘点，通过后才标为校验通过。有本地修改或同名内容的节点整节点跳过，不覆盖，其余节点继续。

任务在控制中心后台运行，离开页面后继续。内存保留最近 20 个完成任务，最长一小时；插件重启后重新盘点。超时或断连可能发生在节点已开始写入之后，先重新扫描实际状态，再决定是否重新同步。

与 agent 共用 `.agents/skills/nodes-skills-manage/scripts/controller.py`。只管理公共集合，节点专属技能由原管理入口处理。检查更新覆盖 `source.json` 中登记的全部来源（Git 仓库和 well-known 发现索引）。

## 验证

```bash
npm run typecheck
npm run test:plugin
python3 -B -m unittest discover -s .agents/skills/nodes-skills-manage/tests -q
```
