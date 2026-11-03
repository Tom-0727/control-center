#!/usr/bin/env bash
# Runs server.mjs from this checkout as a per-user service that starts at boot or login
# and restarts if it exits: a systemd user unit on Linux, a LaunchAgent on macOS.
# Re-running it rewrites the service and restarts it, which also loads updated code.
set -euo pipefail

dir="$(cd "$(dirname "$0")" && pwd)"
node="$(command -v node)"
name=minimax-tts-shim

case "$(uname -s)" in
  Linux)
    unit="$HOME/.config/systemd/user/$name.service"
    mkdir -p "$(dirname "$unit")"
    cat >"$unit" <<EOF
[Unit]
Description=MiniMax TTS shim for Paseo voice mode

[Service]
ExecStart=$node $dir/server.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable "$name.service"
    systemctl --user restart "$name.service"
    ;;
  Darwin)
    label="com.atectix.$name"
    plist="$HOME/Library/LaunchAgents/$label.plist"
    cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>$node</string><string>$dir/server.mjs</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/$name.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/$name.log</string>
</dict>
</plist>
EOF
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$plist"
    ;;
  *)
    echo "Unsupported OS: $(uname -s)" >&2
    exit 1
    ;;
esac
echo "$name installed: $node $dir/server.mjs"
