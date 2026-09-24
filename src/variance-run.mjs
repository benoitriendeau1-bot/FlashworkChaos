import { identifier, instructionBlocksBody, stepsAfterSeededOperation } from './engine.mjs';
import { findStep, resolveWorkOrderIds } from './wo-resolve.mjs';
import { bindVariancePlan, variancePlan } from './variance-plan.mjs';
import {
  contractDecisionText, judgeVarianceExport, judgeVarianceObservation, judgeVarianceRace, varianceEvents, varianceVerdict,
} from './variance-judge.mjs';

const MISSING_ID = '00000000-0000-4000-8000-000000000000';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function readWorkOrderVarianceId(data) {
  const row = data?.variance ?? data;
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const id = row.workOrderVarianceId ?? null;
  return UUID_RE.test(String(id)) ? id : null;
}

export function varianceResourcePath(id, suffix = '') {
  if (!UUID_RE.test(String(id ?? ''))) return null;
  const path = '/production-orders/variances/' + id + suffix;
  return path.includes('undefined') ? null : path;
}

function missingVarianceId() {
  return { status: 0, harness: true, data: { error: 'harness: workOrderVarianceId absent' } };
}

function listOf(data, key) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.[key])) return data[key];
  return [];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeEvents(rows) {
  return (Array.isArray(rows) ? rows : []).map((event) => {
    const payload = event?.payloadJson ?? event?.payload ?? null;
    const id = event?.proAuditEventId ?? event?.eventId ?? event?.id ?? null;
    if (!id) return null;
    return { eventId: id, eventType: event.eventType ?? null, payloadJson: payload };
  }).filter(Boolean);
}

function containsText(value, text) {
  return JSON.stringify(value ?? {}).includes(text);
}

function readOperationOrder(detail, operationNo) {
  let found = null;
  const visit = (value) => {
    if (!value || typeof value !== 'object' || found != null) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (String(value.operationNo) === String(operationNo) && value.operationOrder != null) found = value.operationOrder;
    else Object.values(value).forEach(visit);
  };
  visit(detail);
  return found;
}

function operationOrder(detail) {
  const operations = detail?.workOrder?.operations ?? detail?.operations ?? [];
  if (!Array.isArray(operations)) return [];
  return operations.map((operation) => String(operation.operationNo));
}

function addedStep(resolved) {
  const operation = resolved?.operations?.find((item) => item.operationNo === '30');
  return operation?.steps?.[0] ?? null;
}

function buildAddedOperation(ids, spec) {
  const text = 'Contrôle variance';
  return {
    logicalId: spec.logicalId,
    orderKey: spec.orderKey,
    operationNo: spec.operationNo,
    operationTitle: 'Variance',
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
        logicalId: spec.logicalId + '-part',
        partId: ids.partId,
        quantity: 1,
        unitOfMeasure: null,
        isMandatory: true,
        notes: null,
        traceabilityModeOverride: null,
        traceabilityOverrideReductionReason: null,
        traceabilityOverrideReducedBy: null,
        traceabilityOverrideReducedAt: null,
      }],
      tools: [{
        logicalId: spec.logicalId + '-tool',
        toolId: ids.toolId,
        capturePolicy: 'required',
        useQty: null,
        specText: 'Scanner ' + ids.tagCode + '.',
      }],
      signoffs: [{
        logicalId: spec.logicalId + '-sign',
        signOffRequirementId: ids.signOffRequirementId,
        signoffOrder: 1,
      }],
      dataPoints: [
        {
          logicalId: spec.logicalId + '-data',
          stableKey: spec.logicalId + '.note',
          dataDefinitionId: null,
          referenceCode: 'VAR-NOTE',
          label: text,
          dataOrder: 1,
          dataType: 'text',
          unit: null,
          isMandatory: true,
          nominalValue: null,
          minValue: null,
          maxValue: null,
          defaultValue: null,
          enumChoices: null,
          sampleEvery: 1,
        },
        {
          logicalId: spec.logicalId + '-enum',
          stableKey: spec.logicalId + '.enum',
          dataDefinitionId: null,
          referenceCode: 'VAR-ENUM',
          label: 'Décision',
          dataOrder: 2,
          dataType: 'enum',
          unit: null,
          isMandatory: false,
          nominalValue: null,
          minValue: null,
          maxValue: null,
          defaultValue: null,
          enumChoices: ['Accept', 'Rework'],
          sampleEvery: 1,
        },
      ],
      formulas: [],
      blocks: [{
        logicalId: spec.logicalId + '-block',
        blockOrder: 1,
        locationKey: 'top',
        blockType: 'INSTRUCTION',
        contentJson: {
          version: 4,
          rows: [{
            id: spec.logicalId + '-row',
            layout: '1',
            blocks: [{
              id: spec.logicalId + '-text',
              type: 'text',
              docJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
            }],
          }],
        },
        stdTextRevisionId: null,
      }],
    }],
  };
}

