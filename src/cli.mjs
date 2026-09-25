import {
  Api, identifier, reportWriter, stepsAfterSeededOperation, instructionBlocksBody,
  catalogGaps, workOrderGaps, levelCounts,
} from './engine.mjs';
import {
  bindPlan, compileScenarios, coherenceViolations, coverageViolations, dataPointRequest,
  diffScenario, resolveSignoffRequirement, summarizeObserved, summarizeScenario,
} from './scenario.mjs';
import { dataCapturePlan } from './capture-plan.mjs';
import { runDataCapture } from './capture-run.mjs';
import { partsCapturePlan, summarizePartsPlan } from './parts-plan.mjs';
import { runPartsCapture } from './parts-run.mjs';
import { summarizeToolsPlan, toolsCapturePlan } from './tools-plan.mjs';
import { runToolsCapture } from './tools-run.mjs';
import { redactSecrets } from './signatures-redact.mjs';
import { summarizeSignaturesPlan, signaturesCapturePlan } from './signatures-plan.mjs';
import { runSignaturesCapture } from './signatures-run.mjs';
import { lifecyclePlan, summarizeLifecyclePlan } from './lifecycle-plan.mjs';
import { runLifecycle } from './lifecycle-run.mjs';
import { andonPlan, summarizeAndonPlan } from './andon-plan.mjs';
import { runAndonCapture } from './andon-run.mjs';
import { ncrPlan, summarizeNcrPlan } from './ncr-plan.mjs';
import { runNcrCapture } from './ncr-run.mjs';
import { summarizeVariancePlan, variancePlan } from './variance-plan.mjs';
import { runVarianceCapture } from './variance-run.mjs';
import { runPlan, summarizeRunPlan } from './run-plan.mjs';
import { runRunCapture } from './run-run.mjs';
import { serviceVisitPlan, summarizeServiceVisitPlan } from './service-visit-plan.mjs';
import { runServiceVisitCapture } from './service-visit-run.mjs';
import { ensureChaosSignOffReasons } from './sign-off-reason-bootstrap.mjs';
import { writeRunCoverage } from './coverage.mjs';
import path from 'node:path';

const arg = (name, fallback) => {
  const found = process.argv.find((item) => item.startsWith('--' + name + '='));
  return found ? found.slice(name.length + 3) : fallback;
};
const seed = Number(arg('seed', '847291'));
const count = Number(arg('po', '20'));
if (!Number.isSafeInteger(seed) || !Number.isInteger(count) || count < 1 || count > 5000) {
  throw new Error('Use --seed=integer and --po=1..5000');
}
const compiled = compileScenarios(seed, count);
const planViolations = compiled.scenarios.flatMap((scenario) => [
  ...coherenceViolations(scenario),
  ...coverageViolations(scenario),
]);
if (process.argv.includes('--dry-run')) {
  const capturePlan = dataCapturePlan(compiled.scenarios[0]);
  const partsPlan = summarizePartsPlan(partsCapturePlan(seed));
  const toolsPlan = summarizeToolsPlan(toolsCapturePlan(seed));
  const signaturesPlan = summarizeSignaturesPlan(signaturesCapturePlan(seed));
  console.log(JSON.stringify({
    seed,
    count,
    planHash: compiled.planHash,
    capturePlanHash: capturePlan.capturePlanHash,
    partsPlanHash: partsPlan.partsPlanHash,
    partsActions: partsPlan.actionCount,
    partsModes: partsPlan.byTraceabilityMode,
    toolsPlanHash: toolsPlan.toolsPlanHash,
    toolsActions: toolsPlan.actionCount,
    toolsPolicies: toolsPlan.byCapturePolicy,
    signaturesPlanHash: signaturesPlan.signaturesPlanHash,
    signaturesActions: signaturesPlan.actionCount,
    signaturesByAction: signaturesPlan.byAction,
    lifecyclePlanHash: summarizeLifecyclePlan(lifecyclePlan(seed)).lifecyclePlanHash,
    lifecycleActions: summarizeLifecyclePlan(lifecyclePlan(seed)).actionCount,
    andonPlanHash: summarizeAndonPlan(andonPlan(seed)).andonPlanHash,
    andonActions: summarizeAndonPlan(andonPlan(seed)).actionCount,
    ncrPlanHash: summarizeNcrPlan(ncrPlan(seed)).ncrPlanHash,
    ncrActions: summarizeNcrPlan(ncrPlan(seed)).actionCount,
    variancePlanHash: summarizeVariancePlan(variancePlan(seed)).variancePlanHash,
    varianceActions: summarizeVariancePlan(variancePlan(seed)).actionCount,
    runPlanHash: summarizeRunPlan(runPlan(seed)).runPlanHash,
    runActions: summarizeRunPlan(runPlan(seed)).actionCount,
    serviceVisitPlanHash: summarizeServiceVisitPlan(serviceVisitPlan(seed)).serviceVisitPlanHash,
    serviceVisitActions: summarizeServiceVisitPlan(serviceVisitPlan(seed)).actionCount,
    captureBlocked: capturePlan.blockedTypes,
    violations: planViolations,
    scenarios: compiled.scenarios.map(summarizeScenario),
  }, null, 2));
  process.exit(planViolations.length === 0 ? 0 : 1);
}
if (planViolations.length > 0) {
  throw new Error('Seeded plan violates manufacturing rules: ' + planViolations.map((item) => item.reason).join('; '));
}
const base = process.env.FLASHWORK_BASE_URL;
const client = process.env.FLASHWORK_CLIENT_ID;
const user = process.env.FLASHWORK_USER_ID;
if (!base || !client || !user) throw new Error('Set FLASHWORK_BASE_URL, FLASHWORK_CLIENT_ID and FLASHWORK_USER_ID for a local test tenant');
const host = new URL(base);
if (!['localhost', '127.0.0.1', '::1'].includes(host.hostname) && process.env.FLASHWORK_ALLOW_REMOTE !== 'yes') {
  throw new Error('Remote target requires FLASHWORK_ALLOW_REMOTE=yes');
}
const api = new Api(base, client, user);
const runId = arg('run-id', String(seed) + '-' + Date.now().toString(36));
if (!/^[a-zA-Z0-9-]{1,40}$/.test(runId)) throw new Error('Invalid run-id');
const prefix = arg('prefix', 'CH');
if (!/^[A-Z]{2,5}$/.test(prefix)) throw new Error('prefix must be 2–5 uppercase letters');
const bound = bindPlan(compiled, { prefix, runId });
const output = reportWriter(path.resolve('runs', runId), seed);
let reportClosed = false;
function closeReport(summary) {
  if (reportClosed) return Promise.resolve();
  reportClosed = true;
  output.finish(summary);
  return writeRunCoverage({
    directory: path.dirname(output.file),
    summary,
    scenario: bound.scenarios[0] ?? null,
    proofs: captureReport?.proofs ?? [],
  }).catch((error) => {
    console.error('Chaos coverage harness_error: ' + (error instanceof Error ? error.message : String(error)));
  });
}
function fatalReport(error) {
  const text = error instanceof Error ? (error.stack || error.message) : String(error);
  const summary = {
    seed, runId, prefix, count,
    planHash: compiled.planHash,
    fatal: true,
    pass: false,
    error: text,
  };
  let pending = Promise.resolve();
  try {
    output.write({ label: 'FATAL', seed, runId, prefix, error: text });
    pending = closeReport(summary);
  } catch (writeError) {
    console.error(writeError);
  }
  Promise.resolve(pending).finally(() => {
    console.error(text);
    process.exit(1);
  });
}
process.on('unhandledRejection', fatalReport);
process.on('uncaughtException', fatalReport);
const totals = {
  masterItems: 0, operations: 0, steps: 0, numericData: 0, textData: 0,
  productionOrders: 0, workOrders: 0, negativeChecks: 0, findings: 0, blocked: 0,
};
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

