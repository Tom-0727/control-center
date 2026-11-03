#!/usr/bin/env node
// OpenAI-shaped speech endpoint for Paseo voice mode, backed by MiniMax T2A v2.
//
// Paseo's OpenAI TTS provider POSTs {model, voice, input, response_format: "pcm"} to
// <baseUrl>/audio/speech and plays the body as 24 kHz 16-bit mono PCM. MiniMax has no
// endpoint of that shape, so this translates the request and returns MiniMax's
// hex-encoded audio as raw bytes. The caller's bearer token is forwarded unchanged:
// the MiniMax key stays in Paseo's voice settings and this process holds no secret.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const PORT = 6790;
const MINIMAX_T2A = 'https://api.minimaxi.com/v1/t2a_v2';
// Paseo plays voice replies at this rate; audio at any other rate plays at the wrong speed.
const SAMPLE_RATE = 24000;
const UPSTREAM_TIMEOUT_MS = 30000;

function reply(res, status, body, contentType = 'application/json') {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(contentType === 'application/json' ? JSON.stringify(body) : body);
}

// OpenAI's error shape, so Paseo logs the reason instead of an unparseable body.
const fail = (res, status, message) => reply(res, status, { error: { message } });

// A request MiniMax answered but refused, such as a bad key or unknown voice. It is
// reported as 400 because the OpenAI SDK in Paseo retries 5xx, and retrying cannot help.
class Rejected extends Error {}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function synthesize({ upstream, authorization, model, voice, input }) {
  const response = await fetch(upstream, {
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      text: input,
      stream: false,
      voice_setting: { voice_id: voice },
      audio_setting: { sample_rate: SAMPLE_RATE, format: 'pcm', channel: 1 },
    }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`MiniMax HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  // MiniMax reports refusals inside a 200 response.
  const result = await response.json();
  if (result.base_resp?.status_code !== 0) {
    throw new Rejected(`MiniMax ${result.base_resp?.status_code}: ${result.base_resp?.status_msg}`);
  }
  return Buffer.from(result.data.audio, 'hex');
}

export function createShim({ upstream = MINIMAX_T2A } = {}) {
  return createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/audio/speech') return fail(res, 404, 'Only POST /v1/audio/speech');
    if (!req.headers.authorization) return fail(res, 401, 'Missing MiniMax API key');
    let request;
    try {
      request = await readJson(req);
    } catch {
      return fail(res, 400, 'Body must be JSON');
    }
    const { model, voice, input, response_format: format = 'pcm' } = request;
    if (format !== 'pcm') return fail(res, 400, 'Only response_format "pcm" is supported');
    if (!model || !voice || !input?.trim()) return fail(res, 400, 'model, voice and input are required');
    const startedAt = Date.now();
    try {
      const audio = await synthesize({ upstream, authorization: req.headers.authorization, model, voice, input });
      reply(res, 200, audio, 'audio/pcm');
      console.log(JSON.stringify({ chars: input.length, bytes: audio.length, ms: Date.now() - startedAt }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ chars: input.length, ms: Date.now() - startedAt, error: message }));
      fail(res, error instanceof Rejected ? 400 : 502, message);
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  createShim().listen(PORT, '127.0.0.1', () => console.log(`minimax-tts-shim listening on 127.0.0.1:${PORT}`));
}