function withOperation(packageJson, operation) {
  return {
    schemaVersion: packageJson?.schemaVersion ?? 1,
    operations: [...(packageJson?.operations ?? []), operation],
  };
}

function orderKeyBetween(operations) {
  const keys = operations.map((operation) => Number(operation.orderKey) || 0).sort((left, right) => left - right);
  if (keys.length < 2) return (keys[0] ?? 0) + 500;
  const between = Math.round((keys[0] + keys[1]) / 2);
  return between === keys[0] ? keys[0] + 1 : between;
}

function duplicateOperation(packageJson) {
  const source = packageJson?.operations?.[0];
  if (!source) return packageJson;
  const copy = JSON.parse(JSON.stringify(source));
  copy.logicalId = String(copy.logicalId) + '-dup';
  copy.operationTitle = 'Doublon';
  for (const step of copy.steps ?? []) {
    step.logicalId = String(step.logicalId) + '-dup';
    for (const key of ['parts', 'tools', 'signoffs', 'dataPoints', 'formulas', 'blocks']) {
      for (const item of step[key] ?? []) item.logicalId = String(item.logicalId ?? key) + '-dup';
    }
  }
  return withOperation(packageJson, copy);
}

export async function runVarianceCapture(input) {
  const { setup, call, seed, runId, prefix, effectivityDate, envUserId } = input;
  const plan = bindVariancePlan(variancePlan(seed), runId, prefix);
  const observations = [];
  const races = [];
  const findings = [];
  const contractDecisions = [];
  const notApplicable = plan.actions.filter((action) => action.applicable === false).map((action) => ({
    id: action.id, label: action.label, reason: action.reason,
  }));
  const blocked = [];
  const variances = new Map();

  const blockedReport = (reason) => ({
    setupPass: false, capturePass: false, chaosPass: false, pass: false,
    variancePlanHash: plan.variancePlanHash, orderNo: plan.orderNo,
    counters: varianceVerdict(plan.actions, [], []),
    findings: [{ severity: 'high', invariant: reason }],
    contractDecisions, notApplicable, concurrency: races, blocked: [{ id: 'setup', reason }],
  });

  const known = ['SIG', 'SIGS', 'SIGL', 'SIGO', 'OBS', 'REQ', 'OPT', 'INF', 'NN', 'SE', 'LO', 'LC', 'AND', 'NCR'];
  if (known.some((suffix) => plan.partNumber.endsWith(suffix) || plan.toolNumber.endsWith(suffix))) {
    return blockedReport('variance catalog number collides with another slice');
  }

  const andonReason = await setup('create variance andon reason', 'POST', '/andon-reasons', {
    reasonName: plan.andonReason, description: 'Chaos variance', effect: 'none', promptsNcr: false, isActive: true,
  });
  const andonReasonId = andonReason.ok ? identifier(andonReason.data, ['andonReasonId']) : null;
  if (!andonReasonId) return blockedReport('variance andon reason was not created');

  const token = plan.runToken;
  const category = await setup('create variance sign-off category', 'POST', '/sign-off-categories', { name: 'VAR ' + token });
  const categoryId = category.ok ? identifier(category.data, ['signOffCategorieId']) : null;
  if (!categoryId) return blockedReport('variance sign-off category was not created');
  const requirement = await setup('create variance sign-off', 'POST', '/sign-off-requirements', {
    name: 'VAR operator ' + token, signOffCategorieId: categoryId, requiredPrivilege: 'signoff.operator',
    requiresUniqueSignerWithinStep: false, scope: 'step', level: 1,
  });
  const signOffRequirementId = requirement.ok ? identifier(requirement.data, ['signOffRequirementId']) : null;
  if (!signOffRequirementId) return blockedReport('variance sign-off requirement was not created');
  const partCategory = await setup('create variance part category', 'POST', '/part-categories', {
    categoryName: 'VAR' + token, description: 'Chaos variance ' + runId,
  });
  const partCategorieId = partCategory.ok ? identifier(partCategory.data, ['partCategorieId']) : null;
  if (!partCategorieId) return blockedReport('variance part category was not created');
  const part = await setup('create variance part', 'POST', '/parts', {
    partNumber: plan.partNumber, description: 'Pièce variance ' + token, traceabilityMode: 'None', partCategorieId,
  });
  const partId = part.ok ? identifier(part.data, ['partId']) : null;
  if (!partId) return blockedReport('variance part was not created');
  const tool = await setup('create variance tool', 'POST', '/tools', {
    toolNumber: plan.toolNumber, name: 'Outil variance ' + token, description: 'Outil variance',
    calibrationBasis: 'none', defaultCapturePolicy: 'required',
  });
  const toolId = tool.ok ? identifier(tool.data, ['toolId']) : null;
  if (!toolId) return blockedReport('variance tool was not created');
  const instance = await setup('create variance instance', 'POST', '/tool-instances', {
    toolId, assetTag: plan.tagCode, serialNo: plan.tagCode, status: 'active',
  });
  if (!instance.ok) return blockedReport('variance tool instance was not created');
  const ids = { partId, toolId, signOffRequirementId, tagCode: plan.tagCode };

  const masterItemNo = plan.masterItemNo;
  const root = '/master-items/' + encodeURIComponent(masterItemNo);
  const made = await setup('create variance master', 'POST', '/master-items', {
    masterItemNo, masterType: 'Prod', description: 'Chaos variance ' + runId, seedInitialStructure: false,
  });
  if (!made.ok) return blockedReport('variance master item was not created');
  for (const [operationNo, mustComplete, title] of [['10', true, 'Constater'], ['20', false, 'Contrôler']]) {
    const created = await setup('add variance operation', 'POST', root + '/operations', {
      operationNo, operationTitle: title, operationDescription: title, mustCompleteBeforeLater: mustComplete,
    });
    if (!created.ok) return blockedReport('variance operation was not created');
    const authored = stepsAfterSeededOperation(created.data, [{ stepNo: 1, stepTitle: title, stepDescription: title }]);
    if (!authored.seeded) return blockedReport('variance step was not seeded');
    if (!(await setup('name variance step', 'PATCH', root + '/steps/' + authored.seeded.masOpeStepId, authored.name)).ok) {
      return blockedReport('variance step was not named');
    }
    const stepId = authored.seeded.masOpeStepId;
    if (!(await setup('write variance instruction', 'PUT', '/mas-ope-step/' + stepId + '/blocks', instructionBlocksBody(title))).ok) {
      return blockedReport('variance instruction was not written');
    }
    if (!(await setup('add variance data', 'POST', root + '/data-points', {
      masOpeStepId: stepId, referenceCode: operationNo === '10' ? 'VAR-BASE' : 'VAR-OPT',
      label: title, dataType: 'text', isMandatory: operationNo === '10',
    })).ok) return blockedReport('variance data was not created');
    if (operationNo === '10') {
      const attachedPart = await setup('add variance part', 'POST', root + '/parts', { masOpeStepId: stepId, partId, quantityRequired: 1 });
      const attachedTool = await setup('add variance tool', 'POST', root + '/tools', {
        masOpeStepId: stepId, toolId, capturePolicy: 'required', useQty: null, specText: 'Scanner ' + plan.tagCode + '.',
      });
      if (!attachedPart.ok || !attachedTool.ok) return blockedReport('variance requirements were not attached');
    }
    if (!(await setup('add variance sign-off', 'POST', root + '/signoffs', { masOpeStepId: stepId, signOffRequirementId, level: 1 })).ok) {
      return blockedReport('variance sign-off was not attached');
    }
  }
  if (!(await setup('release variance master', 'PATCH', root, { status: 'Released' })).ok) {
    return blockedReport('variance master item was not released');
  }

  const orderNo = plan.orderNo;
  const orderRoot = '/production-orders/' + encodeURIComponent(orderNo);
  if (!(await setup('create variance PO', 'POST', '/production-orders', {
    source: 'master_item', orderNo, orderType: 'Prod', masterItemNo,
    effectivityDate, quantityPlanned: plan.unitCount, executionMode: 'sequential',
  })).ok) return blockedReport('variance production order was not created');
  if (!(await setup('release variance PO', 'POST', orderRoot + '/release', {})).ok) {
    return blockedReport('variance production order was not released');
  }
  const workOrders = [];
  for (let unit = 1; unit <= plan.unitCount; unit += 1) {
    const created = await setup('create variance WO', 'POST', orderRoot + '/units/' + unit + '/lines/1/work-orders', {});
    const workOrderId = created.ok ? identifier(created.data, ['workOrderId']) : null;
    if (!workOrderId) return blockedReport('variance work order ' + unit + ' was not created');
    const detail = await setup('read variance WO', 'GET', orderRoot + '/work-orders/' + workOrderId);
    const resolved = resolveWorkOrderIds(detail.data);
    if (!detail.ok || !resolved.ok) return blockedReport('variance work order ' + unit + ' could not be read');
    workOrders.push({ unit, workOrderId, resolved, detail: detail.data });
  }
  const otherRoot = '/production-orders/' + encodeURIComponent(plan.foreignOrderNo);
  if (!(await setup('create variance other PO', 'POST', '/production-orders', {
    source: 'master_item', orderNo: plan.foreignOrderNo, orderType: 'Prod', masterItemNo,
    effectivityDate, quantityPlanned: 1, executionMode: 'sequential',
  })).ok) return blockedReport('variance second production order was not created');
  if (!(await setup('release variance other PO', 'POST', otherRoot + '/release', {})).ok) {
    return blockedReport('variance second production order was not released');
  }
  const otherWo = await setup('create variance other WO', 'POST', otherRoot + '/units/1/lines/1/work-orders', {});
  const otherWorkOrderId = otherWo.ok ? identifier(otherWo.data, ['workOrderId']) : null;
  if (!otherWorkOrderId) return blockedReport('variance second work order could not be read');

  const users = await call('list variance users', 'GET', '/admin/users');
  const secondary = listOf(users.data, 'users').map((user) => user.userId).find((id) => id && id !== envUserId) ?? envUserId;

  function wo(unit) {
    return workOrders.find((item) => item.unit === unit);
  }
  function locate(unit, operationNo) {
    const current = wo(unit);
    if (!current) return null;
    return { current, step: findStep(current.resolved, operationNo, '1') };
  }
  function projectVariance(data) {
    const row = data?.variance ?? data;
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    return {
      varianceId: readWorkOrderVarianceId(row),
      varianceNo: row.varianceNo ?? null,
      status: row.status ?? null,
      revisionToken: row.revisionToken ?? null,
      packageJson: row.packageJson ?? null,
    };
  }
  function projectWorkOrder(data) {
    const row = data?.workOrder ?? data?.summary ?? data;
    return {
      status: row?.status ?? null,
      currentVarianceId: row?.currentVarianceId ?? null,
      draftVarianceId: row?.draftVarianceId ?? null,
    };
  }
  function remember(unit, data) {
    const variance = projectVariance(data);
    if (!variance?.varianceId) return;
    const previous = variances.get(unit) ?? {};
    variances.set(unit, {
      ...previous,
      ...variance,
      packageJson: variance.packageJson?.operations?.length ? variance.packageJson : previous.packageJson ?? null,
      revisionToken: variance.revisionToken ?? previous.revisionToken ?? null,
    });
  }
  function varianceIdentity(variance) {
    if (!variance) return null;
    return {
      status: variance.status ?? null,
      revisionToken: variance.revisionToken ?? null,
      operations: (variance.packageJson?.operations ?? []).map((operation) => ({
        logicalId: operation.logicalId ?? null,
        operationNo: operation.operationNo == null ? null : String(operation.operationNo),
        orderKey: operation.orderKey ?? null,
      })),
    };
  }
  function executionFingerprint(detail) {
    const resolved = resolveWorkOrderIds(detail);
    return {
      workOrder: projectWorkOrder(detail),
      operations: Array.isArray(detail?.operations) ? detail.operations.map((operation) => ({
        proOpeId: operation.proOpeId ?? null,
        operationNo: operation.operationNo == null ? null : String(operation.operationNo),
        operationOrder: operation.operationOrder ?? null,
      })) : null,
      execution: resolved.ok ? resolved.operations : null,
    };
  }
  async function readAudit(workOrderId, root = orderRoot) {
    const orderAudit = await call('read variance audit', 'GET', root + '/audit-events');
    const workAudit = workOrderId
      ? await call('read variance work audit', 'GET', root + '/work-orders/' + workOrderId + '/audit/events')
      : { data: {} };
    const merged = new Map();
    for (const event of [
      ...normalizeEvents(orderAudit.data?.auditEvents ?? orderAudit.data?.events),
      ...normalizeEvents(workAudit.data?.events ?? workAudit.data?.auditEvents),
    ]) merged.set(event.eventId, event);
    return [...merged.values()];
  }
  async function readWo(unit) {
    const current = wo(unit);
    if (!current) return null;
    const response = await call('reread variance WO', 'GET', orderRoot + '/work-orders/' + current.workOrderId);
    if (response.status < 200 || response.status >= 300) return null;
    current.detail = response.data;
    const resolved = resolveWorkOrderIds(response.data);
    if (resolved.ok) current.resolved = resolved;
    return response.data;
  }
  async function readVariance(unit) {
    const current = variances.get(unit);
    if (!current?.varianceId) return null;
    const response = await call('reread variance', 'GET', '/production-orders/variances/' + current.varianceId);
    if (response.status < 200 || response.status >= 300) return null;
    remember(unit, response.data);
    return projectVariance(response.data);
  }
  function captureBody(action) {
    const body = { ...(action.body ?? {}) };
    if (Object.prototype.hasOwnProperty.call(body, 'valueText')) {
      body.capturedValueText = body.valueText;
      delete body.valueText;
    }
    return body;
  }
  function packageFor(unit, action) {
    const current = variances.get(unit);
    const source = current?.packageJson;
    if (!source) return null;
    if (action.kind === 'save-same' || action.kind === 'save-stale') {
      return { schemaVersion: source.schemaVersion ?? 1, operations: source.operations };
    }
    if (action.kind === 'save-duplicate') return duplicateOperation(source);
    if (action.kind === 'save-insert') {
      return withOperation(source, buildAddedOperation(ids, {
        logicalId: 'var-op-15', orderKey: orderKeyBetween(source.operations), operationNo: '15',
      }));
    }
    if (action.kind === 'save-order') {
      return withOperation(source, buildAddedOperation(ids, {
        logicalId: 'var-op-' + action.operationNo,
        orderKey: action.orderKey,
        operationNo: action.operationNo,
      }));
    }
    return withOperation(source, buildAddedOperation(ids, {
      logicalId: 'var-op-30',
      orderKey: Math.max(0, ...source.operations.map((operation) => Number(operation.orderKey) || 0)) + 1000,
      operationNo: '30',
    }));
  }

  async function dispatch(action) {
    const unit = action.unit;
    const current = wo(unit);
    const actor = action.actor === 'secondary' ? { userId: secondary } : undefined;
    if (action.kind === 'create-unknown-wo') {
      return call(action.id, 'POST', orderRoot + '/work-orders/' + MISSING_ID + '/variances', action.body ?? {});
    }
    if (action.kind === 'create-foreign') {
      return call(action.id, 'POST', orderRoot + '/work-orders/' + otherWorkOrderId + '/variances', action.body ?? {});
    }
    if (action.kind === 'create-malformed') {
      return call(action.id, 'POST', orderRoot + '/work-orders/not-a-uuid/variances', action.body ?? {});
    }
    if (action.kind === 'delete') {
      return call(action.id, 'DELETE', orderRoot + '/work-orders/' + (current?.workOrderId ?? MISSING_ID) + '/variances');
    }
    if (action.kind === 'get-variance') {
      const path = varianceResourcePath(variances.get(unit)?.varianceId);
      return path ? call(action.id, 'GET', path) : missingVarianceId();
    }
    if (action.kind === 'read-master') return call(action.id, 'GET', root);
    if (action.kind === 'read-sibling') {
      return call(action.id, 'GET', orderRoot + '/work-orders/' + wo(action.unit).workOrderId);
    }
    if (action.kind === 'future-order') {
      const futureRoot = '/production-orders/' + encodeURIComponent(plan.futureOrderNo);
      const created = await call(action.id + ' po', 'POST', '/production-orders', {
        source: 'master_item', orderNo: plan.futureOrderNo, orderType: 'Prod', masterItemNo,
        effectivityDate, quantityPlanned: 1, executionMode: 'sequential',
      });
      if (created.status < 200 || created.status >= 300) return created;
      const released = await call(action.id + ' release', 'POST', futureRoot + '/release', {});
      if (released.status < 200 || released.status >= 300) return released;
      const madeWo = await call(action.id + ' wo', 'POST', futureRoot + '/units/1/lines/1/work-orders', {});
      const workOrderId = identifier(madeWo.data, ['workOrderId']);
      if (!workOrderId) return madeWo;
      return call(action.id, 'GET', futureRoot + '/work-orders/' + workOrderId);
    }
    if (action.kind === 'export') {
      const base = orderRoot + '/work-orders/' + current.workOrderId;
      const traveler = await call(action.id + ' traveler', 'GET', base + '/traveler-report');
      const full = await call(action.id + ' export', 'GET', base + '/full-export');
      const called = judgeVarianceExport({
        traveler: { called: true, status: traveler.status },
        full: { called: true, status: full.status },
      });
      const varianceId = variances.get(unit)?.varianceId;
      const ok = called.outcome === 'ready'
        && traveler.status === 200 && full.status === 200
        && containsText(traveler.data, '"operationNo":"30"')
        && containsText(full.data, '"operationNo":"30"')
        && varianceId && containsText(traveler.data, varianceId)
        && containsText(full.data, varianceId);
      return { status: ok ? 200 : (traveler.status || full.status || 0), data: { traveler, full, exportOk: ok } };
    }
    if (!current) return { status: 0, data: { error: 'work order was not created' } };
    if (action.kind === 'create' || action.kind === 'race-create') {
      return call(action.id, 'POST', orderRoot + '/work-orders/' + current.workOrderId + '/variances', action.body ?? {}, actor);
    }
    if (action.kind === 'create-ncr') {
      return call(action.id, 'POST', orderRoot + '/work-orders/' + current.workOrderId + '/ncrs', { summary: action.body?.summary });
    }
    if (action.kind === 'raise-andon') {
      return call(action.id, 'POST', orderRoot + '/work-orders/' + current.workOrderId + '/andons', {
        andonReasonId, description: action.body?.description,
      });
    }
    if (action.kind === 'hold-po') return call(action.id, 'PATCH', orderRoot + '/status', { status: 'OnHold' });
    if (action.kind === 'release-po') return call(action.id, 'PATCH', orderRoot + '/status', { status: 'InProgress' });
    if (action.kind === 'cancel-wo') {
      return call(action.id, 'POST', orderRoot + '/work-orders/' + current.workOrderId + '/cancel', action.body ?? {});
    }
    if (action.kind === 'complete') {
      return call(action.id, 'PATCH', orderRoot + '/work-orders/' + current.workOrderId + '/complete', {});
    }
    if (action.kind === 'cancel-variance') {
      const path = varianceResourcePath(variances.get(unit)?.varianceId, '/cancel');
      return path ? call(action.id, 'POST', path, action.body ?? {}) : missingVarianceId();
    }
    if (action.kind === 'release' || action.kind === 'race-release') {
      const path = varianceResourcePath(variances.get(unit)?.varianceId, '/release');
      return path ? call(action.id, 'POST', path, {}) : missingVarianceId();
    }
    if (String(action.kind).startsWith('save-')) {
      const path = varianceResourcePath(variances.get(unit)?.varianceId);
      if (!path) return missingVarianceId();
      const packageJson = packageFor(unit, action);
      const tokenValue = action.kind === 'save-stale' ? 'stale-token' : variances.get(unit)?.revisionToken;
      return call(action.id, 'PUT', path, { packageJson, revisionToken: tokenValue });
    }
    const operationNo = String(action.kind).includes('added') ? '30' : String(action.step ?? '10');
    const located = locate(unit, operationNo);
    if (!located?.step) return { status: 0, data: { error: 'step was not on the work order' } };
    const stepRoot = orderRoot + '/work-orders/' + current.workOrderId + '/steps/' + located.step.proOpeStepId;
    if (action.kind === 'capture-data' || action.kind === 'race-data' || action.kind === 'capture-added') {
      const point = action.kind === 'capture-added'
        ? located.step.dataPoints?.find((item) => item.referenceCode === 'VAR-NOTE')
        : located.step.dataPoints?.[0];
      if (!point?.proStepDataId) return { status: 0, data: { error: 'data point was not on the step' } };
      const body = action.kind === 'capture-added' ? { capturedValueText: 'Valeur variance' } : captureBody(action);
      return call(action.id, 'PATCH', stepRoot + '/data/' + point.proStepDataId, body);
    }
    if (action.kind === 'capture-part' || action.kind === 'capture-added-part') {
      const partStepId = located.step.parts?.[0]?.proStepPartId;
      if (!partStepId) return { status: 0, data: { error: 'part was not on the step' } };
      return call(action.id, 'PATCH', stepRoot + '/parts/' + partStepId, { quantityActual: 1 });
    }
    if (action.kind === 'capture-tool' || action.kind === 'capture-added-tool') {
      const toolStepId = located.step.tools?.[0]?.proStepToolId;
      if (!toolStepId) return { status: 0, data: { error: 'tool was not on the step' } };
      return call(action.id, 'PATCH', stepRoot + '/tools/' + toolStepId, { scanCode: plan.tagCode });
    }
    const signoffId = located.step.signoffs?.[0]?.proStepSignoffId;
    if (!signoffId) return { status: 0, data: { error: 'sign-off was not on the step' } };
    return call(action.id, 'PATCH', stepRoot + '/signoffs/' + signoffId + '/pass', {});
  }

  async function snapshotFor(action, response) {
    const unit = action.unit;
    const detail = action.kind === 'read-sibling' || action.kind === 'future-order' || action.kind === 'read-master'
      ? response.data
      : await readWo(unit);
    if (['create', 'save-append', 'save-same', 'save-insert', 'save-order', 'save-duplicate', 'release', 'race-create', 'race-release'].includes(action.kind)) {
      remember(unit, response.data);
      const parentId = response.data?.parentVarianceId ?? response.data?.variance?.parentVarianceId ?? null;
      if (UUID_RE.test(String(parentId ?? '')) && action.kind === 'create') {
        variances.set(unit, { ...(variances.get(unit) ?? {}), baselineId: parentId });
      }
    }
    const variance = await readVariance(unit);
    const workOrder = projectWorkOrder(detail);
    const varianceId = variance?.varianceId ?? variances.get(unit)?.varianceId ?? null;
    const baselineId = variances.get(unit)?.baselineId ?? null;
    const resolved = wo(unit)?.resolved;
    const step = addedStep(resolved);
    const enumPoint = step?.dataPoints?.find((item) => item.referenceCode === 'VAR-ENUM');
    const andonId = identifier(response.data, ['andonId']);
    let andon = null;
    if (andonId) {
      variances.set(unit, { ...(variances.get(unit) ?? {}), andonId });
    }
    const storedAndon = variances.get(unit)?.andonId;
    if (storedAndon && (action.andonStatus || action.kind === 'raise-andon')) {
      const loaded = await call('reread variance andon', 'GET', '/production-orders/andons/' + storedAndon);
      andon = loaded.data?.andon ?? loaded.data;
    }
    return {
      variance, varianceId, baselineId, workOrder, events: [], target: detail, andon,
      draftLinked: Boolean(varianceId) && workOrder.draftVarianceId === varianceId,
      baselineHeld: Boolean(baselineId) && workOrder.currentVarianceId === baselineId,
      enumChoices: enumPoint?.enumChoices ?? null,
      instruction: containsText(detail, 'Contrôle variance'),
      order: operationOrder(detail),
      insertedOrder: readOperationOrder(detail, action.operationNo),
      expectedOrder: (() => {
        const saved = (variance?.packageJson?.operations ?? []).find((operation) => String(operation.operationNo) === String(action.operationNo));
        return saved ? Math.round(Number(saved.orderKey) / 1000) : null;
      })(),
      exportOk: response.data?.exportOk === true,
    };
  }

  async function readForeign() {
    const response = await call('read foreign WO', 'GET', otherRoot + '/work-orders/' + otherWorkOrderId);
    return {
      audit: await readAudit(otherWorkOrderId, otherRoot),
      fingerprint: executionFingerprint(response.data),
    };
  }

  async function runOne(action) {
    const current = wo(action.unit);
    const before = await readAudit(current?.workOrderId);
    const beforeExecution = current?.detail ? executionFingerprint(current.detail) : null;
    const beforeVariance = varianceIdentity(variances.get(action.unit));
    const beforeForeign = action.kind === 'create-foreign' ? await readForeign() : null;
    const response = await dispatch(action);
    const snapshot = await snapshotFor(action, response);
    const localEvents = varianceEvents(before, await readAudit(current?.workOrderId));
    if (beforeForeign) {
      const afterForeign = await readForeign();
      snapshot.events = [...localEvents, ...varianceEvents(beforeForeign.audit, afterForeign.audit)];
      snapshot.foreignUnchanged = JSON.stringify(beforeForeign.fingerprint) === JSON.stringify(afterForeign.fingerprint);
      snapshot.noLeak = !containsText(response.data, otherWorkOrderId);
    } else {
      snapshot.events = localEvents;
    }
    if (['release-insert', 'order-negative-release', 'duplicate-release'].includes(action.label)) {
      snapshot.unchanged = JSON.stringify(beforeExecution) === JSON.stringify(executionFingerprint(wo(action.unit)?.detail))
        && JSON.stringify(beforeVariance) === JSON.stringify(varianceIdentity(snapshot.variance));
    }
    if (action.kind === 'export') snapshot.exportOk = response.data?.exportOk === true;
    const judgment = judgeVarianceObservation(action, response, snapshot);
    observations.push({ actionId: action.id, judgment });
    if (judgment.outcome === 'contract-decision') {
      contractDecisions.push({ id: action.id, label: action.label, text: contractDecisionText(action.contractDecision), failures: judgment.failures });
    }
    if (judgment.outcome !== 'harness' && (!['accepted', 'correctly-rejected', 'contract-decision', 'not-applicable'].includes(judgment.outcome) || (judgment.outcome === 'contract-decision' && judgment.failures?.length))) {
      findings.push({
        id: action.id, label: action.label, outcome: judgment.outcome, failures: judgment.failures,
        status: response.status, route: action.kind, body: action.body ?? null,
      });
    }
  }

  async function runRace(peers) {
    const unit = peers[0].unit;
    const before = await readAudit(wo(unit)?.workOrderId);
    const responses = await Promise.all(peers.map(async (action) => {
      if (action.delayMs) await sleep(action.delayMs);
      const response = await dispatch(action);
      return { action, response };
    }));
    for (const item of responses) {
      remember(unit, item.response.data);
      const parentId = item.response.data?.parentVarianceId ?? null;
      if (UUID_RE.test(String(parentId ?? ''))) {
        variances.set(unit, { ...(variances.get(unit) ?? {}), baselineId: parentId });
      }
    }
    await readWo(unit);
    const variance = await readVariance(unit);
    const detail = wo(unit)?.detail;
    const listed = await call('list variance drafts', 'GET', orderRoot + '/work-orders/' + wo(unit).workOrderId + '/variances');
    const rows = Array.isArray(listed.data) ? listed.data : (listed.data?.variances ?? []);
    const events = varianceEvents(before, await readAudit(wo(unit)?.workOrderId));
    const judgment = judgeVarianceRace(peers[0].family, responses.map((item) => ({
      status: item.response.status,
      peer: item.action.peer,
      code: item.response.data?.code ?? null,
    })), {
      events,
      variance,
      varianceId: variance?.varianceId ?? null,
      baselineId: variances.get(unit)?.baselineId ?? null,
      draftCount: rows.filter((row) => row.status === 'Draft').length,
      workOrder: projectWorkOrder(detail),
    });
    races.push({ family: peers[0].family, actions: peers.length, judgment, http: responses.map((item) => item.response.status) });
    if (judgment.outcome !== 'valid-linearization') {
      findings.push({
        id: peers.map((action) => action.id).join('+'), outcome: judgment.outcome, failures: judgment.failures,
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

  const counters = varianceVerdict(plan.actions, observations, races);
  return {
    setupPass: true,
    capturePass: counters.capturePass,
    chaosPass: counters.chaosPass,
    pass: counters.pass,
    variancePlanHash: plan.variancePlanHash,
    orderNo: plan.orderNo,
    unitCount: plan.unitCount,
    counters,
    findings, contractDecisions, notApplicable, concurrency: races, blocked,
    setup: {
      orderNo: plan.orderNo,
      foreignOrderNo: plan.foreignOrderNo,
      futureOrderNo: plan.futureOrderNo,
      masterItemNo: plan.masterItemNo,
      secondaryDistinct: secondary !== envUserId,
    },
  };
}
