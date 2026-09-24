import { identifier, instructionBlocksBody, stepsAfterSeededOperation } from './engine.mjs';
import { findStep, resolveWorkOrderIds } from './wo-resolve.mjs';
import { bindRunPlan, runPlan } from './run-plan.mjs';
import { contractDecisionText, judgeRunObservation, judgeRunRace, runEvents, runVerdict } from './run-judge.mjs';

const MISSING_ID = '00000000-0000-4000-8000-000000000000';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function listOf(data, key) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.[key])) return data[key];
  return [];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function containsText(value, text) {
  return JSON.stringify(value ?? {}).includes(text);
}

function readVarianceId(data) {
  const row = data?.variance ?? data;
  const id = row?.workOrderVarianceId ?? null;
  return UUID_RE.test(String(id ?? '')) ? id : null;
}

function operationNumbers(detail) {
  const operations = detail?.operations ?? [];
  return Array.isArray(operations) ? operations.map((operation) => String(operation.operationNo)) : [];
}

function evidenceOf(resolved) {
  if (!resolved?.ok) return null;
  const operation = resolved.operations.find((item) => item.operationNo === '10') ?? resolved.operations[0];
  const step = operation?.steps?.[0];
  const data = step?.dataPoints?.[0];
  const part = step?.parts?.[0];
  const tool = step?.tools?.[0];
  const signoff = step?.signoffs?.[0];
  return {
    operations: resolved.operations.map((item) => item.operationNo),
    data: data?.capturedValueText ?? null,
    partId: part?.proStepPartId ?? null,
    partQty: part?.quantityActual ?? null,
    toolRowId: tool?.proStepToolId ?? null,
    toolInstanceId: tool?.toolInstanceId ?? null,
    calibrationStatus: tool?.calibrationStatus ?? null,
    signoffId: signoff?.proStepSignoffId ?? null,
    signedAt: signoff?.signedAt ?? null,
    outcome: signoff?.outcome ?? null,
  };
}

function addedOperation(ids, spec) {
  const text = 'Contrôle run';
  return {
    logicalId: spec.logicalId,
    orderKey: spec.orderKey,
    operationNo: spec.operationNo,
    operationTitle: 'Run',
    operationDescription: text,
    mediaPanelWidth: null,
    mustCompleteBeforeLater: false,
    stdOperationCode: null,
    stdOperationVersion: null,
    files: [],
    steps: [{
      logicalId: spec.logicalId + '-step',
      stepOrder: 1,
      stepTitle: text,
      stepDescription: text,
      toolsFirst: null,
      unitIdentity: null,
      parts: [{
        logicalId: spec.logicalId + '-part', partId: ids.partId, quantity: 1, unitOfMeasure: null,
        isMandatory: true, notes: null, traceabilityModeOverride: null, traceabilityOverrideReductionReason: null,
        traceabilityOverrideReducedBy: null, traceabilityOverrideReducedAt: null,
      }],
      tools: [{ logicalId: spec.logicalId + '-tool', toolId: ids.toolId, capturePolicy: 'required', useQty: null, specText: 'Scanner ' + ids.tagCode + '.' }],
      signoffs: [{ logicalId: spec.logicalId + '-sign', signOffRequirementId: ids.signOffRequirementId, signoffOrder: 1 }],
      dataPoints: [{
        logicalId: spec.logicalId + '-data', stableKey: spec.logicalId + '.note', dataDefinitionId: null,
        referenceCode: 'RUN-NOTE', label: text, dataOrder: 1, dataType: 'text', unit: null, isMandatory: true,
        nominalValue: null, minValue: null, maxValue: null, defaultValue: null, enumChoices: null, sampleEvery: 1,
      }],
      formulas: [],
      blocks: [{
        logicalId: spec.logicalId + '-block', blockOrder: 1, locationKey: 'top', blockType: 'INSTRUCTION',
        contentJson: { version: 4, rows: [{ id: spec.logicalId + '-row', layout: '1', blocks: [{ id: spec.logicalId + '-text', type: 'text', docJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } }] }] },
        stdTextRevisionId: null,
      }],
    }],
  };
}

