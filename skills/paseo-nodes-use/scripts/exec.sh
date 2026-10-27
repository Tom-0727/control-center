#!/usr/bin/env bash
# 用法：exec.sh <节点> --workspace <id> [--timeout 秒] -- <shell 命令>
# 在指定 workspace 中开临时终端执行命令（工作目录为 workspace 目录），输出结果并返回退出码，结束后关闭终端。
set -euo pipefail

NODE_SH="$(dirname "$0")/node.sh"
die() { echo "exec.sh: $*" >&2; exit 2; }

[[ $# -ge 1 ]] || die "用法：exec.sh <节点> --workspace <id> [--timeout 秒] -- <命令>"
node="$1"; shift
ws=""; timeout=300
while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace) ws="$2"; shift 2 ;;
    --timeout) timeout="$2"; shift 2 ;;
    --) shift; break ;;
    *) die "未知参数 $1" ;;
  esac
done
[[ -n "$ws" ]] || die "必须指定 --workspace"
[[ $# -ge 1 ]] || die "缺少命令"
cmd="$*"

exec "$NODE_SH" "$node" sdk-exec --workspace "$ws" --timeout "$timeout" -- "$cmd"
