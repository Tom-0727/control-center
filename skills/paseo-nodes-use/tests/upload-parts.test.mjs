import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { FIRST_PART, MAX_PART, TARGET_MS, sha256, uploadInParts } from '../scripts/upload-parts.mjs';

// A daemon stand-in on a virtual clock: fixed per-request overhead plus a
// transfer rate, which `rate` may vary per call.
function daemon({ bytesPerMs, overheadMs = 50, failures = [], rate = () => bytesPerMs }) {
  const state = { clock: 0, stored: [], calls: 0, resets: 0, durations: [] };
  state.now = () => state.clock;
  state.upload = async ({ fileName, bytes }) => {
    state.calls += 1;
    const duration = overheadMs + bytes.byteLength / rate(state.calls);
    state.clock += duration;
    state.durations.push(duration);
    if (failures.includes(state.calls)) throw new Error('Connection lost');
    const path = `/home/u/.paseo/uploads/upload_${state.calls}/${fileName}`;
    state.stored.push({ path, bytes: Buffer.from(bytes) });
    return { file: { path, size: bytes.byteLength }, error: null };
  };
  state.reset = async () => { state.resets += 1; };
  return state;
}

const payload = (size) => randomBytes(size);

test('parts reassemble in order and grow on a fast link', async () => {
  const bytes = payload(20 * 1024 * 1024);
  const node = daemon({ bytesPerMs: 4 * 1024 });
  const progress = [];
  const parts = await uploadInParts(bytes, { upload: node.upload, name: 'nsm-x', partTimeoutMs: 60000,
    now: node.now, onProgress: (done) => progress.push(done) });
  assert.deepEqual(Buffer.concat(node.stored.map((s) => s.bytes)), bytes);
  assert.deepEqual(parts.map((p) => p.path), node.stored.map((s) => s.path));
  assert.ok(parts.every((p, i) => p.sha256 === sha256(node.stored[i].bytes)));
  assert.deepEqual(parts.slice(0, 6).map((p) => p.size), [1, 2, 4, 8, 16, 32].map((n) => n * FIRST_PART));
  assert.equal(Math.max(...parts.map((p) => p.size)), MAX_PART);
  assert.equal(progress.at(-1), bytes.byteLength);
});

test('a distant node settles on parts within twice the target duration', async () => {
  // Lenovo-like: ~2 s per request before data flows, ~600 KB/s afterwards.
  const node = daemon({ bytesPerMs: 600, overheadMs: 2000 });
  const parts = await uploadInParts(payload(6 * 1024 * 1024), { upload: node.upload, name: 'nsm-x',
    partTimeoutMs: 60000, now: node.now });
  assert.ok(node.durations.every((d) => d <= TARGET_MS * 2));
  assert.ok(parts.length < 12, 'fixed overhead must not shrink parts to the minimum');
});

test('parts shrink when the link slows down', async () => {
  const node = daemon({ bytesPerMs: 0, rate: (call) => (call < 4 ? 4096 : 50) });
  const parts = await uploadInParts(payload(8 * 1024 * 1024), { upload: node.upload, name: 'nsm-x',
    partTimeoutMs: 600000, now: node.now });
  const sizes = parts.map((p) => p.size);
  assert.equal(sizes[3], 8 * FIRST_PART);
  assert.ok(sizes.slice(4, 7).every((size, i) => size < sizes[3 + i]));
  assert.ok(node.durations.slice(-2).every((d) => d <= TARGET_MS * 2));
});

test('a part that stalls is retried at half size', async () => {
  const sizes = [];
  const upload = async ({ fileName, bytes }) => {
    sizes.push(bytes.byteLength);
    if (bytes.byteLength > 300 * 1024) return new Promise(() => {});
    return { file: { path: `/u/upload_${sizes.length}/${fileName}`, size: bytes.byteLength }, error: null };
  };
  let clock = 0;
  await uploadInParts(payload(1024 * 1024), { upload, name: 'nsm-x', partTimeoutMs: 20, now: () => (clock += 10) });
  assert.deepEqual(sizes.slice(0, 3), [FIRST_PART, 2 * FIRST_PART, FIRST_PART]);
});

test('a failed part is retried after reset without duplicating data', async () => {
  const bytes = payload(1024 * 1024);
  const node = daemon({ bytesPerMs: 1024, failures: [2] });
  const parts = await uploadInParts(bytes, { upload: node.upload, reset: node.reset, name: 'nsm-x',
    partTimeoutMs: 60000, now: node.now });
  assert.equal(node.resets, 1);
  assert.deepEqual(Buffer.concat(node.stored.map((s) => s.bytes)), bytes);
  assert.equal(parts.length, node.stored.length);
});

test('giving up reports every stored path for cleanup', async () => {
  const node = daemon({ bytesPerMs: 1024, failures: [2, 3, 4] });
  await assert.rejects(
    uploadInParts(payload(1024 * 1024), { upload: node.upload, reset: node.reset, name: 'nsm-x',
      partTimeoutMs: 60000, now: node.now }),
    (error) => error.message === 'Connection lost' && error.uploaded.length === 1);
});

test('a hung part times out and is retried', async () => {
  let calls = 0;
  const upload = async ({ fileName, bytes }) => {
    calls += 1;
    if (calls === 1) return new Promise(() => {});
    return { file: { path: `/u/upload_${calls}/${fileName}`, size: bytes.byteLength }, error: null };
  };
  const parts = await uploadInParts(payload(1000), { upload, name: 'nsm-x', partTimeoutMs: 20 });
  assert.equal(parts.length, 1);
  assert.equal(calls, 2);
});
