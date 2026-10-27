#!/usr/bin/env node
// Called only by node.sh after resolving and checking the node identity.
import { createPaseoClient } from '@getpaseo/client';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { connectionConfig } from './connect.mjs';

const args = process.argv.slice(2);
const split = args.indexOf('--');
const options = args.slice(0, split);
const workspace = options[options.indexOf('--workspace') + 1];
const seconds = Number(options[options.indexOf('--timeout') + 1]);
if (split < 0 || !options.includes('--workspace') || !workspace || !Number.isFinite(seconds) || seconds <= 0) {
  throw new Error('Expected --workspace ID --timeout SECONDS -- COMMAND');
}
const config = connectionConfig();
const client = createPaseoClient(config);
let terminal;
let closing;
async function close() {
  return closing ??= (async () => {
    if (terminal) await terminal.kill().catch(() => {});
    await client.close().catch(() => {});
  })();
}
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => { void close().finally(() => process.exit(143)); });
}
// The loop below checks its deadline only between RPCs; a request lost with a
// dropped connection would otherwise wait forever.
setTimeout(() => {
  console.error(`Command timed out after ${seconds}s; inspect node state before retrying`);
  void close().finally(() => process.exit(2));
}, seconds * 1000 + 15000).unref();
try {
  await client.connect();
  terminal = await client.terminals.create({ workspaceId: workspace, name: `cc-exec-${process.pid}` });
  const marker = `__CC_DONE_${randomUUID().replaceAll('-', '')}__`;
  const payload = Buffer.from(args.slice(split + 1).join(' ')).toString('base64');
  const deadline = Date.now() + seconds * 1000;
  // Wait for the shell and disable input echo before a large encoded command.
  // Otherwise the echoed payload can push the result framing out of scrollback.
  terminal.write(`stty -echo; printf '${marker}:READY\\n'\r`);
  while (!(await terminal.capture({ stripAnsi: true })).lines.includes(`${marker}:READY`)) {
    if (Date.now() >= deadline) throw new Error('Terminal shell did not become ready');
    await delay(200);
  }
  terminal.write(`printf '${marker}:S\\n'; printf '%s' '${payload}' | base64 --decode | bash; printf '\\n${marker}:%s\\n' "$?"\r`);
  while (true) {
    // Await a correlated RPC on the same connection before closing or polling.
    const capture = await terminal.capture({ stripAnsi: true });
    const lines = capture.lines;
    const start = lines.indexOf(`${marker}:S`);
    const end = lines.findIndex((line) => new RegExp(`^${marker}:[0-9]+$`).test(line));
    if (start >= 0 && end > start) {
      process.stdout.write(lines.slice(start + 1, end).join('\n') + '\n');
      process.exitCode = Number(lines[end].split(':').at(-1));
      break;
    }
    if (Date.now() >= deadline) throw new Error(`Command timed out after ${seconds}s; inspect node state before retrying`);
    await delay(350);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
} finally {
  await close();
}
