import { Api, plan, integer, rng, identifier, reportWriter, stepsAfterSeededOperation, pickReleasableSignoffRequirement, signoffForRelease } from './engine.mjs';
import path from 'node:path';

const arg = (name, fallback) => {
  const found = process.argv.find(x => x.startsWith('--' + name + '='));
  return found ? found.slice(name.length + 3) : fallback;
};
const seed = Number(arg('seed', '847291'));
const count = Number(arg('po', '20'));
if (!Number.isSafeInteger(seed) || !Number.isInteger(count) || count < 1 || count > 5000)
  throw new Error('Use --seed=integer and --po=1..5000');
const scenarios = plan(seed, count);
const totals = { masterItems: 0, operations: 0, steps: 0, numericData: 0,
  textData: 0, productionOrders: 0, workOrders: 0, negativeChecks: 0, findings: 0, blocked: 0 };
if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({ seed, count, planned: {
    operations: scenarios.reduce((n, s) => n + s.operations, 0),
    minimumSteps: scenarios.reduce((n, s) => n + s.operations, 0),
    minimumData: scenarios.reduce((n, s) => n + s.operations, 0),
    units: scenarios.reduce((n, s) => n + s.units, 0),
    invalidNumeric: scenarios.reduce((n, s) => n + s.invalidNumeric, 0),
  } }, null, 2));
  process.exit(0);
}
const base = process.env.FLASHWORK_BASE_URL;
const client = process.env.FLASHWORK_CLIENT_ID;
const user = process.env.FLASHWORK_USER_ID;
if (!base || !client || !user) throw new Error('Set FLASHWORK_BASE_URL, FLASHWORK_CLIENT_ID and FLASHWORK_USER_ID for a local test tenant');
const host = new URL(base);
if (!['localhost', '127.0.0.1', '::1'].includes(host.hostname) && process.env.FLASHWORK_ALLOW_REMOTE !== 'yes')
  throw new Error('Remote target requires FLASHWORK_ALLOW_REMOTE=yes');
