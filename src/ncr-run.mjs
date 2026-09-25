import { identifier, instructionBlocksBody, stepsAfterSeededOperation } from './engine.mjs';
import { findStep, resolveWorkOrderIds } from './wo-resolve.mjs';
import { bindNcrPlan, ncrPlan } from './ncr-plan.mjs';
import {
  emptyNcrCounters, judgeNcrObservation, judgeNcrRace, ncrVerdict, recordNcrOutcome,
} from './ncr-judge.mjs';

const NCR_BODY_KEYS = ['summary', 'detail', 'ncrReasonId', 'proOpeId', 'proOpeStepId', 'sourceObject', 'attachMobileUploadSessionIds', 'evidenceJson'];

export function strictNcrBody(body) {
  const next = {};
  for (const key of NCR_BODY_KEYS) {
    if (body && Object.prototype.hasOwnProperty.call(body, key)) next[key] = body[key];
  }
  return next;
}

export function buildAndonRaiseBody(action, reasonId, located) {
  const body = { andonReasonId: reasonId };
  if (action.body?.description != null) body.description = action.body.description;
  const effect = action.effect ?? 'none';
  if ((effect === 'operation' || effect === 'step') && located?.operation?.proOpeId) body.proOpeId = located.operation.proOpeId;
  if (effect === 'step' && located?.step?.proOpeStepId) body.proOpeStepId = located.step.proOpeStepId;
  return body;
}

const CONTRACT_BY_LABEL = {
  'create-after-cancel': 'create-after-cancel',
  'completed-target': 'create-on-completed',
  'pass-20-completes': 'open-ncr-does-not-block-completion',
  'explicit-complete': 'open-ncr-does-not-block-completion',
};

const EXPORT_WITH_ACTION = new Set(['pass-20-completes', 'close-created-after-cancel', 'ncr-from-andon']);
const MISSING_ID = '00000000-0000-4000-8000-000000000000';
const SOURCE_ID = '44444444-4444-4444-8444-444444444444';

function listOf(data, key) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.[key])) return data[key];
  return [];
}

function projectNcr(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    ncrId: row.ncrId ?? null,
    ncrNo: row.ncrNo ?? null,
    status: row.status ?? null,
    summary: row.summary ?? null,
    detail: row.detail ?? null,
    reasonName: row.reasonName ?? null,
    andonId: row.andonId ?? null,
    proOpeId: row.proOpeId ?? null,
    proOpeStepId: row.proOpeStepId ?? null,
    closeComment: row.closeComment ?? null,
    raisedBy: row.raisedBy ?? null,
    closedBy: row.closedBy ?? null,
    raisedAt: row.raisedAt ?? null,
    closedAt: row.closedAt ?? null,
  };
}

