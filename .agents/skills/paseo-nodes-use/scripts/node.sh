#!/usr/bin/env bash
# 用法：
#   node.sh list                      列出节点
#   node.sh <节点> <paseo 子命令...>   解析节点、核对 serverId 后带凭据调用 paseo
set -euo pipefail

DEPLOY_DIR="${PASEO_DEPLOY_DIR:-/home/ubuntu/paseo-deployment}"
REGISTRY="$DEPLOY_DIR/relay-allowed-hosts.json"
PRIVATE="$DEPLOY_DIR/.private"

die() { echo "node.sh: $*" >&2; exit 2; }
[[ -r "$REGISTRY" ]] || die "找不到节点清单 $REGISTRY"
[[ $# -ge 1 ]] || die "用法：node.sh list | node.sh <节点> <paseo 子命令...>"

if [[ "$1" == "list" ]]; then
  jq -r '.[] | [.name, .serverId, (.aliases | join(", "))] | @tsv' "$REGISTRY"
  exit 0
fi

query="$1"; shift
[[ $# -ge 1 ]] || die "缺少 paseo 子命令"

# 名称或别名匹配，忽略大小写，精确匹配
node_json=$(jq -c --arg q "$query" \
  '[.[] | select(([.name] + .aliases) | map(ascii_downcase) | index($q | ascii_downcase))]' "$REGISTRY")
count=$(jq length <<<"$node_json")
[[ "$count" -eq 1 ]] || die "节点 \"$query\" 匹配到 $count 个，可用 node.sh list 查看"
name=$(jq -r '.[0].name' <<<"$node_json")
expected=$(jq -r '.[0].serverId' <<<"$node_json")

# 按 name/aliases 查找配对链接文件
link_file=""
while IFS= read -r key; do
  [[ -r "$PRIVATE/$key.pairing-link" ]] && { link_file="$PRIVATE/$key.pairing-link"; break; }
done < <(jq -r '.[0] | ([.name] + .aliases)[]' <<<"$node_json")

redact() { sed -u -E 's#https?://[^[:space:]"]*\#[^[:space:]"]*#<pairing-link>#g'; }

if [[ -n "$link_file" ]]; then
  link=$(<"$link_file")
  actual=$(node -e '
    const h = new URL(process.argv[1]).hash.slice(1).replace(/^offer=/, "");
    console.log(JSON.parse(Buffer.from(decodeURIComponent(h), "base64url")).serverId);
  ' "$link") || die "无法解析 $name 的配对链接"
  [[ "$actual" == "$expected" ]] || die "$name serverId 不一致：清单 $expected，配对链接 $actual"
  host_args=(--host "$link")
  # 节点直连密码：.private/<name 或别名>.password；0.10 起 relay 连接也校验密码
  if [[ -z "${PASEO_PASSWORD:-}" ]]; then
    while IFS= read -r key; do
      [[ -r "$PRIVATE/$key.password" ]] && { PASEO_PASSWORD=$(<"$PRIVATE/$key.password"); export PASEO_PASSWORD; break; }
    done < <(jq -r '.[0] | ([.name] + .aliases)[]' <<<"$node_json")
  fi
else
  # 无配对链接则视为本机 daemon
  local_status=$(paseo status --json 2>/dev/null)
  actual=$(jq -r '.serverId // empty' <<<"$local_status")
  [[ "$actual" == "$expected" ]] || die "$name 没有配对链接，且本机 serverId（${actual:-未知}）与清单 $expected 不一致"
  if [[ -z "${PASEO_PASSWORD:-}" && -r "$PRIVATE/local.password" ]]; then
    PASEO_PASSWORD=$(<"$PRIVATE/local.password"); export PASEO_PASSWORD
  fi
  host_args=()
fi

# workspace 规范：执行必须指定已有 workspace，禁止新建 project/workspace
[[ "$1" != -* ]] || die "paseo 子命令须放在参数最前"
has_ws=false
for a in "$@"; do [[ "$a" == --workspace || "$a" == --workspace=* ]] && has_ws=true; done
sub="$1 ${2:-}"; [[ "$1" == agent ]] && sub="${2:-} ${3:-}"
case "$sub" in
  "run "*|"terminal create"|"sdk-exec "*)
    $has_ws || die "$sub 必须带 --workspace <id>，先用 workspace ls 选择已有 workspace"
    for a in "$@"; do [[ "$a" == --new-workspace* || "$a" == --worktree* ]] && die "禁止新建 workspace（$a）"; done ;;
  "workspace create"|"project create"|"clone "*|"worktree "*)
    die "禁止新建 project/workspace（$sub）" ;;
esac

# 不继承调用方的 paseo agent 身份，避免任务挂到当前会话下
unset PASEO_AGENT_ID PASEO_AGENT_CWD PASEO_WORKSPACE_ID PASEO_TERMINAL_ID

echo "[node] $name $actual" >&2
set +e
if [[ "$1" == sdk-exec || "$1" == sdk-upload ]]; then
  helper=terminal-exec.mjs; [[ "$1" == sdk-upload ]] && helper=upload.mjs
  shift
  export PASEO_NODE_EXPECTED_ID="$expected"
  if [[ -n "$link_file" ]]; then
    export PASEO_NODE_OFFER="$link"
  else
    export PASEO_NODE_ENDPOINT
    PASEO_NODE_ENDPOINT=$(jq -r '.listen // empty' <<<"$local_status")
  fi
  node "$(dirname "$0")/$helper" "$@" 2> >(redact >&2) | redact
  exit "${PIPESTATUS[0]}"
fi
paseo "${host_args[@]}" "$@" 2> >(redact >&2) | redact
exit "${PIPESTATUS[0]}"
