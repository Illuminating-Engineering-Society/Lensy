#!/usr/bin/env node
/**
 * Upload a large PDF to the PDFS R2 bucket via the Worker's multipart
 * admin endpoint. Use for files over wrangler's 300 MiB `r2 object put`
 * limit (e.g. DG-17-05.pdf at 512 MiB).
 *
 * Usage:
 *   node scripts/r2-upload-large.js --file "pdfs/Deprecated Standards/DG-17-05.pdf" --key deprecated/DG-17-05.pdf
 *
 * Environment:
 *   LUCIUS_API_URL     Worker URL (default: http://localhost:8787)
 *   LUCIUS_API_SECRET  Bearer token if the Worker has one configured
 *
 * Parts are 80 MiB (all equal except the last, as R2 multipart requires)
 * to stay under the Workers request-body limit. Each part is retried up
 * to 3 times; on unrecoverable failure the upload is aborted server-side
 * so R2 does not accumulate orphaned parts.
 */

import { openSync, readSync, closeSync, statSync } from 'fs';
import { resolve } from 'path';

const PART_SIZE = 80 * 1024 * 1024;
const MAX_RETRIES = 3;

const args = process.argv.slice(2);
const fileArg = args.indexOf('--file');
const keyArg = args.indexOf('--key');
if (fileArg < 0 || keyArg < 0) {
  console.error('Usage: node scripts/r2-upload-large.js --file <path> --key <standards|deprecated>/<name>.pdf');
  process.exit(1);
}
const filePath = resolve(args[fileArg + 1]);
const key = args[keyArg + 1];
const apiUrl = process.env.LUCIUS_API_URL || 'http://localhost:8787';
const secret = process.env.LUCIUS_API_SECRET || null;

function headers(extra = {}) {
  return secret ? { Authorization: `Bearer ${secret}`, ...extra } : extra;
}

async function post(params, body, extraHeaders = {}) {
  const qs = new URLSearchParams({ key, ...params }).toString();
  const res = await fetch(`${apiUrl}/api/admin/r2-multipart?${qs}`, {
    method: 'POST',
    headers: headers(extraHeaders),
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '(no body)');
    throw new Error(`${params.action} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function main() {
  const size = statSync(filePath).size;
  const totalParts = Math.ceil(size / PART_SIZE);
  console.log(`Uploading ${filePath}`);
  console.log(`  → ${key} (${(size / 1048576).toFixed(1)} MiB, ${totalParts} part(s) of ≤${PART_SIZE / 1048576} MiB)`);
  console.log(`  Target: ${apiUrl}`);

  const { uploadId } = await post({ action: 'create' });
  console.log(`  Upload ID: ${uploadId}`);

  const fd = openSync(filePath, 'r');
  const parts = [];
  try {
    for (let i = 0; i < totalParts; i++) {
      const partNumber = i + 1;
      const offset = i * PART_SIZE;
      const length = Math.min(PART_SIZE, size - offset);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, offset);

      let lastErr;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const part = await post(
            { action: 'part', uploadId, partNumber: String(partNumber) },
            buffer,
            { 'Content-Type': 'application/octet-stream' }
          );
          parts.push({ partNumber: part.partNumber, etag: part.etag });
          console.log(`  ✓ Part ${partNumber}/${totalParts} (${(length / 1048576).toFixed(1)} MiB)`);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          console.warn(`  ⚠ Part ${partNumber} attempt ${attempt}/${MAX_RETRIES}: ${err.message}`);
          if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, attempt * 5000));
        }
      }
      if (lastErr) throw lastErr;
    }

    const result = await post(
      { action: 'complete' },
      JSON.stringify({ uploadId, parts }),
      { 'Content-Type': 'application/json' }
    );
    if (result.size !== size) {
      throw new Error(`size mismatch: uploaded ${result.size} bytes, local file is ${size}`);
    }
    console.log(`  ✓ Complete: ${result.key} (${(result.size / 1048576).toFixed(1)} MiB in R2)`);
  } catch (err) {
    console.error(`  ✗ ${err.message}`);
    try {
      await post({ action: 'abort' }, JSON.stringify({ uploadId }), { 'Content-Type': 'application/json' });
      console.error('  Multipart upload aborted server-side.');
    } catch (abortErr) {
      console.error(`  ⚠ Abort also failed: ${abortErr.message}`);
    }
    process.exit(1);
  } finally {
    closeSync(fd);
  }
}

main();
