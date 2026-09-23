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
    invalidNumeric: 1,
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

function payloadObjects(data) {
  return [data, data?.data, data?.result, data?.item, data?.value];
}

/** Creating an operation inserts step 1. Posting that number again is a 409. */
export function seededStepFromOperation(data) {
  for (const obj of payloadObjects(data)) {
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.steps)) continue;
    const step = obj.steps.find((row) => row && Number(row.stepNo) === 1 && typeof row.masOpeStepId === 'string')
      ?? obj.steps.find((row) => row && typeof row.masOpeStepId === 'string');
    if (step) return { masOpeStepId: step.masOpeStepId, stepNo: Number(step.stepNo) };
  }
  return undefined;
}

export function stepsAfterSeededOperation(operation, plannedCount) {
  const seeded = seededStepFromOperation(operation);
  if (!seeded || !Number.isInteger(plannedCount) || plannedCount < 1) {
    return { seeded: seeded ?? null, name: null, creates: [] };
  }
  const creates = [];
  for (let offset = 1; offset < plannedCount; offset++) {
    creates.push({
      stepNo: seeded.stepNo + offset,
      stepTitle: 'Inspect and record ' + (offset + 1),
      toolsFirst: false,
    });
  }
  return {
    seeded,
    name: { stepTitle: 'Inspect and record 1', toolsFirst: false },
    creates,
  };
}

export function classifyAuthoringConflict(status, error) {
  if (status !== 409 || typeof error !== 'string') return null;
  const step = /^Step number (\d+) is already used in this operation$/.exec(error);
  if (step) return { kind: 'step-number', stepNo: Number(step[1]) };
  const operation = /^Operation number (.+) already exists on this master item$/.exec(error);
  if (operation) return { kind: 'operation-number', operationNo: operation[1] };
  return { kind: 'other', error };
}

export function releaseSignoffGap(error) {
  if (typeof error !== 'string') return null;
  const match = /^Every step must have at least one sign-off before release \(operation (.+) step (\d+)\)\.$/.exec(error);
  return match ? { operationNo: match[1], stepNo: Number(match[2]) } : null;
}

export function pickReleasableSignoffRequirement(payload) {
  const rows = Array.isArray(payload?.requirements)
    ? payload.requirements
    : Array.isArray(payload?.data?.requirements)
      ? payload.data.requirements
      : [];
  const active = rows.filter((row) =>
    row
    && typeof row.signOffRequirementId === 'string'
    && row.isActive !== false
    && !row.requiresSignOffRequirementId);
  const stepScoped = active.filter((row) => row.scope == null || row.scope === 'step');
  const pool = stepScoped.length > 0 ? stepScoped : active;
  return pool.find((row) => row.level == null || Number(row.level) === 1) ?? pool[0] ?? null;
}

export function signoffForRelease(masOpeStepId, requirement) {
  return {
    masOpeStepId,
    signOffRequirementId: requirement.signOffRequirementId,
    level: 1,
  };
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
