#!/usr/bin/env bash
# 调高 Paseo 语音模式的开口判定门槛，减少误触发。Paseo 0.15 未开放这两个参数，
# 只能改安装目录里的常量；升级 Paseo 后会被覆盖，需重新执行，每台开语音模式的节点各执行一次。
# 用法：./tune-vad.sh [分数线 0-1，默认 0.95] [持续毫秒，默认 1000]
set -euo pipefail

THRESHOLD="${1:-0.95}"
CONFIRM_MS="${2:-1000}"

ROOT="$(npm root -g)/@getpaseo/cli/node_modules/@getpaseo/server"
FILE="$ROOT/dist/server/server/speech/providers/local/sherpa/silero-vad-session.js"
[ -f "$FILE" ] || { echo "找不到 $FILE，Paseo 安装路径或版本已变" >&2; exit 1; }
grep -q '^const DEFAULT_SILERO_THRESHOLD = ' "$FILE" && grep -q '^const DEFAULT_CONFIRM_MS = ' "$FILE" \
  || { echo "常量名已变，需按新版源码调整本脚本" >&2; exit 1; }

sed -i.bak -E \
  -e "s/^const DEFAULT_SILERO_THRESHOLD = [0-9.]+;/const DEFAULT_SILERO_THRESHOLD = ${THRESHOLD};/" \
  -e "s/^const DEFAULT_CONFIRM_MS = [0-9]+;/const DEFAULT_CONFIRM_MS = ${CONFIRM_MS};/" \
  "$FILE"
rm -f "$FILE.bak"
grep -E '^const DEFAULT_(SILERO_THRESHOLD|CONFIRM_MS) = ' "$FILE"

echo "已修改。执行 paseo restart 后生效（可能打断正在运行的 agent，挑空闲时做）。"