function normalizeEvents(rows) {
  return (Array.isArray(rows) ? rows : []).map((event) => {
    const payload = event?.payloadJson ?? event?.payload ?? null;
    const id = event?.proAuditEventId ?? event?.eventId ?? event?.id ?? null;
    if (!id) return null;
    return { id, eventType: event.eventType ?? null, payloadJson: payload, workOrderId: payload?.workOrderId ?? null };
  }).filter(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runNcrCapture(input) {
  const { setup, call, seed, runId, prefix, effectivityDate, envUserId } = input;
  const plan = bindNcrPlan(ncrPlan(seed), runId, prefix);
  const counters = emptyNcrCounters();
  const executable = plan.actions.filter((action) => action.applicable !== false);
  counters.plannedActions = executable.length;
  const findings = [];
  const contractDecisions = [];
  const notApplicable = plan.actions.filter((action) => action.applicable === false).map((action) => ({ id: action.id, label: action.label, reason: action.reason }));
  const concurrency = [];
  const blocked = [];
  const lastNcr = new Map();
  const lastAndon = new Map();

  const blockedReport = (reason) => ({
    setupPass: false, capturePass: false, chaosPass: false, pass: false,
    ncrPlanHash: plan.ncrPlanHash, orderNo: plan.orderNo, counters: { ...counters, pass: false },
    findings: [{ severity: 'high', invariant: reason }],
    contractDecisions, notApplicable, concurrency, blocked: [{ id: 'setup', reason }],
  });
  if (!input.skipReasonId || !input.reopenReasonId) return blockedReport('chaos skip or reopen reason was not established');
  const skipReasonId = input.skipReasonId;
  const reopenReasonId = input.reopenReasonId;

  const known = ['SIG', 'SIGS', 'SIGL', 'SIGO', 'OBS', 'REQ', 'OPT', 'INF', 'NN', 'SE', 'LO', 'LC', 'AND'];
  if (known.some((suffix) => plan.partNumber.endsWith(suffix) || plan.toolNumber.endsWith(suffix))) {
    return blockedReport('ncr catalog number collides with another slice');
  }

  const reasons = {};
  for (const [key, reasonName, extra] of [
    ['any', plan.reasons.any, {}],
    ['data', plan.reasons.data, { objectTrigger: 'data' }],
    ['inactive', plan.reasons.inactive, { isActive: false }],
  ]) {
    const created = await setup('create ncr reason ' + key, 'POST', '/ncr-reasons', {
      reasonName, description: 'Chaos NCR ' + key, isActive: extra.isActive !== false, ...extra,
    });
    reasons[key] = created.ok ? identifier(created.data, ['ncrReasonId']) : null;
    if (!reasons[key]) return blockedReport('ncr reason ' + key + ' was not created');
  }
  const andonReasons = {};
  const andonReasonNames = {};
  for (const [key, reasonName, effect] of [
    ['work_order', plan.reasons.andonWorkOrder, 'work_order'],
    ['none', plan.reasons.andonNone, 'none'],
    ['operation', plan.reasons.andonNone + 'OP', 'operation'],
  ]) {
    const created = await setup('create ncr andon reason ' + key, 'POST', '/andon-reasons', {
      reasonName, description: 'Chaos NCR ' + effect, effect, promptsNcr: false, isActive: true,
    });
    andonReasons[effect] = created.ok ? identifier(created.data, ['andonReasonId']) : null;
    andonReasonNames[effect] = reasonName;
    if (!andonReasons[effect]) return blockedReport('ncr andon reason ' + effect + ' was not created');
  }

  const token = plan.runToken;
  const category = await setup('create ncr sign-off category', 'POST', '/sign-off-categories', { name: 'NCR ' + token });
  const categoryId = category.ok ? identifier(category.data, ['signOffCategorieId']) : null;
  if (!categoryId) return blockedReport('ncr sign-off category was not created');
  const requirement = await setup('create ncr sign-off', 'POST', '/sign-off-requirements', {
    name: 'NCR operator ' + token, signOffCategorieId: categoryId, requiredPrivilege: 'signoff.operator',
    requiresUniqueSignerWithinStep: false, scope: 'step', level: 1,
  });
  const signOffRequirementId = requirement.ok ? identifier(requirement.data, ['signOffRequirementId']) : null;
  if (!signOffRequirementId) return blockedReport('ncr sign-off requirement was not created');
  const partCategory = await setup('create ncr part category', 'POST', '/part-categories', {
    categoryName: 'NCR' + token, description: 'Chaos ncr ' + runId,
  });
  const partCategorieId = partCategory.ok ? identifier(partCategory.data, ['partCategorieId']) : null;
  if (!partCategorieId) return blockedReport('ncr part category was not created');
  const part = await setup('create ncr part', 'POST', '/parts', {
    partNumber: plan.partNumber, description: 'Pièce NCR ' + token, traceabilityMode: 'None', partCategorieId,
  });
  const partId = part.ok ? identifier(part.data, ['partId']) : null;
  if (!partId) return blockedReport('ncr part was not created');
  const tool = await setup('create ncr tool', 'POST', '/tools', {
    toolNumber: plan.toolNumber, name: 'Outil NCR ' + token, description: 'Outil NCR',
    calibrationBasis: 'none', defaultCapturePolicy: 'required',
  });
  const toolId = tool.ok ? identifier(tool.data, ['toolId']) : null;
  if (!toolId) return blockedReport('ncr tool was not created');
  const instance = await setup('create ncr instance', 'POST', '/tool-instances', {
    toolId, assetTag: plan.tagCode, serialNo: plan.tagCode, status: 'active',
  });
  if (!instance.ok) return blockedReport('ncr tool instance was not created');

  const masterItemNo = plan.masterItemNo;
  const root = '/master-items/' + encodeURIComponent(masterItemNo);
  const made = await setup('create ncr master', 'POST', '/master-items', {
    masterItemNo, masterType: 'Prod', description: 'Chaos NCR ' + runId, seedInitialStructure: false,
  });
  if (!made.ok) return blockedReport('ncr master item was not created');
  for (const [operationNo, mustComplete, title] of [['10', true, 'Constater'], ['20', false, 'Contrôler']]) {
    const created = await setup('add ncr operation', 'POST', root + '/operations', {
      operationNo, operationTitle: title, operationDescription: title, mustCompleteBeforeLater: mustComplete,
    });
    if (!created.ok) return blockedReport('ncr operation was not created');
    const authored = stepsAfterSeededOperation(created.data, [{ stepNo: 1, stepTitle: title, stepDescription: title }]);
    if (!authored.seeded) return blockedReport('ncr step was not seeded');
    const named = await setup('name ncr step', 'PATCH', root + '/steps/' + authored.seeded.masOpeStepId, authored.name);
    if (!named.ok) return blockedReport('ncr step was not named');
    const stepId = authored.seeded.masOpeStepId;
    if (!(await setup('write ncr instruction', 'PUT', '/mas-ope-step/' + stepId + '/blocks', instructionBlocksBody(title))).ok) {
      return blockedReport('ncr instruction was not written');
    }
    if (!(await setup('add ncr data', 'POST', root + '/data-points', {
      masOpeStepId: stepId, referenceCode: operationNo === '10' ? 'NCR-NOTE' : 'NCR-OPT',
      label: title, dataType: 'text', isMandatory: operationNo === '10',
    })).ok) return blockedReport('ncr data was not created');
    if (operationNo === '10') {
      const attachedPart = await setup('add ncr part', 'POST', root + '/parts', { masOpeStepId: stepId, partId, quantityRequired: 1 });
      const attachedTool = await setup('add ncr tool', 'POST', root + '/tools', {
        masOpeStepId: stepId, toolId, capturePolicy: 'required', useQty: null, specText: 'Scanner ' + plan.tagCode + '.',
      });
      if (!attachedPart.ok || !attachedTool.ok) return blockedReport('ncr requirements were not attached');
    }
    if (!(await setup('add ncr sign-off', 'POST', root + '/signoffs', { masOpeStepId: stepId, signOffRequirementId, level: 1 })).ok) {
      return blockedReport('ncr sign-off was not attached');
    }
  }
  if (!(await setup('release ncr master', 'PATCH', root, { status: 'Released' })).ok) return blockedReport('ncr master item was not released');
  const orderNo = plan.orderNo;
  const orderRoot = '/production-orders/' + encodeURIComponent(orderNo);
  if (!(await setup('create ncr PO', 'POST', '/production-orders', {
    source: 'master_item', orderNo, orderType: 'Prod', masterItemNo,
    effectivityDate, quantityPlanned: plan.unitCount, executionMode: 'sequential',
  })).ok) return blockedReport('ncr production order was not created');
  if (!(await setup('release ncr PO', 'POST', orderRoot + '/release', {})).ok) return blockedReport('ncr production order was not released');
  const workOrders = [];
  for (let unit = 1; unit <= plan.unitCount; unit += 1) {
    const created = await setup('create ncr WO', 'POST', orderRoot + '/units/' + unit + '/lines/1/work-orders', {});
    const workOrderId = created.ok ? identifier(created.data, ['workOrderId']) : null;
    if (!workOrderId) return blockedReport('ncr work order ' + unit + ' was not created');
    const detail = await setup('read ncr WO', 'GET', orderRoot + '/work-orders/' + workOrderId);
    const resolved = resolveWorkOrderIds(detail.data);
    if (!detail.ok || !resolved.ok) return blockedReport('ncr work order ' + unit + ' could not be read');
    workOrders.push({ unit, workOrderId, resolved });
  }
  const otherRoot = '/production-orders/' + encodeURIComponent(plan.foreignOrderNo);
  if (!(await setup('create ncr other PO', 'POST', '/production-orders', {
    source: 'master_item', orderNo: plan.foreignOrderNo, orderType: 'Prod', masterItemNo,
    effectivityDate, quantityPlanned: 1, executionMode: 'sequential',
  })).ok) return blockedReport('ncr second production order was not created');
  if (!(await setup('release ncr other PO', 'POST', otherRoot + '/release', {})).ok) return blockedReport('ncr second production order was not released');
  const otherWo = await setup('create ncr other WO', 'POST', otherRoot + '/units/1/lines/1/work-orders', {});
  const otherWorkOrderId = otherWo.ok ? identifier(otherWo.data, ['workOrderId']) : null;
  const otherDetail = otherWorkOrderId ? await setup('read ncr other WO', 'GET', otherRoot + '/work-orders/' + otherWorkOrderId) : null;
  const otherResolved = otherDetail?.ok ? resolveWorkOrderIds(otherDetail.data) : null;
  if (!otherResolved?.ok) return blockedReport('ncr second work order could not be read');

  const users = await call('list ncr users', 'GET', '/admin/users');
  const secondary = listOf(users.data, 'users').map((user) => user.userId).find((id) => id && id !== envUserId) ?? envUserId;

  function wo(unit) {
    return workOrders.find((item) => item.unit === unit);
  }
  function locate(unit, operationNo) {
    const current = wo(unit);
    if (!current) return null;
    return {
      current,
      operation: current.resolved.operations.find((item) => item.operationNo === String(operationNo)),
      step: findStep(current.resolved, operationNo, '1'),
    };
  }
  async function readAudit(workOrderId) {
    const orderAudit = await call('read ncr audit', 'GET', orderRoot + '/audit-events');
    const workAudit = workOrderId
      ? await call('read ncr work audit', 'GET', orderRoot + '/work-orders/' + workOrderId + '/audit/events')
      : { data: {} };
    const merged = new Map();
    for (const event of [
      ...normalizeEvents(orderAudit.data?.auditEvents ?? orderAudit.data?.events),
      ...normalizeEvents(workAudit.data?.events ?? workAudit.data?.auditEvents),
    ]) merged.set(event.id, event);
    return [...merged.values()];
  }
  async function readWo(unit) {
    const current = wo(unit);
    if (!current) return null;
    const response = await call('reread ncr WO', 'GET', orderRoot + '/work-orders/' + current.workOrderId);
    if (response.status < 200 || response.status >= 300) return null;
    const resolved = resolveWorkOrderIds(response.data);
    if (resolved.ok) current.resolved = resolved;
    return response.data?.workOrder ?? response.data?.summary ?? null;
  }
  async function readNcr(ncrId) {
    if (!ncrId) return null;
    const response = await call('reread ncr', 'GET', '/production-orders/ncrs/' + ncrId);
    if (response.status < 200 || response.status >= 300) return null;
    return projectNcr(response.data?.ncr ?? response.data);
  }
  async function readAndon(andonId) {
    if (!andonId) return null;
    const response = await call('reread ncr andon', 'GET', '/production-orders/andons/' + andonId);
    if (response.status < 200 || response.status >= 300) return null;
    return response.data?.andon ?? response.data;
  }
  function targetUnit(action) {
    return action.on === 'completed' ? 4 : action.unit;
  }
  function createBody(action, unit) {
    const body = { ...(action.body ?? {}) };
    if (action.reason === 'inactive') body.ncrReasonId = reasons.inactive;
    if (action.reason === 'data') body.ncrReasonId = reasons.data;
    if (action.reason === 'any') body.ncrReasonId = reasons.any;
    if (action.source) body.sourceObject = { type: action.source, id: SOURCE_ID, label: action.source };
    if (action.target === 'operation' || action.target === 'step') {
      const located = locate(unit, '10');
      body.proOpeId = located?.operation?.proOpeId ?? MISSING_ID;
      if (action.target === 'step') body.proOpeStepId = located?.step?.proOpeStepId ?? MISSING_ID;
    }
    if (action.target === 'foreign-operation') body.proOpeId = otherResolved.operations[0]?.proOpeId ?? MISSING_ID;
    if (action.target === 'mismatched-step') {
      body.proOpeId = locate(unit, '10')?.operation?.proOpeId ?? MISSING_ID;
      body.proOpeStepId = locate(unit, '20')?.step?.proOpeStepId ?? MISSING_ID;
    }
    return body;
  }
  function captureBody(action) {
    const body = { ...(action.body ?? {}) };
    if (Object.prototype.hasOwnProperty.call(body, 'valueText')) {
      body.capturedValueText = body.valueText;
      delete body.valueText;
    }
    return body;
  }
  function snapshot(unit) {
    const step = locate(unit, '10')?.step;
    return {
      text: step?.dataPoints?.[0]?.capturedValueText ?? step?.dataPoints?.[0]?.valueText ?? null,
      quantity: step?.parts?.[0]?.quantityActual ?? null,
      toolInstanceId: step?.tools?.[0]?.toolInstanceId ?? null,
      signoff: step?.signoffs?.[0]?.outcome ?? null,
    };
  }

  async function dispatch(action) {
    const unit = targetUnit(action);
    const current = wo(unit);
    const actor = action.actor === 'secondary' ? secondary : envUserId;
    const options = { userId: actor };
    if (action.kind === 'create' || action.kind === 'race-create') {
      return call(action.id, 'POST', orderRoot + '/work-orders/' + current.workOrderId + '/ncrs', createBody(action, unit), options);
    }
    if (action.kind === 'create-from-andon' || action.kind === 'race-create-andon') {
      const andonId = lastAndon.get(unit);
      return call(action.id, 'POST', '/production-orders/andons/' + andonId + '/ncrs', strictNcrBody(createBody(action, unit)), options);
    }
    if (action.kind === 'create-foreign-order') {
      return call(action.id, 'POST', orderRoot + '/work-orders/' + otherWorkOrderId + '/ncrs', createBody(action, unit), options);
    }
    if (action.kind === 'create-unknown-wo') {
      return call(action.id, 'POST', orderRoot + '/work-orders/' + MISSING_ID + '/ncrs', createBody(action, unit), options);
    }
    if (action.kind === 'create-malformed-wo') {
      return call(action.id, 'POST', orderRoot + '/work-orders/pas-un-uuid/ncrs', createBody(action, unit), options);
    }
    if (action.kind === 'close' || action.kind === 'race-close') {
      return call(action.id, 'POST', '/production-orders/ncrs/' + lastNcr.get(unit) + '/close', action.body ?? {}, options);
    }
    if (action.kind === 'close-unknown') {
      return call(action.id, 'POST', '/production-orders/ncrs/' + MISSING_ID + '/close', action.body ?? {});
    }
    if (action.kind === 'close-malformed') {
      return call(action.id, 'POST', '/production-orders/ncrs/pas-un-uuid/close', action.body ?? {});
    }
    if (action.kind === 'get') {
      return call(action.id, 'GET', '/production-orders/ncrs/' + lastNcr.get(unit));
    }
    if (action.kind === 'delete') {
      return call(action.id, 'DELETE', '/production-orders/ncrs/' + (lastNcr.get(unit) ?? MISSING_ID));
    }
    if (action.kind === 'put') {
      return call(action.id, 'PUT', orderRoot + '/work-orders/' + current.workOrderId + '/ncrs', action.body ?? {});
    }
    if (action.kind === 'cancel' || action.kind === 'race-cancel') {
      return call(action.id, 'POST', orderRoot + '/work-orders/' + current.workOrderId + '/cancel', action.body ?? {});
    }
    if (action.kind === 'complete' || action.kind === 'race-complete') {
      return call(action.id, 'PATCH', orderRoot + '/work-orders/' + current.workOrderId + '/complete', {});
    }
    if (action.kind === 'hold-po') return call(action.id, 'PATCH', orderRoot + '/status', { status: 'OnHold' });
    if (action.kind === 'release-po') return call(action.id, 'PATCH', orderRoot + '/status', { status: 'InProgress' });
    if (action.kind === 'raise-andon') {
      const effect = action.effect ?? 'none';
      const located = locate(unit, action.operationNo ?? '10');
      return call(action.id, 'POST', orderRoot + '/work-orders/' + current.workOrderId + '/andons', buildAndonRaiseBody(action, andonReasons[effect], located));
    }
    if (action.kind === 'close-andon' || action.kind === 'race-close-andon') {
      return call(action.id, 'POST', '/production-orders/andons/' + lastAndon.get(unit) + '/close', action.body ?? {});
    }
    const located = locate(unit, action.step ?? action.operationNo ?? '10');
    if (!located?.step) return { status: 0, data: { error: 'step was not on the work order' } };
    const stepRoot = orderRoot + '/work-orders/' + current.workOrderId + '/steps/' + located.step.proOpeStepId;
    if (action.kind === 'capture-data' || action.kind === 'race-data') {
      const dataId = located.step.dataPoints?.[0]?.proStepDataId;
      if (!dataId) return { status: 0, data: { error: 'data point was not on the step' } };
      return call(action.id, 'PATCH', stepRoot + '/data/' + dataId, captureBody(action));
    }
    if (action.kind === 'capture-part') {
      const partStepId = located.step.parts?.[0]?.proStepPartId;
      if (!partStepId) return { status: 0, data: { error: 'part was not on the step' } };
      return call(action.id, 'PATCH', stepRoot + '/parts/' + partStepId, action.body ?? {});
    }
    if (action.kind === 'capture-tool') {
      const toolStepId = located.step.tools?.[0]?.proStepToolId;
      if (!toolStepId) return { status: 0, data: { error: 'tool was not on the step' } };
      return call(action.id, 'PATCH', stepRoot + '/tools/' + toolStepId, { scanCode: plan.tagCode, ...(action.body ?? {}) });
    }
    const signoffId = located.step.signoffs?.[0]?.proStepSignoffId;
    if (!signoffId) return { status: 0, data: { error: 'sign-off was not on the step' } };
    if (action.kind === 'pass' || action.kind === 'race-pass') {
      return call(action.id, 'PATCH', stepRoot + '/signoffs/' + signoffId + '/pass', {});
    }
    if (action.kind === 'skip') {
      if (!skipReasonId) return { status: 0, data: { error: 'skip reason was not available' } };
      return call(action.id, 'PATCH', stepRoot + '/signoffs/' + signoffId + '/skip', { skipReasonId, ...(action.body ?? {}) });
    }
    if (action.kind === 'reopen') {
      if (!reopenReasonId) return { status: 0, data: { error: 'reopen reason was not available' } };
      return call(action.id, 'PATCH', stepRoot + '/signoffs/' + signoffId + '/reopen', { reopenReasonId, ...(action.body ?? {}) });
    }
    return { status: 0, data: { error: 'unhandled ncr action ' + action.kind } };
  }

  function remember(action, response) {
    const unit = targetUnit(action);
    const createdId = identifier(response.data, ['ncrId']);
    if (createdId && response.status >= 200 && response.status < 300 && (action.kind.includes('create'))) lastNcr.set(unit, createdId);
    const andonId = identifier(response.data, ['andonId']);
    if (andonId && response.status >= 200 && response.status < 300 && action.kind === 'raise-andon') lastAndon.set(unit, andonId);
  }

  function pickNcrs(data) {
    const found = [];
    const walk = (value) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') {
        if (value.ncrId) found.push(value);
        Object.values(value).forEach(walk);
      }
    };
    walk(data);
    return found;
  }
  async function loadExports(action, unit) {
    const base = orderRoot + '/work-orders/' + wo(unit).workOrderId;
    const traveler = await call(action.id + ' traveler', 'GET', base + '/traveler-report');
    const full = await call(action.id + ' export', 'GET', base + '/full-export');
    return {
      traveler: { called: true, status: traveler.status, ncrs: pickNcrs(traveler.data) },
      full: { called: true, status: full.status, ncrs: pickNcrs(full.data) },
    };
  }

  async function observe(action) {
    const unit = targetUnit(action);
    await readWo(unit);
    const ncrAfter = await readNcr(lastNcr.get(unit));
    const andon = await readAndon(lastAndon.get(unit));
    const woRow = await readWo(unit);
    return {
      ncrAfter,
      andonStatus: andon?.status ?? null,
      andonEffect: andon?.effect ?? null,
      andonReasonName: andon?.reasonName ?? null,
      woStatus: woRow?.status ?? null,
    };
  }

  async function runOne(action) {
    const unit = targetUnit(action);
    const eventsBefore = await readAudit(wo(unit)?.workOrderId);
    const ncrBefore = await readNcr(lastNcr.get(unit));
    await readWo(unit);
    const captureBefore = snapshot(unit);
    const response = action.kind === 'export' ? { status: 200, data: {} } : await dispatch(action);
    if (action.kind !== 'export') remember(action, response);
    const after = await observe(action);
    const exports = action.kind === 'export' || EXPORT_WITH_ACTION.has(action.label)
      ? await loadExports(action, unit)
      : null;
    const exportOk = exports
      && exports.traveler.status >= 200 && exports.traveler.status < 300
      && exports.full.status >= 200 && exports.full.status < 300;
    const status = action.kind === 'export'
      ? (exportOk ? 200 : (exports?.traveler.status || exports?.full.status || 0))
      : response.status;
    const judgment = judgeNcrObservation({
      action,
      status,
      data: response.data,
      eventsBefore,
      eventsAfter: await readAudit(wo(unit)?.workOrderId),
      ncrBefore,
      ncrAfter: after.ncrAfter,
      captureBefore,
      captureAfter: snapshot(unit),
      woStatus: after.woStatus,
      andonStatus: after.andonStatus,
      andonEffect: after.andonEffect,
      andonReasonName: after.andonReasonName,
      expectedReasonName: action.kind === 'raise-andon' ? andonReasonNames[action.effect ?? 'none'] : null,
      exports,
      contractDecision: CONTRACT_BY_LABEL[action.label] ?? null,
    });
    recordNcrOutcome(counters, action, judgment);
    if (judgment.outcome === 'contract-decision') {
      contractDecisions.push({ id: action.id, label: action.label, status, invariant: judgment.invariant });
    }
    if (judgment.finding) findings.push({ id: action.id, severity: 'high', invariant: judgment.invariant, status, body: action.body ?? null });
    if (judgment.outcome === 'harness') blocked.push({ id: action.id, reason: judgment.invariant });
  }

  async function runRace(peers) {
    const unit = peers[0].unit;
    const eventsBefore = await readAudit(wo(unit).workOrderId);
    const responses = await Promise.all(peers.map(async (action) => {
      if (action.delayMs) await sleep(action.delayMs);
      const response = await dispatch(action);
      return { action, response };
    }));
    for (const item of responses) remember(item.action, item.response);
    await readWo(unit);
    const created = responses.map((item) => identifier(item.response.data, ['ncrId'])).find(Boolean) ?? lastNcr.get(unit);
    if (created) lastNcr.set(unit, created);
    const ncrAfter = await readNcr(lastNcr.get(unit));
    const andon = await readAndon(lastAndon.get(unit));
    const woRow = await readWo(unit);
    const eventsAfter = await readAudit(wo(unit).workOrderId);
    const judgment = judgeNcrRace({
      family: peers[0].family,
      responses: responses.map((item) => ({ status: item.response.status, data: item.response.data, id: item.action.id })),
      eventsBefore, eventsAfter, ncrAfter, woStatus: woRow?.status ?? null, andonStatus: andon?.status ?? null,
      signoff: responses.some((item) => item.action.kind === 'race-pass' && item.response.status === 200) ? 'Passed' : snapshot(unit).signoff,
      dataCaptured: responses.some((item) => item.action.kind === 'race-data' && item.response.status === 200),
    });
    recordNcrOutcome(counters, { ...peers[0], kind: 'race-' + peers[0].family }, judgment);
    counters.executedActions += peers.length - 1;
    concurrency.push({
      family: peers[0].family, order: peers[0].order, unit,
      http: responses.map((item) => ({ id: item.action.id, status: item.response.status })),
      outcome: judgment.outcome, invariant: judgment.invariant,
    });
    if (judgment.finding) {
      findings.push({
        id: peers.map((action) => action.id).join('+'), severity: 'high', invariant: judgment.invariant,
        status: responses.map((item) => item.response.status),
      });
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

  notApplicable.push({
    id: 'export-andon-link',
    label: 'andon-link',
    reason: 'Traveler and full export NCR rows expose dispositionComment, not andonId or systemCancel. systemCancel stays on NCR_CLOSED.',
  });
  const verdict = ncrVerdict(counters, false);
  const { requiredBlocked, ...publicCounters } = counters;
  return {
    setupPass: true,
    ...verdict,
    ncrPlanHash: plan.ncrPlanHash,
    orderNo: plan.orderNo,
    unitCount: plan.unitCount,
    counters: { ...publicCounters, pass: verdict.pass },
    findings, contractDecisions, notApplicable, concurrency, blocked,
    setup: {
      orderNo: plan.orderNo,
      foreignOrderNo: plan.foreignOrderNo,
      masterItemNo: plan.masterItemNo,
      reasons: plan.reasons,
      secondaryDistinct: secondary !== envUserId,
    },
  };
}
