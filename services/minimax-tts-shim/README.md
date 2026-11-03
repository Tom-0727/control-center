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

测试：在仓库根目录执行 `npm run test:minimax-tts-shim`。