export async function runRunCapture(input) {
  const { setup, call, seed, runId, prefix, effectivityDate, envUserId } = input;
  const plan = bindRunPlan(runPlan(seed), runId, prefix);
  const observations = [];
  const races = [];
  const findings = [];
  const contractDecisions = [];
  const notApplicable = plan.actions.filter((action) => action.applicable === false).map((action) => ({
    id: action.id, label: action.label, reason: action.reason,
  }));
  const blockedReport = (reason) => ({
    setupPass: false, capturePass: false, chaosPass: false, pass: false,
    runPlanHash: plan.runPlanHash, orderNo: plan.orderNo,
    counters: runVerdict(plan.actions, [], []),
    findings: [{ severity: 'high', invariant: reason }],
    contractDecisions, notApplicable, concurrency: races, blocked: [{ id: 'setup', reason }],
  });

  const known = ['SIG', 'SIGS', 'SIGL', 'SIGO', 'OBS', 'REQ', 'OPT', 'INF', 'NN', 'SE', 'LO', 'LC', 'AND', 'NCR', 'VAR'];
  if (known.some((suffix) => plan.partNumber.endsWith(suffix) || plan.toolNumber.endsWith(suffix) || plan.masterItemNo.endsWith(suffix))) {
    return blockedReport('run catalog number collides with another slice');
  }

  const reasons = {};
  for (const [key, name, effect] of [['none', plan.andonNone, 'none'], ['work_order', plan.andonStop, 'work_order']]) {
    const created = await setup('create run andon reason', 'POST', '/andon-reasons', {
      reasonName: name, description: 'Chaos run ' + effect, effect, promptsNcr: false, isActive: true,
    });
    reasons[key] = created.ok ? identifier(created.data, ['andonReasonId']) : null;
    if (!reasons[key]) return blockedReport('run andon reason was not created');
  }
  const token = plan.runToken;
  const category = await setup('create run sign-off category', 'POST', '/sign-off-categories', { name: 'RUN ' + token });
  const categoryId = category.ok ? identifier(category.data, ['signOffCategorieId']) : null;
  if (!categoryId) return blockedReport('run sign-off category was not created');
  const requirement = await setup('create run sign-off', 'POST', '/sign-off-requirements', {
    name: 'RUN operator ' + token, signOffCategorieId: categoryId, requiredPrivilege: 'signoff.operator',
    requiresUniqueSignerWithinStep: false, scope: 'step', level: 1,
  });
  const signOffRequirementId = requirement.ok ? identifier(requirement.data, ['signOffRequirementId']) : null;
  if (!signOffRequirementId) return blockedReport('run sign-off requirement was not created');
  const partCategory = await setup('create run part category', 'POST', '/part-categories', {
    categoryName: 'RUN' + token, description: 'Chaos run ' + runId,
  });
  const partCategorieId = partCategory.ok ? identifier(partCategory.data, ['partCategorieId']) : null;
  if (!partCategorieId) return blockedReport('run part category was not created');
  const part = await setup('create run part', 'POST', '/parts', {
    partNumber: plan.partNumber, description: 'Pièce run ' + token, traceabilityMode: 'None', partCategorieId,
  });
  const partId = part.ok ? identifier(part.data, ['partId']) : null;
  if (!partId) return blockedReport('run part was not created');
  const tool = await setup('create run tool', 'POST', '/tools', {
    toolNumber: plan.toolNumber, name: 'Outil run ' + token, description: 'Outil run',
    calibrationBasis: 'none', defaultCapturePolicy: 'required',
  });
  const toolId = tool.ok ? identifier(tool.data, ['toolId']) : null;
  if (!toolId) return blockedReport('run tool was not created');
  const instance = await setup('create run instance', 'POST', '/tool-instances', {
    toolId, assetTag: plan.tagCode, serialNo: plan.tagCode, status: 'active',
  });
  const toolInstanceId = instance.ok ? identifier(instance.data, ['toolInstanceId']) : null;
  if (!toolInstanceId) return blockedReport('run tool instance was not created');
  const ids = { partId, toolId, signOffRequirementId, tagCode: plan.tagCode };

  async function authorMaster(masterItemNo, operations) {
    const root = '/master-items/' + encodeURIComponent(masterItemNo);
    const made = await setup('create run master', 'POST', '/master-items', {
      masterItemNo, masterType: 'Prod', description: 'Chaos run ' + runId, seedInitialStructure: false,
    });
    if (!made.ok) return false;
    for (const spec of operations) {
      const created = await setup('add run operation', 'POST', root + '/operations', {
        operationNo: spec.operationNo, operationTitle: spec.title, operationDescription: spec.title,
        mustCompleteBeforeLater: spec.mustComplete,
      });
      if (!created.ok) return false;
      const authored = stepsAfterSeededOperation(created.data, [{ stepNo: 1, stepTitle: spec.title, stepDescription: spec.title }]);
      if (!authored.seeded) return false;
      const stepId = authored.seeded.masOpeStepId;
      if (!(await setup('name run step', 'PATCH', root + '/steps/' + stepId, authored.name)).ok) return false;
      if (!(await setup('write run instruction', 'PUT', '/mas-ope-step/' + stepId + '/blocks', instructionBlocksBody(spec.title))).ok) return false;
      if (spec.data && !(await setup('add run data', 'POST', root + '/data-points', {
        masOpeStepId: stepId, referenceCode: spec.data, label: spec.title, dataType: 'text', isMandatory: spec.mandatory !== false,
      })).ok) return false;
      if (spec.requirements) {
        if (!(await setup('add run part', 'POST', root + '/parts', { masOpeStepId: stepId, partId, quantityRequired: 1 })).ok) return false;
        if (!(await setup('add run tool', 'POST', root + '/tools', {
          masOpeStepId: stepId, toolId, capturePolicy: 'required', useQty: null, specText: 'Scanner ' + plan.tagCode + '.',
        })).ok) return false;
      }
      if (!(await setup('add run sign-off', 'POST', root + '/signoffs', { masOpeStepId: stepId, signOffRequirementId, level: 1 })).ok) return false;
    }
    return (await setup('release run master', 'PATCH', root, { status: 'Released' })).ok;
  }

  if (!(await authorMaster(plan.masterItemNo, [
    { operationNo: '10', title: 'Constater', mustComplete: true, data: 'RUN-BASE', requirements: true },
    { operationNo: '20', title: 'Contrôler', mustComplete: false, data: 'RUN-OPT', mandatory: false },
  ]))) return blockedReport('run master item was not created');
  if (!(await authorMaster(plan.foreignMasterItemNo, [
    { operationNo: '10', title: 'Étranger', mustComplete: true, data: 'RUN-FOR', mandatory: false },
  ]))) return blockedReport('run foreign master item was not created');

  const orderNo = plan.orderNo;
  const orderRoot = '/production-orders/' + encodeURIComponent(orderNo);
  if (!(await setup('create run PO', 'POST', '/production-orders', {
    source: 'master_item', orderNo, orderType: 'Prod', masterItemNo: plan.masterItemNo,
    effectivityDate, quantityPlanned: plan.unitCount, executionMode: 'sequential',
  })).ok) return blockedReport('run production order was not created');
  if (!(await setup('release run PO', 'POST', orderRoot + '/release', {})).ok) return blockedReport('run production order was not released');

  const units = new Map();
  for (let index = 1; index <= plan.unitCount; index += 1) {
    const created = await setup('create run WO', 'POST', orderRoot + '/units/' + index + '/lines/1/work-orders', {});
    const workOrderId = created.ok ? identifier(created.data, ['workOrderId']) : null;
    if (!workOrderId) return blockedReport('run work order ' + index + ' was not created');
    const detail = await setup('read run WO', 'GET', orderRoot + '/work-orders/' + workOrderId);
    const resolved = resolveWorkOrderIds(detail.data);
    if (!detail.ok || !resolved.ok) return blockedReport('run work order ' + index + ' could not be read');
    const summary = detail.data?.workOrder ?? {};
    units.set(index, {
      unitIndex: index,
      proUnitId: summary.proUnitId ?? null,
      runs: [{
        workOrderId, runNo: summary.runNo ?? 1, resolved, detail: detail.data,
        status: summary.status ?? 'Ready', supersedesWorkOrderId: summary.supersedesWorkOrderId ?? null,
        packageSource: summary.packageSource ?? 'master_item', variance: null, frozen: null,
      }],
    });
  }

  const sideRoot = '/production-orders/' + encodeURIComponent(plan.sideOrderNo);
  if (!(await setup('create run side PO', 'POST', '/production-orders', {
    source: 'master_item', orderNo: plan.sideOrderNo, orderType: 'Prod', masterItemNo: plan.foreignMasterItemNo,
    effectivityDate, quantityPlanned: 1, executionMode: 'sequential',
  })).ok) return blockedReport('run side production order was not created');
  if (!(await setup('release run side PO', 'POST', sideRoot + '/release', {})).ok) return blockedReport('run side production order was not released');
  const sideCreated = await setup('create run side WO', 'POST', sideRoot + '/units/1/lines/1/work-orders', {});
  const sideWorkOrderId = sideCreated.ok ? identifier(sideCreated.data, ['workOrderId']) : null;
  if (!sideWorkOrderId) return blockedReport('run side work order was not created');

  const users = await call('list run users', 'GET', '/admin/users');
  const secondary = listOf(users.data, 'users').map((user) => user.userId).find((id) => id && id !== envUserId) ?? envUserId;

  function state(unit) {
    return units.get(unit);
  }
  function selected(unit, from) {
    const current = state(unit);
    if (!current?.runs?.length) return null;
    if (from === 'first') return current.runs[0];
    if (from === 'previous') return current.runs[current.runs.length - 2] ?? null;
    return current.runs[current.runs.length - 1];
  }
  function locate(run, operationNo) {
    if (!run?.resolved?.ok) return null;
    return findStep(run.resolved, operationNo, '1');
  }

  async function readOrder() {
    const response = await call('read run order', 'GET', orderRoot);
    return response.status >= 200 && response.status < 300 ? response.data : null;
  }
  function orderFacts(detail, unitIndex) {
    const quantity = Number(detail?.order?.quantityCompleted);
    const unitsRows = Array.isArray(detail?.units) ? detail.units : [];
    const unitRow = unitsRows.find((row) => row.unitIndex === unitIndex) ?? null;
    const workOrders = Array.isArray(detail?.workOrders) ? detail.workOrders : [];
    const mine = unitRow ? workOrders.filter((row) => row.proUnitId === unitRow.proUnitId) : [];
    return {
      quantity: Number.isFinite(quantity) ? quantity : null,
      completedUnits: unitsRows.filter((row) => row.status === 'Completed').length,
      unitStatus: unitRow?.status ?? null,
      woTotal: unitRow?.workOrderTotal ?? mine.length,
      workOrderCompleted: unitRow?.workOrderCompleted ?? null,
      chain: mine.slice().sort((left, right) => (left.runNo ?? 1) - (right.runNo ?? 1)),
    };
  }
  async function readRun(run) {
    if (!run) return null;
    const response = await call('reread run WO', 'GET', orderRoot + '/work-orders/' + run.workOrderId);
    if (response.status < 200 || response.status >= 300) return null;
    const resolved = resolveWorkOrderIds(response.data);
    if (resolved.ok) run.resolved = resolved;
    run.detail = response.data;
    const summary = response.data?.workOrder ?? {};
    run.status = summary.status ?? run.status;
    run.runNo = summary.runNo ?? run.runNo;
    run.packageSource = summary.packageSource ?? run.packageSource;
    run.supersedesWorkOrderId = summary.supersedesWorkOrderId ?? run.supersedesWorkOrderId;
    return response.data;
  }
  function normalizeEvents(rows) {
    return (Array.isArray(rows) ? rows : []).map((event) => {
      const payload = event?.payloadJson ?? event?.payload ?? null;
      const id = event?.proAuditEventId ?? event?.eventId ?? event?.id ?? null;
      if (!id) return null;
      return { eventId: id, eventType: event.eventType ?? null, payloadJson: payload, eventTime: event.eventTime ?? event.createdAt ?? null };
    }).filter(Boolean);
  }
  async function readAudit(workOrderId) {
    const orderAudit = await call('read run audit', 'GET', orderRoot + '/audit-events');
    const workAudit = workOrderId
      ? await call('read run work audit', 'GET', orderRoot + '/work-orders/' + workOrderId + '/audit/events')
      : { data: {} };
    const merged = new Map();
    for (const event of [
      ...normalizeEvents(orderAudit.data?.auditEvents ?? orderAudit.data?.events),
      ...normalizeEvents(workAudit.data?.events ?? workAudit.data?.auditEvents),
    ]) merged.set(event.eventId, event);
    return [...merged.values()];
  }
  function rememberVariance(run, data) {
    const varianceId = readVarianceId(data);
    if (!varianceId) return;
    const row = data?.variance ?? data;
    const previous = run.variance ?? {};
    run.variance = {
      varianceId,
      revisionToken: row.revisionToken ?? previous.revisionToken ?? null,
      packageJson: row.packageJson?.operations?.length ? row.packageJson : previous.packageJson ?? null,
    };
  }
  async function readVariance(run) {
    if (!run?.variance?.varianceId) return null;
    const response = await call('reread run variance', 'GET', '/production-orders/variances/' + run.variance.varianceId);
    if (response.status < 200 || response.status >= 300) return null;
    rememberVariance(run, response.data);
    return run.variance;
  }
  function withOperation(packageJson, operation) {
    return { schemaVersion: packageJson?.schemaVersion ?? 1, operations: [...(packageJson?.operations ?? []), operation] };
  }

  async function dispatch(action) {
    const actor = action.actor === 'secondary' ? { userId: secondary } : undefined;
    const run = selected(action.unit, action.from);
    if (action.kind === 'create-unknown') {
      return call(action.id, 'POST', orderRoot + '/work-orders/' + MISSING_ID + '/runs', action.body ?? {});
    }
    if (action.kind === 'create-malformed') {
      return call(action.id, 'POST', orderRoot + '/work-orders/not-a-uuid/runs', action.body ?? {});
    }
    if (action.kind === 'create-foreign') {
      return call(action.id, 'POST', orderRoot + '/work-orders/' + sideWorkOrderId + '/runs', action.body ?? {});
    }
    if (action.kind === 'create-side') {
      return call(action.id, 'POST', sideRoot + '/work-orders/' + sideWorkOrderId + '/runs', action.body ?? {});
    }
    if (action.kind === 'delete-run') {
      return call(action.id, 'DELETE', orderRoot + '/work-orders/' + (run?.workOrderId ?? MISSING_ID) + '/runs');
    }
    if (action.kind === 'hold-po') return call(action.id, 'PATCH', orderRoot + '/status', { status: 'OnHold' });
    if (action.kind === 'resume-po') return call(action.id, 'PATCH', orderRoot + '/status', { status: 'InProgress' });
    if (action.kind === 'cancel-po') return call(action.id, 'PATCH', sideRoot + '/status', { status: 'Cancelled' });
    if (action.kind === 'deactivate-tool') return call(action.id, 'POST', '/tool-instances/' + toolInstanceId + '/deactivate');
    if (action.kind === 'read-order') return call(action.id, 'GET', orderRoot + '/work-orders/' + (run?.workOrderId ?? MISSING_ID));
    if (!run && !String(action.kind).startsWith('race-')) return { status: 0, harness: true, data: { error: 'run work order absent' } };
    if (action.kind === 'cancel-unit') {
      return call(action.id, 'POST', orderRoot + '/units/' + action.unit + '/cancel', action.body ?? {});
    }
    if (action.kind === 'cancel-wo' || action.kind === 'race-cancel') {
      return call(action.id, 'POST', orderRoot + '/work-orders/' + run.workOrderId + '/cancel', action.body ?? {});
    }
    if (action.kind === 'complete' || action.kind === 'race-complete') {
      return call(action.id, 'PATCH', orderRoot + '/work-orders/' + run.workOrderId + '/complete', {});
    }
    if (action.kind === 'create-run' || action.kind === 'race-create') {
      return call(action.id, 'POST', orderRoot + '/work-orders/' + run.workOrderId + '/runs', action.body ?? { source: 'master_item' }, actor);
    }
    if (action.kind === 'create-ncr' || action.kind === 'race-ncr') {
      return call(action.id, 'POST', orderRoot + '/work-orders/' + run.workOrderId + '/ncrs', { summary: action.body?.summary ?? 'Run' });
    }
    if (action.kind === 'raise-andon' || action.kind === 'race-andon') {
      const effect = action.effect === 'work_order' ? 'work_order' : 'none';
      return call(action.id, 'POST', orderRoot + '/work-orders/' + run.workOrderId + '/andons', {
        andonReasonId: reasons[effect], description: action.body?.description ?? 'Run',
      });
    }
    if (action.kind === 'create-variance' || action.kind === 'race-variance') {
      return call(action.id, 'POST', orderRoot + '/work-orders/' + run.workOrderId + '/variances', action.body ?? {});
    }
    if (action.kind === 'release-variance') {
      const id = run.variance?.varianceId;
      if (!id) return { status: 0, harness: true, data: { error: 'harness: variance absente' } };
      return call(action.id, 'POST', '/production-orders/variances/' + id + '/release', {});
    }
    if (action.kind === 'save-append') {
      const id = run.variance?.varianceId;
      if (!id || !run.variance?.packageJson) return { status: 0, harness: true, data: { error: 'harness: paquet absent' } };
      const keys = run.variance.packageJson.operations.map((operation) => Number(operation.orderKey) || 0);
      const packageJson = withOperation(run.variance.packageJson, addedOperation(ids, {
        logicalId: 'run-op-' + action.operationNo, orderKey: Math.max(0, ...keys) + 1000, operationNo: action.operationNo,
      }));
      return call(action.id, 'PUT', '/production-orders/variances/' + id, { packageJson, revisionToken: run.variance.revisionToken });
    }
    if (action.kind === 'export') {
      const base = orderRoot + '/work-orders/' + run.workOrderId;
      const traveler = await call(action.id + ' traveler', 'GET', base + '/traveler-report');
      const full = await call(action.id + ' export', 'GET', base + '/full-export');
      const own = action.exportValue ? containsText(traveler.data, action.exportValue) && containsText(full.data, action.exportValue) : true;
      const absent = action.absentValue ? !containsText(traveler.data, action.absentValue) && !containsText(full.data, action.absentValue) : true;
      const operation = action.operationNo ? containsText(traveler.data, '"operationNo":"' + action.operationNo + '"') : true;
      const hidden = action.absentOperationNo ? !containsText(traveler.data, '"operationNo":"' + action.absentOperationNo + '"') && !containsText(full.data, '"operationNo":"' + action.absentOperationNo + '"') : true;
      const identity = containsText(traveler.data, run.workOrderId) && containsText(full.data, run.workOrderId);
      const ok = traveler.status === 200 && full.status === 200 && own && absent && operation && hidden && identity;
      return { status: ok ? 200 : (traveler.status || full.status || 0), data: { exportOk: ok, traveler, full } };
    }
    const operationNo = String(action.step ?? '10');
    const step = locate(run, operationNo);
    if (!step?.proOpeStepId) return { status: 0, harness: true, data: { error: 'step was not on the run' } };
    const stepRoot = orderRoot + '/work-orders/' + run.workOrderId + '/steps/' + step.proOpeStepId;
    if (action.kind === 'capture-data' || action.kind === 'replace-data' || action.kind === 'race-data') {
      const point = step.dataPoints?.[0];
      if (!point?.proStepDataId) return { status: 0, harness: true, data: { error: 'data point was not on the step' } };
      const body = { capturedValueText: action.body?.valueText };
      if (action.body?.comment) body.comment = action.body.comment;
      return call(action.id, 'PATCH', stepRoot + '/data/' + point.proStepDataId, body);
    }
    if (action.kind === 'capture-part') {
      const partStepId = step.parts?.[0]?.proStepPartId;
      if (!partStepId) return { status: 0, harness: true, data: { error: 'part was not on the step' } };
      return call(action.id, 'PATCH', stepRoot + '/parts/' + partStepId, { quantityActual: action.body?.quantityActual ?? 1 });
    }
    if (action.kind === 'capture-tool') {
      const toolStepId = step.tools?.[0]?.proStepToolId;
      if (!toolStepId) return { status: 0, harness: true, data: { error: 'tool was not on the step' } };
      return call(action.id, 'PATCH', stepRoot + '/tools/' + toolStepId, { scanCode: plan.tagCode });
    }
    const signoffId = step.signoffs?.[0]?.proStepSignoffId;
    if (!signoffId) return { status: 0, harness: true, data: { error: 'sign-off was not on the step' } };
    return call(action.id, 'PATCH', stepRoot + '/signoffs/' + signoffId + '/pass', {});
  }

  async function acceptCreated(unit, prior, response) {
    const workOrderId = identifier(response.data, ['workOrderId']);
    if (!workOrderId || workOrderId === prior?.workOrderId) return;
    const detail = await call('read created run', 'GET', orderRoot + '/work-orders/' + workOrderId);
    const resolved = resolveWorkOrderIds(detail.data);
    const summary = detail.data?.workOrder ?? response.data ?? {};
    state(unit).runs.push({
      workOrderId,
      runNo: summary.runNo ?? response.data?.runNo ?? null,
      resolved: resolved.ok ? resolved : { ok: false, operations: [] },
      detail: detail.data,
      status: summary.status ?? response.data?.status ?? null,
      supersedesWorkOrderId: summary.supersedesWorkOrderId ?? response.data?.supersedesWorkOrderId ?? null,
      packageSource: summary.packageSource ?? response.data?.packageSource ?? null,
      variance: null,
      frozen: null,
    });
  }

  function snapshotFrom(action, response, beforeOrder, afterOrder, events, history, prior, current, beforeRun) {
    const facts = orderFacts(afterOrder, action.unit);
    const beforeFacts = orderFacts(beforeOrder, action.unit);
    const first = state(action.unit)?.runs?.[0];
    const frozen = first?.frozen;
    const firstEvidence = evidenceOf(first?.resolved);
    const currentEvidence = evidenceOf(current?.resolved);
    const isolated = Boolean(frozen && firstEvidence
      && firstEvidence.data === frozen.data
      && firstEvidence.partQty === frozen.partQty
      && firstEvidence.toolInstanceId === frozen.toolInstanceId
      && firstEvidence.signoffId === frozen.signoffId
      && (action.priorValue == null || firstEvidence.data === action.priorValue));
    const chain = facts.chain.map((row) => row.runNo);
    const linked = facts.chain.length > 0 && facts.chain.every((row, index) => index === 0 || row.supersedesWorkOrderId === facts.chain[index - 1].workOrderId);
    const completionEvents = history.filter((event) => event.eventType === 'WORK_ORDER_COMPLETED' && event.payloadJson?.workOrderId === current?.workOrderId).length;
    const quantity = facts.quantity;
    const singleCompletion = facts.unitStatus === 'Completed'
      && facts.workOrderCompleted === 1
      && quantity != null
      && quantity === facts.completedUnits;
    const createdId = identifier(response.data, ['workOrderId']);
    return {
      woStatus: current?.status ?? null,
      runNo: current?.runNo ?? null,
      packageSource: current?.packageSource ?? null,
      workOrderId: current?.workOrderId ?? null,
      supersedesPrior: Boolean(prior && current && current.supersedesWorkOrderId === prior.workOrderId && current.workOrderId !== prior.workOrderId),
      distinctWorkOrder: Boolean(prior && current && current.workOrderId !== prior.workOrderId),
      operations: operationNumbers(current?.detail),
      priorStatus: prior?.status ?? null,
      priorOperations: operationNumbers((action.from === 'first' ? prior : first)?.detail),
      isolated,
      distinctSignoff: Boolean(currentEvidence?.signoffId && frozen?.signoffId && currentEvidence.signoffId !== frozen.signoffId),
      distinctToolRow: Boolean(currentEvidence?.toolRowId && frozen?.toolRowId && currentEvidence.toolRowId !== frozen.toolRowId),
      unchanged: JSON.stringify(evidenceOf(current?.resolved)) === JSON.stringify(beforeRun?.evidence)
        && facts.woTotal === beforeFacts.woTotal
        && (current?.status ?? null) === (beforeRun?.status ?? null),
      created: facts.woTotal > beforeFacts.woTotal || Boolean(createdId && createdId !== prior?.workOrderId && response.status === 201),
      unitStatus: facts.unitStatus,
      woTotal: facts.woTotal,
      quantityDelta: facts.quantity != null && beforeFacts.quantity != null ? facts.quantity - beforeFacts.quantity : null,
      completionEvents,
      singleCompletion,
      chain: linked ? chain : [],
      exportOk: response.data?.exportOk === true,
      events,
      activeCount: facts.chain.filter((row) => row.status !== 'Cancelled').length,
      duplicateRunNo: new Set(chain).size !== chain.length,
    };
  }

  async function runOne(action) {
    const prior = selected(action.unit, action.from);
    const beforeOrder = await readOrder();
    const beforeAudit = await readAudit(prior?.workOrderId);
    const beforeRun = prior ? { evidence: evidenceOf(prior.resolved), status: prior.status } : null;
    const response = await dispatch(action);
    if (['create-variance', 'save-append', 'release-variance', 'race-variance'].includes(action.kind)) {
      rememberVariance(prior, response.data);
      await readVariance(prior);
    }
    if ((action.kind === 'create-run' || action.kind === 'race-create') && response.status === 201) {
      await acceptCreated(action.unit, prior, response);
    }
    const current = selected(action.unit, action.kind === 'create-run' && response.status === 201 ? 'current' : action.from) ?? prior;
    if (current) await readRun(current);
    if (prior && prior !== current) await readRun(prior);
    if (action.kind === 'cancel-wo' && response.status === 200 && prior) {
      prior.frozen = evidenceOf(prior.resolved);
    }
    const first = state(action.unit)?.runs?.[0];
    if (first && first !== current && first !== prior) await readRun(first);
    const afterOrder = await readOrder();
    const history = await readAudit(current?.workOrderId ?? prior?.workOrderId);
    const events = runEvents(beforeAudit, history);
    const viewed = action.kind === 'create-run' && response.status === 201 ? selected(action.unit, 'current') : current;
    const snapshot = snapshotFrom(action, response, beforeOrder, afterOrder, events, history, prior, viewed, beforeRun);
    if (action.kind === 'save-append') {
      snapshot.operations = (prior?.variance?.packageJson?.operations ?? []).map((operation) => String(operation.operationNo));
    }
    if (action.kind === 'export') snapshot.exportOk = response.data?.exportOk === true;
    if (action.kind === 'read-order' || action.kind === 'export') {
      snapshot.operations = operationNumbers((await readRun(current), current?.detail));
    }
    const judgedPrior = action.from === 'first' ? prior : first;
    if (judgedPrior) {
      snapshot.priorStatus = judgedPrior.status;
      snapshot.priorOperations = operationNumbers(judgedPrior.detail);
    }
    if (action.chain && snapshot.chain) {
      const rows = orderFacts(afterOrder, action.unit).chain;
      const linked = rows.length === action.chain.length && rows.every((row, index) => row.runNo === action.chain[index] && (index === 0 || row.supersedesWorkOrderId === rows[index - 1].workOrderId));
      snapshot.chain = linked ? action.chain : snapshot.chain;
    }
    const judgment = judgeRunObservation(action, response, snapshot);
    observations.push({ actionId: action.id, judgment });
    if (judgment.outcome === 'contract-decision') {
      contractDecisions.push({ id: action.id, label: action.label, text: contractDecisionText(action.contractDecision), failures: judgment.failures });
    }
    if (!['accepted', 'correctly-rejected', 'contract-decision', 'not-applicable', 'harness'].includes(judgment.outcome) || (judgment.outcome === 'contract-decision' && judgment.failures?.length)) {
      findings.push({ id: action.id, label: action.label, outcome: judgment.outcome, failures: judgment.failures, status: response.status, route: action.kind, body: action.body ?? null });
    }
  }

  async function runRace(peers) {
    const unit = peers[0].unit;
    const prior = selected(unit, 'current');
    const beforeOrder = await readOrder();
    const beforeAudit = await readAudit(prior?.workOrderId);
    const beforeEvidence = evidenceOf(prior?.resolved);
    const responses = await Promise.all(peers.map(async (action) => {
      if (action.delayMs) await sleep(action.delayMs);
      const response = await dispatch(action);
      return { action, response };
    }));
    for (const item of responses) {
      if (item.response.status === 201 && item.action.kind === 'race-create') await acceptCreated(unit, prior, item.response);
      if (item.action.kind === 'race-variance') rememberVariance(prior, item.response.data);
    }
    const current = selected(unit, 'current');
    if (prior) await readRun(prior);
    if (current && current !== prior) await readRun(current);
    const afterOrder = await readOrder();
    const events = runEvents(beforeAudit, await readAudit(current?.workOrderId ?? prior?.workOrderId));
    const facts = orderFacts(afterOrder, unit);
    const beforeFacts = orderFacts(beforeOrder, unit);
    const cancelEvent = events.find((event) => event.eventType === 'WORK_ORDER_CANCELLED');
    const tagged = events.map((event) => ({
      ...event,
      afterCancel: Boolean(
        cancelEvent
        && event.eventType === 'DATA_CAPTURED'
        && event.eventId !== cancelEvent.eventId
        && cancelEvent.eventTime
        && event.eventTime
        && event.eventTime > cancelEvent.eventTime,
      ),
    }));
    const expectedRunNo = peers[0].family === 'run3-double' ? 3
      : (['double-create', 'two-actors', 'complete-vs-run3'].includes(peers[0].family) ? 2 : 1);
    const judgment = judgeRunRace(peers[0].family, responses.map((item) => ({
      status: item.response.status, peer: item.action.peer, code: item.response.data?.code ?? null, error: item.response.data?.error ?? item.response.data?.message ?? '',
    })), {
      events: tagged,
      runNo: current?.runNo ?? prior?.runNo ?? null,
      expectedRunNo,
      activeCount: facts.chain.filter((row) => row.status !== 'Cancelled').length,
      priorStatus: prior?.status ?? null,
      duplicateRunNo: new Set(facts.chain.map((row) => row.runNo)).size !== facts.chain.length,
      woStatus: (peers[0].family === 'complete-vs-run3' ? current : prior)?.status ?? current?.status ?? null,
      quantityDelta: facts.quantity != null && beforeFacts.quantity != null ? facts.quantity - beforeFacts.quantity : 0,
      dataChanged: JSON.stringify(evidenceOf(prior?.resolved)?.data) !== JSON.stringify(beforeEvidence?.data),
      cancelEventId: cancelEvent?.eventId ?? null,
    });
    races.push({ family: peers[0].family, actions: peers.length, judgment, http: responses.map((item) => item.response.status) });
    if (judgment.outcome !== 'valid-linearization') {
      findings.push({ id: peers.map((action) => action.id).join('+'), outcome: judgment.outcome, failures: judgment.failures, status: responses.map((item) => item.response.status) });
    }
  }

  let index = 0;
  const actions = plan.actions.filter((action) => action.applicable !== false);
  while (index < actions.length) {
    const action = actions[index];
    if (String(action.kind).startsWith('race-')) {
      const peers = [];
      while (
        index < actions.length
        && String(actions[index].kind).startsWith('race-')
        && actions[index].family === action.family
        && actions[index].unit === action.unit
        && actions[index].repeat === action.repeat
      ) {
        peers.push(actions[index]);
        index += 1;
      }
      await runRace(peers);
      continue;
    }
    await runOne(action);
    index += 1;
  }

  const counters = runVerdict(plan.actions, observations, races);
  return {
    setupPass: true,
    capturePass: counters.capturePass,
    chaosPass: counters.chaosPass,
    pass: counters.pass,
    runPlanHash: plan.runPlanHash,
    orderNo: plan.orderNo,
    sideOrderNo: plan.sideOrderNo,
    unitCount: plan.unitCount,
    counters,
    findings, contractDecisions, notApplicable, concurrency: races, blocked: [],
    setup: {
      orderNo: plan.orderNo,
      sideOrderNo: plan.sideOrderNo,
      masterItemNo: plan.masterItemNo,
      foreignMasterItemNo: plan.foreignMasterItemNo,
      secondaryDistinct: secondary !== envUserId,
    },
  };
}