const quotaGaps = [];
let captureReport = null;
const signOffReasons = await ensureChaosSignOffReasons(async (method, route, body) => {
  const seq = ++action;
  try {
    const result = await api.call(method, route, body);
    output.write({
      seq, label: 'bootstrap sign-off reason', method, route, body: body ?? null,
      status: result.status, response: result.data, phase: 'bootstrap',
    });
    return result;
  } catch (error) {
    output.write({
      seq, label: 'bootstrap sign-off reason', method, route, body: body ?? null,
      error: String(error), phase: 'bootstrap',
    });
    return { status: 0, data: { error: String(error) } };
  }
});
if (!signOffReasons.ok) {
  const detail = [signOffReasons.skip, signOffReasons.reopen]
    .filter((item) => !item.ok)
    .map((item) => item.reasonCode + ': ' + item.error)
    .join('; ');
  throw new Error('Chaos setup could not establish an active sign-off reason: ' + detail);
}
const differences = [];
const masterReads = [];
const workOrderReads = [];
const observed = [];
const catalogRecords = { parts: [], tools: [] };
const partIds = new Map();
const toolIds = new Map();
const category = await request('create part category', 'POST', '/part-categories', {
  categoryName: bound.catalog.categoryName,
  description: 'Chaos catalog ' + runId,
});
const partCategorieId = category.ok ? identifier(category.data, ['partCategorieId']) : undefined;
if (!partCategorieId) {
  totals.blocked++;
  quotaGaps.push({ level: 'catalog', reason: 'part category was not created', ids: { categoryName: bound.catalog.categoryName } });
}
for (const partSpec of bound.catalog.parts) {
  const record = { partNumber: partSpec.partNumber, traceabilityMode: partSpec.traceabilityMode, partId: null, confirmed: false };
  catalogRecords.parts.push(record);
  if (!partCategorieId) continue;
  const created = await request('create part', 'POST', '/parts', {
    partNumber: partSpec.partNumber, description: partSpec.description,
    partCategorieId, traceabilityMode: partSpec.traceabilityMode, status: 'Active',
  });
  record.partId = created.ok ? identifier(created.data, ['partId']) : null;
  if (!record.partId) { totals.blocked++; continue; }
  partIds.set(partSpec.partNumber, record.partId);
  const read = await request('read part', 'GET', '/parts/' + record.partId);
  record.confirmed = read.ok && read.data?.traceabilityMode === partSpec.traceabilityMode && read.data?.partId === record.partId;
  if (!record.confirmed) totals.blocked++;
}
for (const toolSpec of bound.catalog.tools) {
  const record = {
    toolNumber: toolSpec.toolNumber, capturePolicy: toolSpec.capturePolicy,
    toolId: null, toolInstanceId: null, confirmed: false,
  };
  catalogRecords.tools.push(record);
  const body = {
    toolNumber: toolSpec.toolNumber, name: toolSpec.name, description: toolSpec.description,
    defaultCapturePolicy: toolSpec.capturePolicy, calibrationBasis: toolSpec.calibrationBasis,
  };
  if (toolSpec.defaultCalibrationIntervalDays) body.defaultCalibrationIntervalDays = toolSpec.defaultCalibrationIntervalDays;
  if (toolSpec.defaultCalibrationIntervalUses) body.defaultCalibrationIntervalUses = toolSpec.defaultCalibrationIntervalUses;
  const created = await request('create tool', 'POST', '/tools', body);
  record.toolId = created.ok ? identifier(created.data, ['toolId']) : null;
  if (!record.toolId) { totals.blocked++; continue; }
  toolIds.set(toolSpec.toolNumber, record.toolId);
  const read = await request('read tool', 'GET', '/tools/' + record.toolId);
  record.confirmed = read.ok && read.data?.defaultCapturePolicy === toolSpec.capturePolicy && read.data?.toolId === record.toolId;
  if (!record.confirmed) totals.blocked++;
  const instanceBody = {
    toolId: record.toolId, assetTag: toolSpec.assetTag, serialNo: toolSpec.serialNo, status: 'active',
  };
  if (toolSpec.lastCalibratedAt) instanceBody.lastCalibratedAt = toolSpec.lastCalibratedAt;
  const instance = await request('create tool instance', 'POST', '/tool-instances', instanceBody);
  record.toolInstanceId = instance.ok ? identifier(instance.data, ['toolInstanceId']) : null;
  if (!record.toolInstanceId) { totals.blocked++; continue; }
  const listed = await request('read tool instances', 'GET', '/tool-instances?toolId=' + encodeURIComponent(record.toolId));
  const rows = listed.ok && Array.isArray(listed.data?.toolInstances) ? listed.data.toolInstances : [];
  if (!rows.some((row) => row.toolInstanceId === record.toolInstanceId)) {
    totals.blocked++;
    record.toolInstanceId = null;
  }
}
quotaGaps.push(...catalogGaps(catalogRecords));
const catalogue = await request('list sign-off requirements', 'GET', '/sign-off-requirements?activeOnly=true');
const signoffIds = {};
for (const role of ['operator', 'inspector']) {
  const resolved = catalogue.ok ? resolveSignoffRequirement(catalogue.data, { role, level: 1 }) : { requirement: null, matched: false, role };
  if (!resolved.requirement) continue;
  signoffIds[role] = resolved.requirement.signOffRequirementId;
  if (!resolved.matched) {
    differences.push({
      severity: 'info',
      reason: 'catalogue has no ' + role + ' sign-off; used the first releasable requirement',
      ids: { role, signOffRequirementId: signoffIds[role] },
    });
  }
}
if (!signoffIds.operator && !signoffIds.inspector) {
  totals.blocked++;
  output.write({ seq: ++action, label: 'BLOCKED sign-off requirement', response: catalogue.data });
}
const effectivityDate = new Date().toISOString().slice(0, 10);

