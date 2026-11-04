#!/usr/bin/env bash
# 放宽 dsh 调用 MCP 工具的超时。dsh 通过 ACP 挂载 Paseo 的 MCP 服务器时不读
# toolCallTimeoutMs 配置，固定用 60 秒；Paseo 的 speak 要等朗读播完才返回，
# 长回复超过 60 秒会报 Request timed out，agent 随后重读一遍。
# 升级 dsh 后会被覆盖，需重新执行；对之后新建的 dsh agent 生效。
# 用法：./tune-dsh-mcp-timeout.sh [毫秒，默认 600000]
set -euo pipefail

TIMEOUT_MS="${1:-600000}"

FILE="$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js"
[ -f "$FILE" ] || { echo "找不到 $FILE，dsh 安装路径或版本已变" >&2; exit 1; }
grep -q '^const DEFAULT_TOOL_CALL_TIMEOUT_MS = ' "$FILE" \
  || { echo "常量名已变，需按新版源码调整本脚本" >&2; exit 1; }

sed -i.bak -E "s/^const DEFAULT_TOOL_CALL_TIMEOUT_MS = [0-9e.]+;/const DEFAULT_TOOL_CALL_TIMEOUT_MS = ${TIMEOUT_MS};/" "$FILE"
rm -f "$FILE.bak"
grep '^const DEFAULT_TOOL_CALL_TIMEOUT_MS = ' "$FILE"