const api = new Api(base, client, user);
const runId = arg('run-id', String(seed) + '-' + Date.now().toString(36));
if (!/^[a-zA-Z0-9-]{1,40}$/.test(runId)) throw new Error('Invalid run-id');
const output = reportWriter(path.resolve('runs', runId), seed);
const random = rng(seed ^ 0x9e3779b9);
let action = 0;
async function request(label, method, route, body, expectation = 'success') {
  const seq = ++action;
  try {
    const result = await api.call(method, route, body);
    const ok = expectation === 'reject'
      ? result.status >= 400 && result.status < 500
      : result.status >= 200 && result.status < 300;
    output.write({ seq, label, method, route, body, status: result.status, response: result.data, ok });
    if (!ok) {
      totals.findings++;
      console.error('FINDING', seq, label, result.status);
    }
    return { ...result, ok };
  } catch (error) {
    totals.findings++;
    output.write({ seq, label, method, route, body, error: String(error), ok: false });
    return { ok: false, data: {} };
  }
}
function requiredId(result, keys, label) {
  const id = identifier(result.data, keys);
  if (!id) {
    totals.blocked++;
    output.write({ seq: ++action, label: 'BLOCKED ' + label, response: result.data });
  }
  return id;
}
const prefix = arg('prefix', 'CH');
if (!/^[A-Z]{2,5}$/.test(prefix)) throw new Error('prefix must be 2–5 uppercase letters');
const catalogue = await request('list sign-off requirements', 'GET', '/sign-off-requirements?activeOnly=true');
const signoffRequirement = catalogue.ok ? pickReleasableSignoffRequirement(catalogue.data) : null;
if (!signoffRequirement) {
  totals.blocked++;
  output.write({ seq: ++action, label: 'BLOCKED sign-off requirement', response: catalogue.data });
}
for (const scenario of scenarios) {
  const suffix = String(scenario.index).padStart(4, '0');
  const mi = 'MI-' + prefix + runId.replaceAll('-', '').slice(0, 12).toUpperCase() + suffix;
  const po = 'PO' + prefix + runId.replaceAll('-', '').slice(0, 12).toUpperCase() + suffix;
  const root = '/master-items/' + encodeURIComponent(mi);
  const made = await request('create master', 'POST', '/master-items', {
    masterItemNo: mi, masterType: 'Prod', description: 'Chaos ' + runId + ' ' + suffix,
    seedInitialStructure: false,
  });
  if (!made.ok) { totals.blocked++; continue; }
  totals.masterItems++;
  const numeric = [];
  let dpSeq = 0;
  let localOps = 0;
  let publishable = Boolean(signoffRequirement);
  async function addDataPoints(stepId, slots) {
    for (let d = 0; d < (slots ?? 0); d++) {
      const type = (dpSeq++ % 3 === 0) ? 'text' : 'number';
      const body = { masOpeStepId: stepId, referenceCode: 'D' + String(dpSeq).padStart(4, '0'),
        label: type === 'number' ? 'Measured dimension ' + dpSeq : 'Inspection note ' + dpSeq,
        dataType: type, isMandatory: false };
      if (type === 'number') Object.assign(body, { minValue: 0, maxValue: 100, nominalValue: 50, unit: 'mm' });
      const point = await request('add data point', 'POST', root + '/data-points', body);
      if (point.ok) {
        totals[type === 'number' ? 'numericData' : 'textData']++;
        if (type === 'number') numeric.push({ stepId, dataId: identifier(point.data, ['masStepDataId', 'id']) });
      } else totals.blocked++;
    }
  }
  for (let o = 0; o < scenario.operations; o++) {
    const op = await request('add operation', 'POST', root + '/operations', {
      operationNo: String((o + 1) * 10), operationTitle: 'Assembly operation ' + (o + 1),
      mustCompleteBeforeLater: o % 3 !== 0,
    });
    if (!op.ok) { totals.blocked++; publishable = false; continue; }
    const opId = requiredId(op, ['masOpeId', 'id'], 'operation id');
    if (!opId) { publishable = false; continue; }
    totals.operations++;
    localOps++;
    // The create response already contains step 1. Reuse it; further steps start at 2.
    const authored = stepsAfterSeededOperation(op.data, scenario.stepsPerOperation[o]);
    if (!authored.seeded) { totals.blocked++; publishable = false; continue; }
    const named = await request('name seeded step', 'PATCH', root + '/steps/' + authored.seeded.masOpeStepId, authored.name);
    if (!named.ok) { totals.blocked++; publishable = false; }
    totals.steps++;
    const stepIds = [authored.seeded.masOpeStepId];
    await addDataPoints(authored.seeded.masOpeStepId, scenario.dataPerStep[o * 3]);
    for (let s = 0; s < authored.creates.length; s++) {
      const spec = authored.creates[s];
      const step = await request('add step', 'POST', root + '/steps', {
        masOpeId: opId, stepNo: spec.stepNo, stepTitle: spec.stepTitle, toolsFirst: spec.toolsFirst,
      });
      if (!step.ok) { totals.blocked++; publishable = false; continue; }
      const stepId = requiredId(step, ['masOpeStepId', 'id'], 'step id');
      if (!stepId) { publishable = false; continue; }
      totals.steps++;
      stepIds.push(stepId);
      await addDataPoints(stepId, scenario.dataPerStep[o * 3 + s + 1]);
    }
    if (!signoffRequirement) continue;
    for (const stepId of stepIds) {
      const sign = await request('add sign-off', 'POST', root + '/signoffs', signoffForRelease(stepId, signoffRequirement));
      if (!sign.ok) { totals.blocked++; publishable = false; }
    }
  }
  if (localOps < 3 || numeric.length === 0 || !publishable) { totals.blocked++; continue; }
  // Schema oracle: an authoring numeric limit cannot be a word.
  const invalid = await request('reject nonnumeric minimum', 'POST', root + '/data-points', {
    masOpeStepId: numeric[0].stepId, referenceCode: 'BAD' + suffix,
    label: 'Bad numeric boundary', dataType: 'number', minValue: 'potato',
  }, 'reject');
  if (invalid.ok) totals.negativeChecks++;
  // Release is an explicit contract gate. A rejected release blocks this PO; it is not silently counted as coverage.
  const released = await request('release master', 'PATCH', root, { status: 'Released' });
  if (!released.ok) { totals.blocked++; continue; }
  const order = await request('create PO', 'POST', '/production-orders', {
    source: 'master_item', orderNo: po, orderType: 'Prod', masterItemNo: mi,
    effectivityDate: new Date().toISOString().slice(0, 10), quantityPlanned: scenario.units,
    executionMode: 'sequential',
  });
  if (!order.ok) { totals.blocked++; continue; }
  totals.productionOrders++;
  const orderRoot = '/production-orders/' + encodeURIComponent(po);
  const rel = await request('release PO', 'POST', orderRoot + '/release', {});
  if (!rel.ok) { totals.blocked++; continue; }
  for (let unit = 1; unit <= scenario.units; unit++) {
    const wo = await request('create WO', 'POST', orderRoot + '/units/' + unit + '/lines/1/work-orders', {});
    if (wo.ok) totals.workOrders++; else totals.blocked++;
    const woId = identifier(wo.data, ['workOrderId', 'id']);
    if (!wo.ok || !woId) continue;
    const entry = numeric[integer(random, 0, numeric.length - 1)];
    if (!entry.dataId) { totals.blocked++; continue; }
    const detail = await request('read WO detail', 'GET', orderRoot + '/work-orders/' + woId);
    if (!detail.ok) continue;
    // Production IDs differ from the draft IDs; never claim capture coverage from a draft identifier.
    output.write({ seq: ++action, label: 'snapshot read', woId, draftDataId: entry.dataId });
  }
}
const minimum = { operations: 3 * count, numericData: count, negativeChecks: count,
  productionOrders: count, workOrders: count };
const missing = Object.fromEntries(Object.entries(minimum).filter(([key, goal]) => totals[key] < goal));
const summary = { seed, runId, count, actions: action, totals, minimum, missing, pass: totals.findings === 0 && totals.blocked === 0 && Object.keys(missing).length === 0 };
output.finish(summary);
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.pass ? 0 : 1;