for (const scenario of bound.scenarios) {
  const root = '/master-items/' + encodeURIComponent(scenario.masterItemNo);
  const made = await request('create master', 'POST', '/master-items', {
    masterItemNo: scenario.masterItemNo, masterType: 'Prod', description: scenario.description,
    seedInitialStructure: false,
  });
  if (!made.ok) { totals.blocked++; continue; }
  totals.masterItems++;
  const numeric = [];
  let publishable = Boolean(signoffIds.operator || signoffIds.inspector);
  async function authorStep(stepId, step) {
    for (const part of step.parts) {
      const partId = partIds.get(part.partNumber);
      if (!partId) { totals.blocked++; publishable = false; continue; }
      const attached = await request('add step part', 'POST', root + '/parts', {
        masOpeStepId: stepId, partId, quantityRequired: part.quantity,
      });
      if (!attached.ok) { totals.blocked++; publishable = false; }
    }
    for (const tool of step.tools) {
      const toolId = toolIds.get(tool.toolNumber);
      if (!toolId) { totals.blocked++; publishable = false; continue; }
      const attached = await request('add step tool', 'POST', root + '/tools', {
        masOpeStepId: stepId, toolId, capturePolicy: tool.capturePolicy, useQty: 1,
        specText: 'Utiliser ' + tool.name + ' et confirmer son identité.',
      });
      if (!attached.ok) { totals.blocked++; publishable = false; }
    }
    for (const point of step.dataPoints) {
      const body = dataPointRequest(stepId, point);
      const created = await request('add data point', 'POST', root + '/data-points', body);
      if (!created.ok) { totals.blocked++; publishable = false; continue; }
      if (body.dataType === 'number' || body.dataType === 'measurement') {
        totals.numericData++;
        numeric.push({ stepId, referenceCode: point.referenceCode });
      } else if (body.dataType === 'text') totals.textData++;
    }
    const blocks = await request('write instruction', 'PUT', '/mas-ope-step/' + stepId + '/blocks', instructionBlocksBody(step.instruction));
    if (!blocks.ok) { totals.blocked++; publishable = false; }
    const signOffRequirementId = signoffIds[step.signoff.role] ?? signoffIds.operator ?? signoffIds.inspector;
    if (!signOffRequirementId) { publishable = false; return; }
    const sign = await request('add sign-off', 'POST', root + '/signoffs', {
      masOpeStepId: stepId, signOffRequirementId, level: 1,
    });
    if (!sign.ok) { totals.blocked++; publishable = false; }
  }
  for (const operation of scenario.operations) {
    const op = await request('add operation', 'POST', root + '/operations', {
      operationNo: operation.operationNo,
      operationTitle: operation.title,
      operationDescription: operation.description,
      mustCompleteBeforeLater: operation.mustCompleteBeforeLater,
    });
    if (!op.ok) { totals.blocked++; publishable = false; continue; }
    const opId = requiredId(op, ['masOpeId', 'id'], 'operation id');
    if (!opId) { publishable = false; continue; }
    totals.operations++;
    const authored = stepsAfterSeededOperation(op.data, operation.steps);
    if (!authored.seeded) { totals.blocked++; publishable = false; continue; }
    const named = await request('name seeded step', 'PATCH', root + '/steps/' + authored.seeded.masOpeStepId, authored.name);
    if (!named.ok) { totals.blocked++; publishable = false; }
    totals.steps++;
    await authorStep(authored.seeded.masOpeStepId, operation.steps[0]);
    for (let index = 0; index < authored.creates.length; index++) {
      const stepSpec = authored.creates[index];
      const step = await request('add step', 'POST', root + '/steps', {
        masOpeId: opId, stepNo: stepSpec.stepNo, stepTitle: stepSpec.stepTitle,
        stepDescription: stepSpec.stepDescription, toolsFirst: false,
      });
      if (!step.ok) { totals.blocked++; publishable = false; continue; }
      const stepId = requiredId(step, ['masOpeStepId', 'id'], 'step id');
      if (!stepId) { publishable = false; continue; }
      totals.steps++;
      await authorStep(stepId, operation.steps[index + 1]);
    }
  }
  const masterRead = await request('read master', 'GET', root);
  const scenarioDiffs = diffScenario(scenario, masterRead.ok ? masterRead.data : null, { signoffIds, surface: 'master' });
  differences.push(...scenarioDiffs);
  if (masterRead.ok) {
    masterReads.push(masterRead.data);
    observed.push(summarizeObserved(masterRead.data));
  }
  const material = scenarioDiffs.filter((item) => item.severity === 'material');
  if (!publishable || !masterRead.ok || material.length > 0 || numeric.length === 0) {
    totals.blocked++;
    continue;
  }
  const suffix = String(scenario.index).padStart(4, '0');
  const invalid = await request('reject nonnumeric minimum', 'POST', root + '/data-points', {
    masOpeStepId: numeric[0].stepId, referenceCode: 'BAD' + suffix,
    label: 'Bad numeric boundary', dataType: 'number', minValue: 'potato',
  }, 'reject');
  if (invalid.ok) totals.negativeChecks++;
  const released = await request('release master', 'PATCH', root, { status: 'Released' });
  if (!released.ok) { totals.blocked++; continue; }
  const order = await request('create PO', 'POST', '/production-orders', {
    source: 'master_item', orderNo: scenario.orderNo, orderType: 'Prod', masterItemNo: scenario.masterItemNo,
    effectivityDate, quantityPlanned: scenario.units, executionMode: 'sequential',
  });
  if (!order.ok) { totals.blocked++; continue; }
  totals.productionOrders++;
  const orderRoot = '/production-orders/' + encodeURIComponent(scenario.orderNo);
  const rel = await request('release PO', 'POST', orderRoot + '/release', {});
  if (!rel.ok) { totals.blocked++; continue; }
  for (let unit = 1; unit <= scenario.units; unit++) {
    const wo = await request('create WO', 'POST', orderRoot + '/units/' + unit + '/lines/1/work-orders', {});
    if (wo.ok) totals.workOrders++; else totals.blocked++;
    const woId = identifier(wo.data, ['workOrderId', 'id']);
    if (!wo.ok || !woId) continue;
    const detail = await request('read WO detail', 'GET', orderRoot + '/work-orders/' + woId);
    if (!detail.ok) { totals.blocked++; continue; }
    workOrderReads.push(detail.data);
    const snapshotGaps = workOrderGaps(masterRead.data, detail.data);
    quotaGaps.push(...snapshotGaps);
    const woDiffs = diffScenario(scenario, detail.data, { signoffIds, surface: 'workOrder' })
      .map((item) => ({ ...item, ids: { ...item.ids, workOrderId: woId } }));
    differences.push(...woDiffs);
    if (snapshotGaps.length > 0 || woDiffs.some((item) => item.severity === 'material')) totals.blocked++;
    output.write({ seq: ++action, label: 'snapshot read', woId, referenceCode: numeric[0].referenceCode });
    if (scenario.index === 1 && unit === 1) {
      captureReport = await runDataCapture({
        call: async (label, method, route, body) => {
          const seq = ++action;
          try {
            const result = await api.call(method, route, body);
            output.write({ seq, label, method, route, body, status: result.status, response: result.data, phase: 'capture' });
            return { seq, status: result.status, data: result.data };
          } catch (error) {
            output.write({ seq, label, method, route, body, error: String(error), phase: 'capture' });
            return { seq, status: 0, data: { error: String(error) } };
          }
        },
        readDetail: async () => {
          const detail = await api.call('GET', orderRoot + '/work-orders/' + woId);
          output.write({ seq: ++action, label: 'reread WO', method: 'GET', route: orderRoot + '/work-orders/' + woId, status: detail.status, response: detail.data, phase: 'capture' });
          return detail.status >= 200 && detail.status < 300 ? detail.data : null;
        },
        scenario,
        catalog: bound.catalog,
        orderNo: scenario.orderNo,
        workOrderId: woId,
        seed,
        runId,
      });
    }
  }
}
const expectedWorkOrders = bound.scenarios.reduce((sum, scenario) => sum + scenario.units, 0);
if (masterReads.length < count) {
  quotaGaps.push({ level: 'masterItem', reason: 'fewer master item read-backs than scenarios', ids: { expected: count, observed: masterReads.length } });
}
if (workOrderReads.length < expectedWorkOrders) {
  quotaGaps.push({ level: 'workOrder', reason: 'fewer verified work order snapshots than planned units', ids: { expected: expectedWorkOrders, observed: workOrderReads.length } });
}
for (const difference of differences) {
  if (difference.severity !== 'material') continue;
  quotaGaps.push({
    level: difference.ids?.workOrderId ? 'workOrder' : 'masterItem',
    reason: difference.reason,
    ids: difference.ids,
  });
}
const counts = levelCounts(catalogRecords, masterReads, workOrderReads);
const gapsFor = (level) => quotaGaps.filter((gap) => gap.level === level);
const levels = {
  catalog: { pass: gapsFor('catalog').length === 0, counts: counts.catalog, gaps: gapsFor('catalog') },
  masterItems: { pass: gapsFor('masterItem').length === 0, counts: counts.masterItems, gaps: gapsFor('masterItem') },
  workOrders: { pass: gapsFor('workOrder').length === 0, counts: counts.workOrders, gaps: gapsFor('workOrder') },
};
let partsReport = null;
if (partCategorieId && (signoffIds.operator || signoffIds.inspector)) {
  partsReport = await runPartsCapture({
    setup: async (label, method, route, body) => {
      const seq = ++action;
      try {
        const result = await api.call(method, route, body);
        const ok = result.status >= 200 && result.status < 300;
        output.write({ seq, label, method, route, body, status: result.status, response: result.data, ok, phase: 'parts-setup' });
        return { ...result, ok };
      } catch (error) {
        output.write({ seq, label, method, route, body, error: String(error), ok: false, phase: 'parts-setup' });
        return { ok: false, status: 0, data: { error: String(error) } };
      }
    },
    call: async (label, method, route, body) => {
      const seq = ++action;
      try {
        const result = await api.call(method, route, body);
        output.write({ seq, label, method, route, body, status: result.status, response: result.data, phase: 'parts' });
        return { seq, status: result.status, data: result.data };
      } catch (error) {
        output.write({ seq, label, method, route, body, error: String(error), phase: 'parts' });
        return { seq, status: 0, data: { error: String(error) } };
      }
    },
    seed,
    runId,
    prefix,
    partCategorieId,
    signOffRequirementId: signoffIds.operator ?? signoffIds.inspector,
    effectivityDate,
  });
}
let toolsReport = null;
if (signoffIds.operator || signoffIds.inspector) {
  toolsReport = await runToolsCapture({
    setup: async (label, method, route, body) => {
      const seq = ++action;
      try {
        const result = await api.call(method, route, body);
        const ok = result.status >= 200 && result.status < 300;
        output.write({ seq, label, method, route, body, status: result.status, response: result.data, ok, phase: 'tools-setup' });
        return { ...result, ok };
      } catch (error) {
        output.write({ seq, label, method, route, body, error: String(error), ok: false, phase: 'tools-setup' });
        return { ok: false, status: 0, data: { error: String(error) } };
      }
    },
    call: async (label, method, route, body) => {
      const seq = ++action;
      try {
        const result = await api.call(method, route, body);
        output.write({ seq, label, method, route, body, status: result.status, response: result.data, phase: 'tools' });
        return { seq, status: result.status, data: result.data };
      } catch (error) {
        output.write({ seq, label, method, route, body, error: String(error), phase: 'tools' });
        return { seq, status: 0, data: { error: String(error) } };
      }
    },
    seed,
    runId,
    prefix,
    signOffRequirementId: signoffIds.operator ?? signoffIds.inspector,
    effectivityDate,
  });
}
let signaturesReport = null;
if (signoffIds.operator || signoffIds.inspector) {
  signaturesReport = await runSignaturesCapture({
    setup: async (label, method, route, body) => {
      const seq = ++action;
      try {
        const result = await api.call(method, route, body);
        const safeBody = redactSecrets(body);
        const safeResponse = redactSecrets(result.data);
        output.write({ seq, label, method, route, body: safeBody, status: result.status, response: safeResponse, ok: result.status >= 200 && result.status < 300, phase: 'signatures-setup' });
        return { ...result, ok: result.status >= 200 && result.status < 300 };
      } catch (error) {
        output.write({ seq, label, method, route, body: redactSecrets(body), error: String(error), ok: false, phase: 'signatures-setup' });
        return { ok: false, status: 0, data: { error: String(error) } };
      }
    },
    call: async (label, method, route, body, options) => {
      const seq = ++action;
      try {
        const result = await api.call(method, route, body, options);
        output.write({ seq, label, method, route, body: redactSecrets(body), status: result.status, response: redactSecrets(result.data), phase: 'signatures', actor: options?.userId ?? user });
        return { seq, status: result.status, data: result.data };
      } catch (error) {
        output.write({ seq, label, method, route, body: redactSecrets(body), error: String(error), phase: 'signatures' });
        return { seq, status: 0, data: { error: String(error) } };
      }
    },
    seed, runId, prefix, effectivityDate, envUserId: user,
    skipReasonId: signOffReasons.skip.id,
    reopenReasonId: signOffReasons.reopen.id,
  });
}
let lifecycleReport = null;
lifecycleReport = await runLifecycle({
  setup: async (label, method, route, body) => {
    const seq = ++action;
    try {
      const result = await api.call(method, route, body);
      output.write({ seq, label, method, route, body: redactSecrets(body), status: result.status, response: redactSecrets(result.data), ok: result.status >= 200 && result.status < 300, phase: 'lifecycle-setup' });
      return { ...result, ok: result.status >= 200 && result.status < 300 };
    } catch (error) {
      output.write({ seq, label, method, route, body: redactSecrets(body), error: String(error), ok: false, phase: 'lifecycle-setup' });
      return { ok: false, status: 0, data: { error: String(error) } };
    }
  },
  call: async (label, method, route, body, options) => {
    const seq = ++action;
    try {
      const result = await api.call(method, route, body, options);
      output.write({ seq, label, method, route, body: redactSecrets(body), status: result.status, response: redactSecrets(result.data), phase: 'lifecycle', actor: options?.userId ?? user });
      return { seq, status: result.status, data: result.data };
    } catch (error) {
      output.write({ seq, label, method, route, body: redactSecrets(body), error: String(error), phase: 'lifecycle' });
      return { seq, status: 0, data: { error: String(error) } };
    }
  },
  seed, runId, prefix, effectivityDate, envUserId: user,
  foreignOrderNo: bound.scenarios[0]?.orderNo ?? null,
  skipReasonId: signOffReasons.skip.id,
  reopenReasonId: signOffReasons.reopen.id,
});
let andonReport = null;
andonReport = await runAndonCapture({
  setup: async (label, method, route, body) => {
    const seq = ++action;
    try {
      const result = await api.call(method, route, body);
      output.write({ seq, label, method, route, body: redactSecrets(body), status: result.status, response: redactSecrets(result.data), ok: result.status >= 200 && result.status < 300, phase: 'andon-setup' });
      return { ...result, ok: result.status >= 200 && result.status < 300 };
    } catch (error) {
      output.write({ seq, label, method, route, body: redactSecrets(body), error: String(error), ok: false, phase: 'andon-setup' });
      return { ok: false, status: 0, data: { error: String(error) } };
    }
  },
  call: async (label, method, route, body, options) => {
    const seq = ++action;
    try {
      const result = await api.call(method, route, body, options);
      output.write({ seq, label, method, route, body: redactSecrets(body), status: result.status, response: redactSecrets(result.data), phase: 'andon', actor: options?.userId ?? user });
      return { seq, status: result.status, data: result.data };
    } catch (error) {
      output.write({ seq, label, method, route, body: redactSecrets(body), error: String(error), phase: 'andon' });
      return { seq, status: 0, data: { error: String(error) } };
    }
  },
  seed, runId, prefix, effectivityDate, envUserId: user,
});
let ncrReport = null;
ncrReport = await runNcrCapture({
  setup: async (label, method, route, body) => {
    const seq = ++action;
    try {
      const result = await api.call(method, route, body);
      output.write({ seq, label, method, route, body: redactSecrets(body), status: result.status, response: redactSecrets(result.data), ok: result.status >= 200 && result.status < 300, phase: 'ncr-setup' });
      return { ...result, ok: result.status >= 200 && result.status < 300 };
    } catch (error) {
      output.write({ seq, label, method, route, body: redactSecrets(body), error: String(error), ok: false, phase: 'ncr-setup' });
      return { ok: false, status: 0, data: { error: String(error) } };
    }
  },
  call: async (label, method, route, body, options) => {
    const seq = ++action;
    try {
      const result = await api.call(method, route, body, options);
      output.write({ seq, label, method, route, body: redactSecrets(body), status: result.status, response: redactSecrets(result.data), phase: 'ncr', actor: options?.userId ?? user });
      return { seq, status: result.status, data: result.data };
    } catch (error) {
      output.write({ seq, label, method, route, body: redactSecrets(body), error: String(error), phase: 'ncr' });
      return { seq, status: 0, data: { error: String(error) } };
    }
  },
  seed, runId, prefix, effectivityDate, envUserId: user,
  skipReasonId: signOffReasons.skip.id,
  reopenReasonId: signOffReasons.reopen.id,
});
let varianceReport = null;
varianceReport = await runVarianceCapture({
  setup: async (label, method, route, body) => {
    const seq = ++action;
    try {
      const result = await api.call(method, route, body);
      output.write({ seq, label, method, route, body: redactSecrets(body), status: result.status, response: redactSecrets(result.data), ok: result.status >= 200 && result.status < 300, phase: 'variance-setup' });
      return { ...result, ok: result.status >= 200 && result.status < 300 };
    } catch (error) {
      output.write({ seq, label, method, route, body: redactSecrets(body), error: String(error), ok: false, phase: 'variance-setup' });
      return { ok: false, status: 0, data: { error: String(error) } };
    }
  },
  call: async (label, method, route, body, options) => {
    const seq = ++action;
    try {
      const result = await api.call(method, route, body, options);
      output.write({ seq, label, method, route, body: redactSecrets(body), status: result.status, response: redactSecrets(result.data), phase: 'variance', actor: options?.userId ?? user });
      return { seq, status: result.status, data: result.data };
    } catch (error) {
      output.write({ seq, label, method, route, body: redactSecrets(body), error: String(error), phase: 'variance' });
      return { seq, status: 0, data: { error: String(error) } };
    }
  },
  seed, runId, prefix, effectivityDate, envUserId: user,
});
let runReport = null;
runReport = await runRunCapture({
  setup: async (label, method, route, body) => {
    const seq = ++action;
    try {
      const result = await api.call(method, route, body);
      output.write({ seq, label, method, route, body: redactSecrets(body), status: result.status, response: redactSecrets(result.data), ok: result.status >= 200 && result.status < 300, phase: 'run-setup' });
      return { ...result, ok: result.status >= 200 && result.status < 300 };
    } catch (error) {
      output.write({ seq, label, method, route, body: redactSecrets(body), error: String(error), ok: false, phase: 'run-setup' });
      return { ok: false, status: 0, data: { error: String(error) } };
    }
  },
  call: async (label, method, route, body, options) => {
    const seq = ++action;
    try {
      const result = await api.call(method, route, body, options);
      output.write({ seq, label, method, route, body: redactSecrets(body), status: result.status, response: redactSecrets(result.data), phase: 'run', actor: options?.userId ?? user });
      return { seq, status: result.status, data: result.data };
    } catch (error) {
      output.write({ seq, label, method, route, body: redactSecrets(body), error: String(error), phase: 'run' });
      return { seq, status: 0, data: { error: String(error) } };
    }
  },
  seed, runId, prefix, effectivityDate, envUserId: user,
});
let serviceVisitReport = null;
serviceVisitReport = await runServiceVisitCapture({
  setup: async (label, method, route, body) => {
    const seq = ++action;
    try {
      const result = await api.call(method, route, body);
      output.write({ seq, label, method, route, body: redactSecrets(body), status: result.status, response: redactSecrets(result.data), ok: result.status >= 200 && result.status < 300, phase: 'service-visit-setup' });
      return { ...result, ok: result.status >= 200 && result.status < 300 };
    } catch (error) {
      output.write({ seq, label, method, route, body: redactSecrets(body), error: String(error), ok: false, phase: 'service-visit-setup' });
      return { ok: false, status: 0, data: { error: String(error) } };
    }
  },
  call: async (label, method, route, body, options) => {
    const seq = ++action;
    try {
      const result = await api.call(method, route, body, options);
      output.write({ seq, label, method, route, body: redactSecrets(body), status: result.status, response: redactSecrets(result.data), phase: 'service-visit', actor: options?.userId ?? user });
      return { seq, status: result.status, data: result.data };
    } catch (error) {
      output.write({ seq, label, method, route, body: redactSecrets(body), error: String(error), phase: 'service-visit' });
      return { seq, status: 0, data: { error: String(error) } };
    }
  },
  seed, runId, prefix, effectivityDate, envUserId: user,
});
const notCovered = [
  ...(partsReport?.pass === true ? [] : ['partCapture']),
  ...(toolsReport?.pass === true ? [] : ['toolCapture']),
  ...(signaturesReport?.pass === true ? [] : ['signoffChaos']),
  ...(lifecycleReport?.executionPass === true ? [] : ['toolExecution']),
  ...(andonReport?.pass === true ? [] : ['andon']),
  ...(ncrReport?.pass === true ? [] : ['ncr']),
  ...(varianceReport?.pass === true ? [] : ['variance']),
  ...(runReport?.pass === true ? [] : ['run2Plus']),
  ...(serviceVisitReport?.pass === true ? [] : ['sv2Plus']),
];
const minimum = {
  operations: 3 * count, numericData: count, negativeChecks: count,
  productionOrders: count, workOrders: count,
};
const missing = Object.fromEntries(Object.entries(minimum).filter(([key, goal]) => totals[key] < goal));
const setupPass = totals.findings === 0 && totals.blocked === 0 && Object.keys(missing).length === 0
  && levels.catalog.pass && levels.masterItems.pass && levels.workOrders.pass
  && differences.every((item) => item.severity !== 'material');
