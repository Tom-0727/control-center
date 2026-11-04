# MiniMax 语音合成转接（minimax-tts-shim）

让 Paseo 语音模式用 MiniMax 朗读回复。Paseo 只支持 OpenAI 格式的语音合成接口，本服务在本机提供这个接口并转给 MiniMax。它只做格式转换，不保存密钥：MiniMax key 填在 Paseo 的语音设置里，请求时原样转发。

## 安装与更新

每台开启语音模式的节点各装一份，要求 Node 22+：

```bash
cd <本仓库目录>/services/minimax-tts-shim
./install.sh
```

Linux 装为 systemd 用户服务，macOS 装为 LaunchAgent，开机或登录后自动运行，只监听 `127.0.0.1:6790`（端口见 `server.mjs` 的 `PORT`）。拉取新代码后重新执行 `./install.sh` 即可重启生效。日志：Linux 用 `journalctl --user -u minimax-tts-shim`，macOS 在 `~/Library/Logs/minimax-tts-shim.log`。

## Paseo 语音设置

| 项 | 语音合成（经本服务） | 语音识别（直连 MiniMax） |
|---|---|---|
| Provider | OpenAI | OpenAI |
| Base URL | `http://127.0.0.1:6790/v1` | `https://api.minimaxi.com/v1/speech_to_text?_=` |
| API key | MiniMax key | MiniMax key |
| 模型 | MiniMax 语音模型，如 `speech-2.8-turbo` | `asr-1.0` |
| 音色 / 语言 | MiniMax 的 `voice_id`，如 `female-chengshu` | `zh` |

识别地址末尾的 `?_=` 让 Paseo 追加的 `/audio/transcriptions` 落进查询参数，请求实际发到 MiniMax 的识别接口。可用音色可通过 MiniMax 的 `POST /v1/get_voice`（`{"voice_type":"system"}`）查询。

Agent 用 Paseo 的 `speak` 工具朗读回复，0.15 默认不给 Agent 注入 Paseo 工具，需在 `config.json` 设 `"daemon": {"mcp": {"injectIntoAgents": true}}` 并 `paseo reload`，否则语音模式只识别、Agent 只用文字回复。注入后该节点所有 Agent 都带有 Paseo 的 MCP 工具。

判停（`turnDetection`）只能选本地。识别和合成都不用本地模型时，Paseo 0.15 不会启动本地语音进程，语音模式会报 `turn_detection_unavailable`；需在 `~/.paseo/config.json` 写上 `"providers": {"local": {"modelsDir": "<PASEO_HOME>/models/local-speech"}}` 并重启 daemon。判停模型随 Paseo 自带，不会下载其他模型。

误触发：语音模式持续收音，由本地模型判断是否开口。Paseo 0.15 写死的人声分数线 0.5 偏低，键盘声、旁人说话、外放的朗读都会被当成开口。本目录的 `./tune-vad.sh [分数线] [持续毫秒]` 直接改安装目录里的常量（默认分数线 0.8，持续 800 毫秒即 Paseo 原值），执行后 `paseo restart` 生效。Paseo 升级会覆盖，需重新执行；分数线过高会漏掉小声说话，持续毫秒过高会漏掉短句。外放时仍可能被自己的朗读触发，建议戴耳机。

朗读两遍：dsh 通过 ACP 挂载 Paseo 工具时固定 60 秒超时，而 `speak` 要播完才返回，长回复会报 `Request timed out`，agent 以为没读出来又读一遍。在用 dsh 的节点执行 `./tune-dsh-mcp-timeout.sh [毫秒]`（默认 600000），对之后新建的 dsh agent 生效；升级 dsh 后需重新执行。

测试：在仓库根目录执行 `npm run test:minimax-tts-shim`。
