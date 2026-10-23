# paseo CLI 速查（0.12.0）

以下子命令均通过 `scripts/node.sh <节点>` 调用。

## run

`run [options] <prompt>`

- `--no-wait` 后台运行，立即返回（旧写法 `-d` / `--background` 已弃用）
- `--title <title>`、`--label <k=v>` 标题、标签
- `--provider <p>` / `--model <m>` / `--thinking <id>` / `--mode <mode>`
- `--workspace <id>` 必填，在该 workspace 目录下运行（`node.sh` 禁止 `--new-workspace` / `--worktree*`）
- `--env <k=v>` 环境变量
- `--wait-timeout <duration>` 前台运行时的最长等待

## 观察

- `ls [-a] [-g] [--label k=v]` 列出任务；`-g` 跨目录，`-a` 含已归档
- `inspect <id>` 任务详情
- `logs <id> [--tail n] [--filter tools|text|errors|permissions] [--since t]`
- `wait <id> [--timeout 秒]` 等待任务空闲

## 干预

- `send <id> [prompt] [--prompt-file f] [--no-wait]`
- `stop <id>` 中断；`archive <id>` 归档；`delete <id>` 删除
- `permit ls`、`permit allow|deny <agent> [req_id]`

## 节点信息

- `provider ls`、`provider models <provider>`、`provider diagnostic <provider>`
- `workspace ls`、`project ls`、`terminal ls --all`

## 终端执行

`exec.sh` 经 `node.sh` 核对身份后，由 `terminal-exec.mjs` 使用公开的 `@getpaseo/client` API 创建临时终端。在同一连接中发送命令、等待输出和退出码，结束后关闭终端。这样避免 CLI 发送后立即断开而丢失中继输入。超过 `--timeout` 15 秒仍无结果时强制关闭，节点上的命令可能仍在执行，先检查状态再重试。

## 文件上传

`node.sh <节点> sdk-upload [--timeout 秒] -- <本地文件>` 由 `upload.mjs` 调用 Paseo 原生二进制上传（网页端附件使用的同一接口），文件写入节点 `<PASEO_HOME>/uploads/upload_<id>/nsm-<摘要>.partNNNN`。stdout 为 NDJSON：`progress`（`bytes`、`total_bytes`），最后一条 `result`（`sha256`、`size`、按顺序的 `parts[{path,size,sha256}]`）或 `error`（`uploaded` 列出已写入的路径）。

- **分段确认**：SDK 的 `uploadFile` 不做流量控制，整文件会排在连接心跳前面；心跳 15 秒无响应两次即断开。每段等节点写完再发下一段，心跳最多被一段耽误。
- **分段大小**：首段 256 KB，按实测耗时调整：少于 3 秒加倍，超过 6 秒减半，范围 64 KB–8 MB。失败的段减半后重连重试，最多 3 次。延迟高的节点不会因固定开销被切得过碎。
- **清理**：守护进程只自动删除未完成的上传；已完成的分段由调用方拼接、校验 SHA-256 后删除，失败时按 `uploaded` 删除。

实测（2026-09-30）：新加坡同机房节点 1 MB 约 0.6 秒；Lenovo 往返约 0.5 秒，2.2 MB 分 6 段完成。

`uploadFile` 只在 `DaemonClient` 上，SDK 以 `@getpaseo/client/internal/daemon-client` 导出（`createPaseoClient` 内部使用的同一个类）。这是包声明的导出路径，不打补丁；但属于内部接口，升级 SDK 后运行 `npm run test:paseo-nodes` 并实测一次上传。

控制中心需要 Node 22+，在仓库根目录执行 `npm ci` 安装锁定的 SDK；不修改 Paseo 安装文件，也不加载运行时补丁。升级 SDK/Paseo 后验证本机与中继的执行和上传路径。
