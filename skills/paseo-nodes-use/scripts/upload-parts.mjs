// Acknowledged multipart upload. The SDK's uploadFile sends a whole file without
// flow control, so on a slow link the connection heartbeat (15 s timeout) queues
// behind it and the client drops the connection. Awaiting each part until the
// daemon has written it bounds that queue to one part. Part size follows the
// measured part duration rather than a bandwidth model, because per-request
// overhead (round trips, TCP ramp-up) dominates small parts on distant nodes:
// double while a part takes under TARGET_MS, halve above twice that.
import { createHash } from 'node:crypto';

export const FIRST_PART = 256 * 1024;
export const MIN_PART = 64 * 1024;
export const MAX_PART = 8 * 1024 * 1024;
export const TARGET_MS = 3000;
export const ATTEMPTS = 3;

export const sha256 = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Upload part timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * upload({fileName, mimeType, bytes}) resolves to the daemon's file.upload
 * payload. reset() is called before retrying a failed part so the caller can
 * replace a dropped connection. Returns [{path, size, sha256}] in order; on
 * failure the error carries `uploaded`, every path the daemon reported.
 */
export async function uploadInParts(bytes, { upload, reset = async () => {}, name, partTimeoutMs,
                                             onProgress = () => {}, now = Date.now }) {
  const parts = [];
  const uploaded = [];
  let size = FIRST_PART;
  let offset = 0;
  try {
    while (offset < bytes.byteLength) {
      const fileName = `${name}.part${String(parts.length).padStart(4, '0')}`;
      let piece;
      let elapsed;
      let file;
      for (let attempt = 1; ; attempt++) {
        piece = bytes.subarray(offset, Math.min(offset + size, bytes.byteLength));
        const started = now();
        try {
          const result = await withTimeout(
            upload({ fileName, mimeType: 'application/octet-stream', bytes: piece }), partTimeoutMs);
          if (result?.file?.path) uploaded.push(result.file.path);
          if (result?.error || !result?.file) throw new Error(result?.error || 'Upload returned no file');
          if (result.file.size !== piece.byteLength) throw new Error('Uploaded part size mismatch');
          file = result.file;
          elapsed = Math.max(1, now() - started);
          break;
        } catch (error) {
          if (attempt >= ATTEMPTS) throw error;
          // A dropped or stalled part usually means it was too large for the link.
          size = Math.max(MIN_PART, Math.floor(size / 2));
          await reset();
        }
      }
      parts.push({ path: file.path, size: piece.byteLength, sha256: sha256(piece) });
      offset += piece.byteLength;
      onProgress(offset, bytes.byteLength);
      if (elapsed < TARGET_MS) size = Math.min(MAX_PART, size * 2);
      else if (elapsed > TARGET_MS * 2) size = Math.max(MIN_PART, Math.floor(size / 2));
    }
    return parts;
  } catch (error) {
    error.uploaded = uploaded;
    throw error;
  }
}
