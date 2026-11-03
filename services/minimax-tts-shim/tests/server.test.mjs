import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createShim } from '../server.mjs';

const listen = (server) => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
});

// A MiniMax stand-in that records each request and answers with `answer`.
async function minimax(answer) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(answer));
  });
  return { calls, server, url: await listen(server) };
}

async function withShim(answer, run) {
  const upstream = await minimax(answer);
  const shim = createShim({ upstream: upstream.url });
  const url = await listen(shim);
  try {
    await run({ url, calls: upstream.calls });
  } finally {
    shim.close();
    upstream.server.close();
  }
}

const speak = (url, body, authorization = 'Bearer k') => fetch(`${url}/v1/audio/speech`, {
  method: 'POST',
  headers: { Authorization: authorization, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const request = { model: 'speech-2.8-turbo', voice: 'female-chengshu', input: '你好', response_format: 'pcm' };

test('returns MiniMax hex audio as raw 24 kHz PCM and forwards the key', async () => {
  const pcm = Buffer.from([1, 2, 254, 255]);
  await withShim({ data: { audio: pcm.toString('hex') }, base_resp: { status_code: 0 } }, async ({ url, calls }) => {
    const response = await speak(url, request);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), pcm);
    assert.equal(calls[0].authorization, 'Bearer k');
    assert.deepEqual(calls[0].body, {
      model: 'speech-2.8-turbo',
      text: '你好',
      stream: false,
      voice_setting: { voice_id: 'female-chengshu' },
      audio_setting: { sample_rate: 24000, format: 'pcm', channel: 1 },
    });
  });
});

test('reports a MiniMax refusal inside a 200 response as a non-retryable OpenAI-shaped 400', async () => {
  await withShim({ base_resp: { status_code: 1004, status_msg: 'authorized failure' } }, async ({ url }) => {
    const response = await speak(url, request);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /1004: authorized failure/);
  });
});

test('reports an unreachable MiniMax as a retryable 502', async () => {
  const shim = createShim({ upstream: 'http://127.0.0.1:9/' });
  const url = await listen(shim);
  try {
    assert.equal((await speak(url, request)).status, 502);
  } finally {
    shim.close();
  }
});

test('rejects requests Paseo voice playback cannot use without calling MiniMax', async () => {
  await withShim({}, async ({ url, calls }) => {
    assert.equal((await speak(url, { ...request, response_format: 'mp3' })).status, 400);
    assert.equal((await speak(url, { ...request, input: '  ' })).status, 400);
    assert.equal((await speak(url, request, '')).status, 401);
    assert.equal(calls.length, 0);
  });
});
