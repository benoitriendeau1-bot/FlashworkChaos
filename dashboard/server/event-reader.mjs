import fs from 'node:fs';
import { createInterface } from 'node:readline';
import { compactValue } from '../../src/coverage/shared.mjs';
import { redactSecrets } from '../../src/signatures-redact.mjs';
import { MAX_EVENT_DETAIL_BYTES, MAX_EVENT_LINE_BYTES, MAX_EVENT_SCAN_BYTES } from '../shared/constants.mjs';
import { httpError } from './errors.mjs';

const DETAIL_TEXT = 4000;

function detailValue(value) {
  if (typeof value === 'string' && /password|changeme/i.test(value)) return '[REDACTED]';
  if (typeof value === 'string' && value.length > DETAIL_TEXT) {
    return { truncated: true, length: value.length, preview: value.slice(0, 32) };
  }
  if (Array.isArray(value)) return value.map((item) => detailValue(item));
  if (value && typeof value === 'object') {
    const redacted = redactSecrets(value);
    const out = {};
    for (const [key, item] of Object.entries(redacted)) out[key] = detailValue(item);
    return out;
  }
  return value === undefined ? null : value;
}

function compactEvent(event, detail) {
  const cloned = detail ? detailValue(event) : compactValue(event);
  if (detail && Buffer.byteLength(JSON.stringify(cloned)) > MAX_EVENT_DETAIL_BYTES) {
    throw httpError(413, 'event_too_large', 'Event detail exceeds the local limit');
  }
  return cloned;
}

async function readLineAt(file, offset) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const pieces = [];
    let position = offset;
    let total = 0;
    while (total < MAX_EVENT_LINE_BYTES) {
      const buffer = Buffer.alloc(65536);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(0x0a);
      if (newline >= 0) {
        pieces.push(chunk.subarray(0, newline));
        total += newline;
        break;
      }
      pieces.push(chunk);
      position += bytesRead;
      total += bytesRead;
    }
    if (total >= MAX_EVENT_LINE_BYTES && pieces.length && !pieces.at(-1).includes(0x0a)) {
      throw httpError(413, 'event_too_large', 'Event line exceeds the local limit');
    }
    return Buffer.concat(pieces).toString('utf8').replace(/\r$/, '');
  } finally {
    await handle.close();
  }
}

export async function readEventByIndex(file, entry, { detail = false } = {}) {
  let line;
  try {
    line = await readLineAt(file, entry.offset);
  } catch (error) {
    if (error.code === 'ENOENT') throw httpError(404, 'events_missing', 'Event journal is gone');
    throw error;
  }
  if (!line.trim()) throw httpError(409, 'event_incomplete', 'Event line is incomplete');
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    throw httpError(409, 'event_incomplete', 'Event line is not valid JSON');
  }
  if (entry.seq != null && event.seq !== entry.seq) {
    throw httpError(409, 'event_index_mismatch', 'Indexed event does not match the requested seq');
  }
  return { mode: 'index', event: compactEvent(event, detail) };
}

export async function scanEventBySeq(file, seq, { detail = false } = {}) {
  let bytes = 0;
  let limited = false;
  let handle;
  try {
    handle = fs.createReadStream(file, { encoding: 'utf8' });
  } catch (error) {
    if (error.code === 'ENOENT') throw httpError(404, 'events_missing', 'Event journal is gone');
    throw error;
  }
  const lines = createInterface({ input: handle, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      bytes += Buffer.byteLength(line) + 1;
      if (bytes > MAX_EVENT_SCAN_BYTES) {
        limited = true;
        break;
      }
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.seq === seq) {
        return { mode: 'scan', limited: false, event: compactEvent(event, detail) };
      }
    }
  } catch (error) {
    if (error.status) throw error;
    if (error.code === 'ENOENT') throw httpError(404, 'events_missing', 'Event journal is gone');
    throw httpError(409, 'file_changed', 'Event journal changed while it was being read');
  } finally {
    lines.close();
    handle.destroy();
  }
  if (limited) {
    throw httpError(404, 'event_not_scanned', 'Event was not found in the bounded scan');
  }
  throw httpError(404, 'event_not_found', 'Event seq was not found');
}