const capturePass = captureReport?.capturePass === true;
const chaosPass = captureReport?.chaosPass === true;
const dataPass = capturePass && chaosPass;
const partsCapturePass = partsReport?.capturePass === true;
const partsChaosPass = partsReport?.chaosPass === true;
const summary = {
  seed,
  runId,
  count,
  planHash: compiled.planHash,
  capturePlanHash: captureReport?.capturePlanHash ?? null,
  planned: bound.scenarios.map(summarizeScenario),
  observed,
  differences,
  execution: { effectivityDate },
  signOffReasons: {
    skip: {
      reasonCode: signOffReasons.skip.reasonCode,
      signOffSkipReasonId: signOffReasons.skip.id,
      disposition: signOffReasons.skip.disposition,
      isActive: true,
    },
    reopen: {
      reasonCode: signOffReasons.reopen.reasonCode,
      signOffReopenReasonId: signOffReasons.reopen.id,
      disposition: signOffReasons.reopen.disposition,
      isActive: true,
    },
  },
  capture: captureReport ? {
    locator: captureReport.locator ?? null,
    dataTypes: captureReport.dataTypes ?? null,
    concurrency: captureReport.concurrency ?? [],
    counters: captureReport.counters,
    findings: captureReport.findings,
  } : null,
  actions: action,
  totals,
  levels,
  notCovered,
  minimum,
  missing,
  parts: partsReport,
  tools: toolsReport,
  signatures: signaturesReport,
  cancellationRaces: signaturesReport?.cancellationRaces ?? null,
  workOrderLifecycle: lifecycleReport,
  andon: andonReport,
  ncr: ncrReport,
  variance: varianceReport,
  run: runReport,
  serviceVisit: serviceVisitReport,
  setupPass,
  capturePass,
  chaosPass,
  dataPass,
  partsCapturePass,
  partsChaosPass,
  partsPass: partsCapturePass && partsChaosPass,
  toolsCapturePass: toolsReport?.capturePass === true,
  toolsChaosPass: toolsReport?.chaosPass === true,
  toolsPass: toolsReport?.capturePass === true && toolsReport?.chaosPass === true,
  signaturesCapturePass: signaturesReport?.capturePass === true,
  signaturesChaosPass: signaturesReport?.chaosPass === true,
  signaturesPass: signaturesReport?.capturePass === true && signaturesReport?.chaosPass === true,
  workOrderExecutionPass: lifecycleReport?.executionPass === true,
  workOrderCompletionPass: lifecycleReport?.completionPass === true,
  asBuiltPass: lifecycleReport?.asBuiltPass === true,
  lifecycleChaosPass: lifecycleReport?.chaosPass === true,
  andonCapturePass: andonReport?.capturePass === true,
  andonChaosPass: andonReport?.chaosPass === true,
  andonPass: andonReport?.capturePass === true && andonReport?.chaosPass === true,
  ncrCapturePass: ncrReport?.capturePass === true,
  ncrChaosPass: ncrReport?.chaosPass === true,
  ncrPass: ncrReport?.capturePass === true && ncrReport?.chaosPass === true,
  varianceCapturePass: varianceReport?.capturePass === true,
  varianceChaosPass: varianceReport?.chaosPass === true,
  variancePass: varianceReport?.capturePass === true && varianceReport?.chaosPass === true,
  runCapturePass: runReport?.capturePass === true,
  runChaosPass: runReport?.chaosPass === true,
  runPass: runReport?.capturePass === true && runReport?.chaosPass === true,
  serviceVisitCapturePass: serviceVisitReport?.capturePass === true,
  serviceVisitChaosPass: serviceVisitReport?.chaosPass === true,
  pass: setupPass && dataPass && partsCapturePass && partsChaosPass && toolsReport?.capturePass === true && toolsReport?.chaosPass === true && signaturesReport?.capturePass === true && signaturesReport?.chaosPass === true && lifecycleReport?.pass === true && andonReport?.capturePass === true && andonReport?.chaosPass === true && ncrReport?.capturePass === true && ncrReport?.chaosPass === true && varianceReport?.capturePass === true && varianceReport?.chaosPass === true && runReport?.capturePass === true && runReport?.chaosPass === true && serviceVisitReport?.capturePass === true && serviceVisitReport?.chaosPass === true,
};
closeReport(summary);
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.pass ? 0 : 1;
