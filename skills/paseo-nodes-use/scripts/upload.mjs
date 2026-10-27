#!/usr/bin/env node
// Called only by node.sh after resolving and checking the node identity.
// Usage: upload.mjs [--timeout SECONDS] -- FILE
// Uploads FILE into the node's Paseo uploads directory in acknowledged parts.
// stdout is NDJSON: progress events, then one result or error event. The caller
// assembles and verifies the parts on the node and deletes them after use.
//
// uploadFile exists only on DaemonClient, which the SDK exports as
// `internal/daemon-client` (the class createPaseoClient wraps). Re-verify this
// path when upgrading @getpaseo/client.
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { connectionConfig } from './connect.mjs';
import { sha256, uploadInParts } from './upload-parts.mjs';

const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const args = process.argv.slice(2);
const split = args.indexOf('--');
const options = split < 0 ? [] : args.slice(0, split);
const seconds = options.includes('--timeout') ? Number(options[options.indexOf('--timeout') + 1]) : 120;
if (split < 0 || args.length !== split + 2 || !Number.isFinite(seconds) || seconds <= 0) {
  throw new Error('Expected [--timeout SECONDS] -- FILE');
}
const config = connectionConfig();
let client;

async function connected() {
  if (client?.getConnectionState().status === 'connected') return client;
  await client?.close().catch(() => {});
  client = new DaemonClient({ ...config, clientId: `cc-upload-${randomUUID()}`, clientType: 'cli' });
  if (typeof client.uploadFile !== 'function') throw new Error('This @getpaseo/client has no uploadFile');
  await client.connect();
  return client;
}

async function reset() {
  await client?.close().catch(() => {});
  client = undefined;
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => { void reset().finally(() => process.exit(143)); });
}
try {
  const bytes = await readFile(args[split + 1]);
  const digest = sha256(bytes);
  const parts = await uploadInParts(bytes, {
    upload: async (input) => (await connected()).uploadFile(input),
    reset,
    name: `nsm-${digest.slice(7, 19)}`,
    partTimeoutMs: seconds * 1000,
    onProgress: (done, total) => emit({ event: 'progress', bytes: done, total_bytes: total }),
  });
  emit({ event: 'result', sha256: digest, size: bytes.byteLength, parts });
} catch (error) {
  emit({ event: 'error', error: error instanceof Error ? error.message : String(error), uploaded: error?.uploaded ?? [] });
  process.exitCode = 1;
} finally {
  await reset();
}
