import fs from 'node:fs';
import path from 'node:path';

export function rng(seed) {
  let state = Number(seed) >>> 0;
  return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
}
export const integer = (random, low, high) => low + Math.floor(random() * (high - low + 1));
export function plan(seed, count) {
  const random = rng(seed);
  return Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    operations: integer(random, 3, 12),
    stepsPerOperation: Array.from({ length: 12 }, () => integer(random, 1, 3)),
    dataPerStep: Array.from({ length: 36 }, () => integer(random, 1, 4)),
    units: integer(random, 1, 8),
    invalidNumeric: integer(random, 1, 3),
  }));
}
export class Api {
  constructor(base, clientId, userId, timeout = 15000) {
    this.base = base.replace(/\/$/, '');
    this.clientId = clientId;
    this.userId = userId;
    this.timeout = timeout;
    this.cookie = '';
  }
  async call(method, route, body) {
    const response = await fetch(this.base + route, {
      method,
      headers: { 'content-type': 'application/json', 'X-Client-Id': this.clientId,
        ...(this.userId ? { 'X-User-Id': this.userId } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = raw.slice(0, 1000); }
    return { status: response.status, data };
  }
}
export function identifier(data, names) {
  const candidates = [data, data?.data, data?.result, data?.item, data?.value];
  for (const obj of candidates) for (const name of names) {
    if (obj && typeof obj === 'object' && typeof obj[name] === 'string') return obj[name];
  }
  return undefined;
}
export function reportWriter(dir, seed) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'events.jsonl');
  return {
    file,
    write(event) { fs.appendFileSync(file, JSON.stringify({ seed, ...event }) + '\n'); },
    finish(summary) { fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n'); },
  };
}
