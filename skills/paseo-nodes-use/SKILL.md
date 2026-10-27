---
name: paseo-nodes-use
description: 通过 Paseo 控制已连接的节点（机器）。当用户按机器名称或别名（如 Lenovo、VM-SG:2c-2g、入口服务器）要求查看节点、在某台机器上运行 agent 任务、查看或干预任务、或在节点上执行 shell 命令时使用。
---

# Paseo 节点控制

所有操作通过 `scripts/` 下的脚本完成（路径相对本文件）。脚本负责按名称解析节点、核对 serverId、带凭据调用 `paseo`，凭据不会出现在输出中。

```
scripts/node.sh list                                   # 列出节点
scripts/node.sh <节点> <paseo 子命令...>                # 在节点上执行 paseo 子命令（子命令放最前）
scripts/exec.sh <节点> --workspace <id> -- <命令>       # 在节点上执行 shell 命令
scripts/node.sh <节点> sdk-upload -- <本地文件>          # 上传文件到节点，返回节点上的分段路径
```

`<节点>` 为 name 或任一别名，忽略大小写。stderr 首行 `[node] <name> <serverId>` 即核对结果。

## 能力

| 能力 | 命令 |
|---|---|
| 1. 解析节点 | `node.sh list` |
| 2. 检查节点 | `node.sh <节点> ls -g --json`（连通性）；`node.sh <节点> provider ls --json`（可用 provider） |
| 3. 下发任务 | `node.sh <节点> run --workspace <id> --provider <claude\|codex>[/模型] --no-wait --title <标题> --json "<任务>"` |
| 4. 观察任务 | `ls -g --json`、`inspect <id> --json`、`logs <id> --tail <n>`、`wait <id> --timeout <秒>` |
| 5. 干预任务 | `send <id> "<消息>"`、`stop <id>`、`permit ls`、`permit allow\|deny <id> [req_id]` |
| 6. 执行 shell | `exec.sh <节点> --workspace <id> [--timeout 秒] -- <命令>`，返回命令输出和退出码 |
| 7. 上传文件 | `node.sh <节点> sdk-upload [--timeout 秒] -- <本地文件>`，分段写入节点 Paseo `uploads/`；用完由调用方拼接校验并删除 |

更多参数见 [references/cli.md](references/cli.md)。

## 选择 workspace

下发任务和执行 shell 必须在已有 workspace 中进行，脚本会拒绝未指定 workspace 或新建 project/workspace 的操作。

1. `node.sh <节点> workspace ls --json` 列出该节点的 workspace。
2. 按任务语义匹配 workspace 的 `name`、`project`、`cwd`，选出最合适的一个。
3. 没有明显合适的 workspace 时，列出候选并询问用户，不要自行新建。

## 降低可见度

- 任务完成并取回结果后，执行 `archive <id>` 归档，除非用户要求保留。
- `exec.sh` 的临时终端在命令结束后自动关闭。

## 规则

- **核对 serverId**：`[node]` 行的 serverId 与预期不符或脚本报错时停止，不要绕过脚本直接调用 `paseo --host`。
- **目录属于节点**：路径都指目标节点上的路径，注意区分本机与节点上的同名目录。
- **凭据不回显**：不要读取或打印 `.private/` 下的文件内容。
- **节点密码**：`.private/<name 或别名>.password`（入口服务器为 `local.password`），脚本自动读取；`exec.sh` 的 SDK 连接会发送并校验，CLI（0.10.3–0.12.0）经配对链接暂不发送（靠上游兼容放行）。
- **区分超时和离线**：连通性用 `ls -g --json` 探测（等待 15 秒）；不要用 `status` / `daemon status`，它只等 1.5 秒，会误报离线。
- 统一加 `--json`，以便解析结果。
